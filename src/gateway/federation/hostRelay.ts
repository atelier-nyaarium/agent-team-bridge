import type { GatewayRelayReplyParams } from "../../shared/evie-protocol.js";
import { type FederatedOp, FederatedOpSchema, GatewayRelayFrameSchema } from "../../shared/federation-protocol.js";
import type { CrossDomainBinding } from "../../shared/pending-job-store.js";
import { TeamAddress } from "../../shared/session-id.js";
import type { TeamInfo } from "../../shared/types.js";
import type { Sealer } from "./sealer.js";

////////////////////////////////
//  Interfaces & Types

/** The subset of gateway HTTP routes the gateway-relay handler reuses, exactly the
 * surface the console handler uses - a federated op runs against the same local
 * routes a local sender would hit. */
export interface FederationRoutes {
	send: (req: Request, body: Record<string, unknown>) => Promise<Response>;
	respond: (req: Request, body: Record<string, unknown>) => Response;
	teams: () => Response;
}

/** The subset of the per-session share state the relay handler reads to enforce
 * destination-side scoping. A narrow seam so the handler stays mockable. `sessionTarget`
 * is the canonical `gateway/name` of a LOCAL session; `domainId` is the calling friend
 * Domain. `touch` keeps a live cross-Domain share from auto-forgetting. */
export interface RelayShareState {
	isSharedTo(sessionTarget: string, domainId: string): boolean;
	sharesFor(domainId: string): string[];
	touch(sessionTarget: string): void;
}

export interface GatewayRelayHandlerDeps {
	routes: FederationRoutes;
	tryWakeTeam: (team: string) => Promise<boolean>;
	/** This Gateway's id, used to compose a bare federated `op.to` into the canonical
	 * `gateway/name` share key (and to parse the local session out of a response_push id). */
	localGatewayId: string;
	/** The per-session share set, read to gate cross-Domain ops to shared sessions and to
	 * filter a cross-Domain caller's list_teams. Absent when federation sharing is not wired
	 * (a same-Domain relay never consults it, so it stays optional). */
	shareState?: RelayShareState;
	/** The cross-Domain binding of a pending job by id (the PendingJobStore's lookup), or
	 * undefined if no such job. Both cross-Domain reply + collision gates compare the VERIFIED
	 * sender against the binding the local Gateway recorded when IT created the job, never
	 * against the bare gateway id on the friend-controlled wire (it is not unique across
	 * Domains). Absent when federation is not wired (a same-Domain relay never consults it). */
	crossDomainBinding?: (sessionId: string) => CrossDomainBinding | undefined;
}

export interface GatewayRelayPumpDeps {
	/** Runs a peer's op against the local routes. `srcDomainId` is non-null ONLY for a
	 * verified cross-Domain peer (the sealer reports it from the resolved+cross-checked
	 * peer), which the destination gate keys on. */
	handleOp: (op: FederatedOp, srcGateway: string, srcDomainId: string | null) => Promise<unknown>;
	/** Opens the inbound sealed op and seals the result back to the origin Gateway. */
	sealer: Sealer;
	/** Sends a gateway_relay_reply tool call back to the Router (correlated by relayId). */
	sendReply: (reply: GatewayRelayReplyParams) => Promise<{ error?: string }>;
}

////////////////////////////////
//  Functions & Helpers

const FAKE_REQ = new Request("http://gateway/federation");

/** The single denial for any cross-Domain op that is not permitted (unknown session,
 * non-shareable kind, or not shared to the caller's Domain). One constant, so the two
 * cases are byte-identical and a friend cannot probe session existence / kind. */
const XDOMAIN_TARGET_DENIED = "cross-Domain op denied";

/** Runs a federated op a peer Gateway asked this Gateway to perform, against the local
 * routes. The reply value becomes the gateway_relay_reply `result`, routed back to the origin by
 * the Router. */
