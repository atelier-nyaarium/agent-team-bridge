import {
	type ConsolePushEntry,
	type CrossDomainPresenceSession,
	type FederatedOp,
	FederatedOpSchema,
	GatewayRelayFrameSchema,
} from "../../shared/federation-protocol.js";
import { fenced, MIGRATING } from "../../shared/migration-fence.js";
import { pickTiers } from "../../shared/notice.js";
import type { CrossDomainBinding } from "../../shared/pending-job-store.js";
import type { GatewayRelayReplyParams } from "../../shared/router-protocol.js";
import { Address, parseSessionName } from "../../shared/session-id.js";
import type { GatewaySpawnPoints, TeamInfo } from "../../shared/types.js";
import type { WakeResult } from "../wake.js";
import type { Sealer } from "./sealer.js";

export interface FederationRoutes {
	send: (req: Request, body: Record<string, unknown>, opts?: { trustedInbound?: boolean }) => Promise<Response>;
	respond: (req: Request, body: Record<string, unknown>, opts?: { trustedInbound?: boolean }) => Response;
	teams: () => Response;
	localSpawnPoints: () => GatewaySpawnPoints[];
	consolePush: (entry: ConsolePushEntry, dedupeKey: string) => { delivered: boolean };
	landCrossDomainPresence: (srcDomainId: string, sessions: CrossDomainPresenceSession[]) => void;
}

export interface RelayShareState {
	isSharedTo(sessionTarget: string, domainId: string): boolean;
	sharesFor(domainId: string): string[];
	touch(sessionTarget: string): void;
}

export interface GatewayRelayHandlerDeps {
	routes: FederationRoutes;
	tryWakeTeam: (team: string) => Promise<WakeResult>;
	localGatewayId: string;
	localDomainId: string;
	shareState?: RelayShareState;
	crossDomainBinding?: (sessionId: string) => CrossDomainBinding | undefined;
	serveBlobRange?: (blobId: string, offset: number, length: number) => { chunk?: string; eof: boolean };
}

export interface GatewayRelayPumpDeps {
	handleOp: (op: FederatedOp, srcGateway: string, srcDomainId: string | null) => Promise<unknown>;
	sealer: Sealer;
	sendReply: (reply: GatewayRelayReplyParams) => Promise<{ error?: string }>;
}

const FAKE_REQ = new Request("http://gateway/federation");

const XDOMAIN_TARGET_DENIED = "cross-Domain op denied";

export function createGatewayRelayHandler({
	routes,
	tryWakeTeam,
	localGatewayId,
	localDomainId,
	shareState,
	crossDomainBinding,
	serveBlobRange,
}: GatewayRelayHandlerDeps) {
	function localShareTarget(name: string): string {
		const { project, session } = parseSessionName(name);
		return Address.local(localDomainId, localGatewayId, project, session).canonical;
	}
	async function localKind(bareName: string): Promise<TeamInfo["kind"] | undefined> {
		const teams = (await routes.teams().json()) as TeamInfo[];
		return teams.find((t) => t.team === bareName)?.kind;
	}

	function verifiedSender(from: string, srcDomainId: string, srcGateway: string): string {
		const parts = from.split(".");
		if (parts.length === 4) {
			try {
				return Address.remote(srcDomainId, srcGateway, parts[2], parts[3]).canonical;
			} catch {
				// Invalid sender falls back.
			}
		}
		return `${srcDomainId}.${srcGateway}`;
	}

	/** Cross-Domain scope gate. */
	async function gateCrossDomainTarget(bareName: string, srcDomainId: string): Promise<void> {
		const kind = await localKind(bareName);
		const sessionTarget = localShareTarget(bareName);
		const shareable = kind === "devcontainer" || kind === "loose";
		if (!shareable || !shareState?.isSharedTo(sessionTarget, srcDomainId)) {
			throw new Error(XDOMAIN_TARGET_DENIED);
		}
		shareState.touch(sessionTarget);
	}

	/** Return routes match verified senders. */
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
		if (fenced()) return { ok: false, error: MIGRATING };
		switch (op.kind) {
			case "send": {
				const sender = srcDomainId !== null ? verifiedSender(op.from, srcDomainId, srcGateway) : op.from;
				if (srcDomainId !== null) {
					await gateCrossDomainTarget(op.to, srcDomainId);
					assertCrossDomainReturnRoute(op.returnRoute, srcGateway, srcDomainId);
				}
				const res = await routes.send(
					FAKE_REQ,
					{
						from: sender,
						to: op.to,
						body: op.body,
						files: op.files,
						channelOnly: true,
						sessionId: op.returnRoute.srcSession,
						returnRoute: op.returnRoute,
						...(srcDomainId !== null ? { dstDomainId: srcDomainId } : {}),
						...(op.displayLabel ? { displayLabel: op.displayLabel } : {}),
						...(op.disposition ? { disposition: op.disposition } : {}),
					},
					{ trustedInbound: true },
				);
				const json = (await res.json()) as { session_id?: string; status?: string; error?: string };
				if (!res.ok) throw new Error(json.error ?? `send from Gateway ${srcGateway} failed`);
				return { session_id: json.session_id ?? op.returnRoute.srcSession, status: json.status ?? "running" };
			}
			case "list_teams": {
				const teams = (await routes.teams().json()) as TeamInfo[];
				if (srcDomainId !== null) {
					const shared = new Set(shareState?.sharesFor(srcDomainId) ?? []);
					return {
						teams: teams.filter((t) => shared.has(localShareTarget(t.team))),
					};
				}
				return { teams, spawnPoints: routes.localSpawnPoints() };
			}
			case "wake": {
				if (srcDomainId !== null) await gateCrossDomainTarget(op.team, srcDomainId);
				const { ok } = await tryWakeTeam(op.team);
				return { ok };
			}
			case "blob_fetch": {
				if (!serveBlobRange) throw new Error("blob transfer unavailable on this Gateway");
				return serveBlobRange(op.blobId, op.offset, op.length);
			}
			case "response_push": {
				if (srcDomainId !== null) {
					// Cross-Domain replies require the recorded origin binding.
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
				const res = routes.respond(
					FAKE_REQ,
					{
						session_id: op.session_id,
						status: op.status,
						response: op.response,
						...pickTiers(op),
						replyAsJson: op.replyAsJson,
						question: op.question,
						reason: op.reason,
						files: op.files,
					},
					{ trustedInbound: true },
				);
				const json = (await res.json()) as { error?: string };
				if (!res.ok) throw new Error(json.error ?? "response_push delivery failed");
				return { ok: true };
			}
			case "console_push": {
				// Cross-Domain console pushes are always denied.
				if (srcDomainId !== null) {
					throw new Error("cross-Domain console_push denied");
				}
				return routes.consolePush(op.entry, op.dedupeKey);
			}
			case "presence_push": {
				if (srcDomainId === null) {
					throw new Error("presence_push requires a cross-Domain sender");
				}
				routes.landCrossDomainPresence(srcDomainId, op.sessions);
				return { ok: true };
			}
		}
	}

	return { handleOp };
}

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
			let op: FederatedOp;
			let srcDomainId: string | null;
			let body: unknown;
			try {
				const opened = sealer.openWithSource(frame.srcGateway, frame.payload.sealed, frame.srcDomain);
				body = opened.body;
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
				op = FederatedOpSchema.parse(body);
			} catch (err) {
				await sendReply({
					relayId: frame.relayId,
					ok: false,
					error: `op rejected: ${(err as Error).message}`,
				});
				return;
			}
			try {
				const result = await handleOp(op, frame.srcGateway, srcDomainId);
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
