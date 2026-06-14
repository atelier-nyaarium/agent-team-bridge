import type { HostRelayReplyParams } from "../../shared/evie-protocol.js";
import { type FederatedOp, FederatedOpSchema, HostRelayFrameSchema } from "../../shared/federation-protocol.js";
import type { TeamInfo } from "../../shared/types.js";
import type { Sealer } from "./sealer.js";

////////////////////////////////
//  Interfaces & Types

/** The subset of arbiter HTTP routes the host-relay handler reuses, exactly the
 * surface the phone handler uses - a federated op runs against the same local
 * routes a local sender would hit. */
export interface FederationRoutes {
	send: (req: Request, body: Record<string, unknown>) => Promise<Response>;
	respond: (req: Request, body: Record<string, unknown>) => Response;
	teams: () => Response;
}

export interface HostRelayHandlerDeps {
	routes: FederationRoutes;
	tryWakeTeam: (team: string) => Promise<boolean>;
}

export interface HostRelayPumpDeps {
	handleOp: (op: FederatedOp, srcHost: string) => Promise<unknown>;
	/** Opens the inbound sealed op and seals the result back to the origin Host. */
	sealer: Sealer;
	/** Sends a host_relay_reply tool call back to the Router (correlated by relayId). */
	sendReply: (reply: HostRelayReplyParams) => Promise<{ error?: string }>;
}

////////////////////////////////
//  Functions & Helpers

const FAKE_REQ = new Request("http://arbiter/federation");

/** Runs a federated op a peer Host asked this Host to perform, against the local
 * routes. The reply value becomes the host_relay_reply `result`, routed home by
 * the Router. */
export function createHostRelayHandler({ routes, tryWakeTeam }: HostRelayHandlerDeps) {
	async function handleOp(op: FederatedOp, srcHost: string): Promise<unknown> {
		switch (op.kind) {
			case "send": {
				// Land the cross-Host send on the local team, keyed by the origin's
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
				if (!res.ok) throw new Error(json.error ?? `send from Host ${srcHost} failed`);
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

/** Validates an inbound host_relay frame, runs its op, and ships the reply back
 * to the Router. Mirrors the phone relay pump: one parse, one error surface. */
export function createHostRelayPump({ handleOp, sealer, sendReply }: HostRelayPumpDeps) {
	return function pump(raw: unknown): void {
		void (async () => {
			const parsed = HostRelayFrameSchema.safeParse(raw);
			if (!parsed.success) {
				const relayId = (raw as { relayId?: unknown } | null)?.relayId;
				if (typeof relayId === "string" && relayId.length > 0) {
					await sendReply({
						relayId,
						ok: false,
						error: `invalid host_relay: ${parsed.error.issues[0]?.message ?? "malformed"}`,
					});
				} else {
					console.error(`[host-relay] dropping malformed frame with no relayId`);
				}
				return;
			}
			const frame = parsed.data;
			// Open the E2E seal (verifies the origin Host's signature against the
			// allowlist + decrypts) and parse the inner op. A non-admitted sender or a
			// tampered seal is rejected without dispatching.
			let op: FederatedOp;
			try {
				op = FederatedOpSchema.parse(sealer.open(frame.srcHost, frame.payload.sealed));
			} catch (err) {
				await sendReply({
					relayId: frame.relayId,
					ok: false,
					error: `unseal failed: ${(err as Error).message}`,
				});
				return;
			}
			try {
				const result = await handleOp(op, frame.srcHost);
				// Seal the result back to the origin Host (E2E both directions).
				await sendReply({ relayId: frame.relayId, ok: true, result: sealer.seal(frame.srcHost, result) });
			} catch (err) {
				await sendReply({ relayId: frame.relayId, ok: false, error: (err as Error).message });
			}
		})().catch((err: Error) => {
			console.error(`[host-relay] pump error: ${err.message}`);
		});
	};
}
