import type { SwitchRelayReplyParams } from "../../shared/evie-protocol.js";
import { type FederatedOp, FederatedOpSchema, SwitchRelayFrameSchema } from "../../shared/federation-protocol.js";
import type { TeamInfo } from "../../shared/types.js";
import type { Sealer } from "./sealer.js";

////////////////////////////////
//  Interfaces & Types

/** The subset of arbiter HTTP routes the switch-relay handler reuses, exactly the
 * surface the console handler uses - a federated op runs against the same local
 * routes a local sender would hit. */
export interface FederationRoutes {
	send: (req: Request, body: Record<string, unknown>) => Promise<Response>;
	respond: (req: Request, body: Record<string, unknown>) => Response;
	teams: () => Response;
}

export interface SwitchRelayHandlerDeps {
	routes: FederationRoutes;
	tryWakeTeam: (team: string) => Promise<boolean>;
}

export interface SwitchRelayPumpDeps {
	handleOp: (op: FederatedOp, srcSwitch: string) => Promise<unknown>;
	/** Opens the inbound sealed op and seals the result back to the origin Switch. */
	sealer: Sealer;
	/** Sends a switch_relay_reply tool call back to the Router (correlated by relayId). */
	sendReply: (reply: SwitchRelayReplyParams) => Promise<{ error?: string }>;
}

////////////////////////////////
//  Functions & Helpers

const FAKE_REQ = new Request("http://arbiter/federation");

/** Runs a federated op a peer Switch asked this Switch to perform, against the local
 * routes. The reply value becomes the switch_relay_reply `result`, routed home by
 * the Router. */
export function createSwitchRelayHandler({ routes, tryWakeTeam }: SwitchRelayHandlerDeps) {
	async function handleOp(op: FederatedOp, srcSwitch: string): Promise<unknown> {
		switch (op.kind) {
			case "send": {
				// Land the cross-Switch send on the local team, keyed by the origin's
				// session id, with the return-route pinned so respond forwards home.
				const res = await routes.send(FAKE_REQ, {
					from: op.from,
					to: op.to,
					type: op.request_type,
					effort: op.effort,
					body: op.body,
					files: op.files,
					channelOnly: true,
					sessionId: op.returnRoute.srcSession,
					returnRoute: op.returnRoute,
				});
				const json = (await res.json()) as { session_id?: string; status?: string; error?: string };
				if (!res.ok) throw new Error(json.error ?? `send from Switch ${srcSwitch} failed`);
				return { session_id: json.session_id ?? op.returnRoute.srcSession, status: json.status ?? "running" };
			}
			case "list_teams": {
				const teams = (await routes.teams().json()) as TeamInfo[];
				return { teams };
			}
			case "wake": {
				const ok = await tryWakeTeam(op.team);
				return { ok };
			}
			case "response_push": {
				// A reply pinned home: deliver it to the local origin job, which pushes
				// to the originating conversation (its returnRoute is null, so respond
				// does not re-forward).
				const res = routes.respond(FAKE_REQ, {
					session_id: op.session_id,
					status: op.status,
					response: op.response,
					replyAsJson: op.replyAsJson,
					question: op.question,
					reason: op.reason,
					files: op.files,
				});
				const json = (await res.json()) as { error?: string };
				if (!res.ok) throw new Error(json.error ?? "response_push delivery failed");
				return { ok: true };
			}
		}
	}

	return { handleOp };
}

/** Validates an inbound switch_relay frame, runs its op, and ships the reply back
 * to the Router. Mirrors the console relay pump: one parse, one error surface. */
export function createSwitchRelayPump({ handleOp, sealer, sendReply }: SwitchRelayPumpDeps) {
	return function pump(raw: unknown): void {
		void (async () => {
			const parsed = SwitchRelayFrameSchema.safeParse(raw);
			if (!parsed.success) {
				const relayId = (raw as { relayId?: unknown } | null)?.relayId;
				if (typeof relayId === "string" && relayId.length > 0) {
					await sendReply({
						relayId,
						ok: false,
						error: `invalid switch_relay: ${parsed.error.issues[0]?.message ?? "malformed"}`,
					});
				} else {
					console.error(`[switch-relay] dropping malformed frame with no relayId`);
				}
				return;
			}
			const frame = parsed.data;
			// Open the E2E seal (verifies the origin Switch's signature against the
			// allowlist + decrypts) and parse the inner op. A non-admitted sender or a
			// tampered seal is rejected without dispatching.
			let op: FederatedOp;
			try {
				op = FederatedOpSchema.parse(sealer.open(frame.srcSwitch, frame.payload.sealed));
			} catch (err) {
				await sendReply({
					relayId: frame.relayId,
					ok: false,
					error: `unseal failed: ${(err as Error).message}`,
				});
				return;
			}
			try {
				const result = await handleOp(op, frame.srcSwitch);
				// Seal the result back to the origin Switch (E2E both directions).
				await sendReply({ relayId: frame.relayId, ok: true, result: sealer.seal(frame.srcSwitch, result) });
			} catch (err) {
				await sendReply({ relayId: frame.relayId, ok: false, error: (err as Error).message });
			}
		})().catch((err: Error) => {
			console.error(`[switch-relay] pump error: ${err.message}`);
		});
	};
}