export function createGatewayRelayHandler({
	routes,
	tryWakeTeam,
	localGatewayId,
	shareState,
	crossDomainBinding,
}: GatewayRelayHandlerDeps) {
	/** The kind of a LOCAL session by its bare name, from the same classification teams()
	 * applies (devcontainer/loose/gateway/console). Undefined for an unknown name. */
	async function localKind(bareName: string): Promise<TeamInfo["kind"] | undefined> {
		const teams = (await routes.teams().json()) as TeamInfo[];
		return teams.find((t) => t.team === bareName)?.kind;
	}

	/** The destination-side scope gate: enforced INSIDE the relay handler (never in
	 * discovery, since a trusted friend can craft op.to). A cross-Domain op may only reach
	 * a session that is (a) of kind devcontainer or loose - the host-agent "gateway", the
	 * cli "host", and console kinds are hard-denied (agents-only) - and (b) shared to the
	 * calling friend Domain. A same-Domain relay (srcDomainId null) is unchanged. On a
	 * permitted delivery the share is touched so a live cross-Domain thread does not
	 * auto-forget. Every denial throws ONE byte-identical, name-free / kind-free / Domain-free
	 * error: distinct messages would be an existence oracle, letting a friend probe which
	 * session names exist or what kind they are (defeating the shared-only list_teams filter). */
	async function gateCrossDomainTarget(bareName: string, srcDomainId: string): Promise<void> {
		const kind = await localKind(bareName);
		const sessionTarget = TeamAddress.local(localGatewayId, bareName).canonical;
		const shareable = kind === "devcontainer" || kind === "loose";
		if (!shareable || !shareState?.isSharedTo(sessionTarget, srcDomainId)) {
			throw new Error(XDOMAIN_TARGET_DENIED);
		}
		shareState.touch(sessionTarget);
	}

	/** Guard a cross-Domain inbound send's attacker-controlled return-route. The friend crafts
	 * the whole FederatedOp, so without this it could (a) point srcGateway at a THIRD friend so
	 * the shared agent's reply is sealed + relayed to that third friend (exfil), or (b) point
	 * srcSession at an EXISTING job's key so create() overwrites that job's return-route,
	 * hijacking an unrelated thread's reply. Both are bound to the CRYPTOGRAPHICALLY-VERIFIED
	 * sender: (a) the return-route's origin Gateway must BE the verified sender; (b) any
	 * pre-existing job at that session key must belong to the SAME verified `(Domain, gateway)`
	 * origin, else refuse (a local job's binding is null, a different friend's differs - both
	 * are denied). The bare gateway id is compared only AFTER the Domain matches, since it is
	 * not unique across Domains. */
	function assertCrossDomainReturnRoute(
		returnRoute: { srcGateway: string; srcSession: string },
		srcGateway: string,
		srcDomainId: string,
	): void {
		if (returnRoute.srcGateway !== srcGateway) {
			throw new Error(`cross-Domain send rejected: return-route does not point back to the sending Gateway`);
		}
		const existing = crossDomainBinding?.(returnRoute.srcSession);
		if (existing && (existing.dstDomainId !== srcDomainId || existing.returnGateway !== srcGateway)) {
			throw new Error(`cross-Domain send rejected: session collides with an unrelated job`);
		}
	}

	async function handleOp(op: FederatedOp, srcGateway: string, srcDomainId: string | null): Promise<unknown> {
		switch (op.kind) {
			case "send": {
				// A cross-Domain send must pass the destination scope gate before it can land.
				if (srcDomainId !== null) {
					await gateCrossDomainTarget(op.to, srcDomainId);
					assertCrossDomainReturnRoute(op.returnRoute, srcGateway, srcDomainId);
				}
				// Land the cross-Gateway send on the local team, keyed by the origin's
				// session id, with the return-route pinned so respond forwards it back to the origin. For a
				// cross-Domain send, stamp the VERIFIED origin Domain on the destination job so
				// the reply + any colliding re-send are bound to the friend that originated it.
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
					...(srcDomainId !== null ? { dstDomainId: srcDomainId } : {}),
				});
				const json = (await res.json()) as { session_id?: string; status?: string; error?: string };
				if (!res.ok) throw new Error(json.error ?? `send from Gateway ${srcGateway} failed`);
				return { session_id: json.session_id ?? op.returnRoute.srcSession, status: json.status ?? "running" };
			}
			case "list_teams": {
				const teams = (await routes.teams().json()) as TeamInfo[];
				// A cross-Domain caller sees ONLY the sessions shared to its Domain (never the
				// full session list - that would leak every name). A same-Domain caller gets
				// the full list (today's behavior). The share keys are canonical gateway/name,
				// so compare against each team's canonical target.
				if (srcDomainId !== null) {
					const shared = new Set(shareState?.sharesFor(srcDomainId) ?? []);
					return {
						teams: teams.filter((t) =>
							shared.has(TeamAddress.local(t.gatewayId ?? localGatewayId, t.team).canonical),
						),
					};
				}
				return { teams };
			}
			case "wake": {
				// Waking is a side effect on a session, so a cross-Domain wake is gated the
				// same as a send (only a shared devcontainer/loose session may be woken).
				if (srcDomainId !== null) await gateCrossDomainTarget(op.team, srcDomainId);
				const ok = await tryWakeTeam(op.team);
				return { ok };
			}
			case "response_push": {
				// A reply pinned to the origin: deliver it to the local origin job, which pushes
				// to the originating conversation (its returnRoute is null, so respond
				// does not re-forward). A cross-Domain response_push arrives at the ORIGIN
				// Gateway, so its session_id points at the REMOTE destination
				// (`conv:<conv>:<friendGateway>/<name>`), which is NOT a local team - the
				// local-kind check does not apply. Gate instead on the origin anchor's recorded
				// binding: the reply's VERIFIED Domain must equal the Domain the send was routed
				// to, and the verified sender must equal the destination gateway in the job's own
				// (origin-set, trusted) key. A friend who merely shares or matches a bare gateway
				// id therefore cannot forge a reply into another friend's job; a local-origin job
				// (binding null) hard-denies ANY cross-Domain reply.
				if (srcDomainId !== null) {
					const binding = crossDomainBinding?.(op.session_id);
					if (
						!binding ||
						binding.dstDomainId === null ||
						binding.dstDomainId !== srcDomainId ||
						binding.keyGateway !== srcGateway
					) {
						throw new Error(`cross-Domain response_push to "${op.session_id}" denied`);
					}
				}
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

/** Validates an inbound gateway_relay frame, runs its op, and ships the reply back
 * to the Router. Mirrors the console relay pump: one parse, one error surface. */
export function createGatewayRelayPump({ handleOp, sealer, sendReply }: GatewayRelayPumpDeps) {
	return function pump(raw: unknown): void {
		void (async () => {
			const parsed = GatewayRelayFrameSchema.safeParse(raw);
			if (!parsed.success) {
				const relayId = (raw as { relayId?: unknown } | null)?.relayId;
				if (typeof relayId === "string" && relayId.length > 0) {
					await sendReply({
						relayId,
						ok: false,
						error: `invalid gateway_relay: ${parsed.error.issues[0]?.message ?? "malformed"}`,
					});
				} else {
					console.error(`[gateway-relay] dropping malformed frame with no relayId`);
				}
				return;
			}
			const frame = parsed.data;
			// Open the E2E seal (verifies the origin Gateway's signature against the
			// allowlist + decrypts) and parse the inner op. A non-admitted sender or a
			// tampered seal is rejected without dispatching. openWithSource reports whether
			// the verified sender was a cross-Domain peer (and which Domain), so the handler
			// can scope a cross-Domain op without trusting the cleartext frame.
			let op: FederatedOp;
			let srcDomainId: string | null;
			try {
				const opened = sealer.openWithSource(frame.srcGateway, frame.payload.sealed, frame.srcDomain);
				op = FederatedOpSchema.parse(opened.body);
				srcDomainId = opened.srcDomainId;
			} catch (err) {
				await sendReply({
					relayId: frame.relayId,
					ok: false,
					error: `unseal failed: ${(err as Error).message}`,
				});
				return;
			}
			try {
				const result = await handleOp(op, frame.srcGateway, srcDomainId);
				// Seal the result back to the origin Gateway (E2E both directions). A
				// cross-Domain origin is sealed v2 by the full (domainId, gatewayId) pair (a
				// bare string would only resolve a local peer); a same-Domain origin stays the
				// bare-string v1 path.
				const replyTarget =
					srcDomainId !== null ? { domainId: srcDomainId, gatewayId: frame.srcGateway } : frame.srcGateway;
				await sendReply({ relayId: frame.relayId, ok: true, result: sealer.seal(replyTarget, result) });
			} catch (err) {
				await sendReply({ relayId: frame.relayId, ok: false, error: (err as Error).message });
			}
		})().catch((err: Error) => {
			console.error(`[gateway-relay] pump error: ${err.message}`);
		});
	};
}
