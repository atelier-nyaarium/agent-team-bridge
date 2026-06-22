import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import type { SealedEnvelope } from "../shared/crypto.js";
import { type FederatedOp, ReturnRouteSchema } from "../shared/federation-protocol.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import { ChannelFilesSchema } from "../shared/schemas.js";
import { NoticeId, SessionId, TeamAddress } from "../shared/session-id.js";
import type {
	ChannelFile,
	ConnectionMode,
	GatewayConfig,
	ResponsePayload,
	ResponsePushPayload,
	TeamInfo,
} from "../shared/types.js";
import {
	type ConversationRegistry,
	getAllActiveRealWs,
	getAllActiveWs,
	type TeamRegistry,
	type WsData,
} from "./websocket.js";

////////////////////////////////
//  Interfaces & Types

export interface RoutesDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: PendingJobStore<ResponsePayload>;
	tryWakeTeam: (team: string) => Promise<boolean>;
	offlineCatalog: Map<string, string>;
	// Durable team -> projectPath map (never cleared, unlike offlineCatalog which
	// empties when the host daemon disconnects). Membership in either marks a
	// team as devcontainer-backed.
	knownTeamPaths: Map<string, string>;
	// Console mailboxes, for broadcast notices (notify_human). Optional so test
	// harnesses without a console bridge need not supply one.
	mailboxStore?: import("../shared/device-mailbox.js").DeviceMailboxStore;
	config: GatewayConfig;
	evieClient?: import("./evie/evieClient.js").EvieClient | null;
	// E2E seal/open for cross-Gateway frames; absent when federation crypto is off.
	sealer?: import("./federation/sealer.js").Sealer | null;
	// The disjoint cross-Domain peer set. A cross-Domain send resolves its target's Domain
	// here (the SealTarget is keyed by the full (domainId, gatewayId) pair, never the bare
	// id), and discovery fans a list_teams to each linked peer. Absent when federation is off.
	crossDomainPeers?: import("./federation/crossDomainPeers.js").CrossDomainPeers | null;
	// Whether a gateway id resolves to a HOME (single-owner allowlist) peer. Mirrors the
	// sealer's home-first resolution on the SEND side, so a send to your own home Gateway
	// whose id collides with a friend's gateway id is sealed v1 to home (the bare-string
	// shorthand) rather than hijacked to the friend. Absent when federation crypto is off.
	resolvesHomeGateway?: ((gatewayId: string) => boolean) | null;
	// Refresh the share lastSeenAt for a live local session (its canonical gateway/name),
	// called from teams() per online team so a session's presence keeps its shares from
	// auto-forgetting. Absent when federation sharing is not wired.
	touchShares?: ((sessionTarget: string) => void) | null;
	// Whether a local session (canonical gateway/name) is still shared to a friend Domain,
	// re-read on the destination cross-Domain reply forward: an already-accepted send whose
	// session was un-shared has its in-flight reply DROPPED here rather than relayed home. The
	// share state is the single source both the inbound gate and this reply gate read, so an
	// un-share bites without evie. Absent when federation sharing is not wired (no recheck).
	isSharedToForReply?: ((sessionTarget: string, domainId: string) => boolean) | null;
	resolveHandshake?: (sessionId: string, replyAsJson?: Record<string, unknown>, response?: string) => boolean;
}

const SendRequestSchema = z.object({
	from: z.string(),
	fromConversationId: z.string().optional(),
	to: z.string(),
	// The Domain id of a cross-Domain target (a session from a linked friend Domain). A
	// gateway id is unique only within a Domain, so when this is set the seal target is
	// resolved by the full (domainId, gatewayId) pair; absent keeps the home/cross-Gateway
	// (bare gateway id) resolution. Console-supplied from the selected session's Domain.
	targetDomainId: z.string().optional(),
	type: z.string().optional(),
	effort: z.string().optional(),
	body: z.string().optional(),
	session_id: z.string().optional(),
	debug: z.boolean().optional(),
	replyJsonSchema: z.string().optional(),
	files: ChannelFilesSchema.optional(),
	// Console-originated sends: reject CLI-mode targets instead of entering the
	// CLI branch, which mints a random session id the console can never thread.
	channelOnly: z.boolean().optional(),
	// Cross-Gateway INBOUND send (the gateway-relay handler): use this exact session id
	// as the channel job key (the origin owns it) and pin the reply via returnRoute
	// instead of composing a local key from fromConversationId.
	sessionId: z.string().optional(),
	returnRoute: ReturnRouteSchema.optional(),
	// The verified origin Domain of a cross-Domain inbound send, set ONLY by the gateway-relay
	// handler (never client-supplied over /send): recorded on the destination job so a reply
	// and any colliding re-send are bound to the friend Domain that actually originated it.
	dstDomainId: z.string().optional(),
});

const RespondBodySchema = z.object({
	session_id: z.string(),
	status: z.string().optional(),
	response: z.string().optional(),
	replyAsJson: z.record(z.string(), z.unknown()).optional(),
	question: z.string().optional(),
	reason: z.string().optional(),
	estimated_minutes: z.number().optional(),
	what_to_decide: z.string().optional(),
	message: z.string().optional(),
	files: ChannelFilesSchema.optional(),
});

// Raw-bytes backstop on attachment payloads at the trust boundary. Shape
// validation does not bound memory, so sum the decoded sizes cheaply (base64 is
// ~4/3 of the bytes) before anything is stored or pushed.
const MAX_RESPONSE_FILE_BYTES = 10_000_000;

function fileBytes(files: ChannelFile[]): number {
	let n = 0;
	for (const f of files) n += f.base64 ? Math.floor((f.base64.length * 3) / 4) : f.size;
	return n;
}

/** Drop base64 so a persistent store entry never retains the bytes; the live
 * push and the mailbox carry the payload, the store keeps only metadata. */
function stripFileBytes(files: ChannelFile[]): ChannelFile[] {
	return files.map(({ base64: _omit, ...meta }) => meta);
}

const PollRequestSchema = z.object({
	session_id: z.string(),
});

const EvieToolCallSchema = z.object({
	action: z.string(),
	params: z.record(z.string(), z.unknown()),
});

// title, summary, and full are REQUIRED: a notice must always carry a headline,
// an addressable short tier, and a real body (no ghost pings). The object stays
// NON-strict so a stray `tiny` from a not-yet-updated caller is silently stripped.
const HumanNotifySchema = z.object({
	from: z.string().min(1).max(128),
	title: z.string().min(1).max(200),
	summary: z.string().min(1),
	full: z.string().min(1),
	files: ChannelFilesSchema.optional(),
});

////////////////////////////////
//  Functions & Helpers

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Get the first active WebSocket for a team (any sub-session). */
function getFirstWs(subs: Map<string, ServerWebSocket<WsData>>): ServerWebSocket<WsData> | undefined {
	for (const [, ws] of subs) {
		if (ws.readyState === 1) return ws;
	}
	return undefined;
}

/** Get the mode of a team, preferring real sockets over virtual console peers
 * (which are always channel mode and could otherwise misroute a CLI team). */
function getTeamMode(subs: Map<string, ServerWebSocket<WsData>>): ConnectionMode {
	let virtualMode: ConnectionMode | null = null;
	for (const [, ws] of subs) {
		if (!ws.data.virtual) return ws.data.mode;
		virtualMode = virtualMode ?? ws.data.mode;
	}
	return virtualMode ?? "cli";
}

export function createRoutes({
	registry,
	conversationRegistry,
	store,
	tryWakeTeam,
	offlineCatalog,
	knownTeamPaths,
	mailboxStore,
	config,
	evieClient,
	sealer,
	crossDomainPeers,
	resolvesHomeGateway,
	touchShares,
	isSharedToForReply,
	resolveHandshake,
}: RoutesDeps) {
	const { LOG_PATH, localGatewayId, localDomainId } = config;

	/** Resolve a target Gateway id to a SealTarget, HOME-FIRST (mirroring the sealer's own
	 * resolution order). A gateway id the home single-owner allowlist resolves is the
	 * bare-string shorthand and seals v1 - checked BEFORE the cross-Domain scan, so a send to
	 * your OWN home Gateway whose id collides with a friend's gateway id is never hijacked to
	 * the friend. Only a gateway id NOT in the home Domain is matched against the disjoint
	 * cross-Domain peer set: a single peer resolves to an explicit `(domainId, gatewayId)`
	 * SealTarget (v2, the Addressing decision's separate domainId field, never folded into the
	 * id string); a gateway id ambiguous across two friend Domains throws rather than guess. */
	function sealTargetFor(targetGateway: string, targetDomain?: string): import("./federation/sealer.js").SealTarget {
		// Home first: a gateway the home allowlist admits is the bare-string v1 shorthand, so a
		// home/friend gateway-id collision can never route a home send to the friend. A caller
		// that named an explicit cross-Domain target still falls to the cross-Domain resolution
		// below (a friend gateway is never in the home allowlist), so the home check is safe.
		if (resolvesHomeGateway?.(targetGateway)) return targetGateway;
		// An explicit (domainId, gatewayId) from the caller resolves the peer unambiguously,
		// closing the same-id-two-Domains case the bare scan refuses: two linked friends running
		// an identically-named gateway are told apart by the Domain the console selected.
		if (targetDomain) {
			const peer = crossDomainPeers?.resolveByGateway(targetDomain, targetGateway);
			if (peer) return { domainId: targetDomain, gatewayId: targetGateway };
			// The named Domain is not a linked peer for this gateway id: fall through to the bare
			// resolution so the error surfaces as "not admitted" rather than silently misrouting.
		}
		const peers = crossDomainPeers?.all().filter((p) => p.friendGatewayId === targetGateway) ?? [];
		if (peers.length === 1) return { domainId: peers[0].friendDomainId, gatewayId: targetGateway };
		if (peers.length > 1) {
			throw new Error(`Gateway "${targetGateway}" is ambiguous across linked Domains; cannot route`);
		}
		// Neither a known home gateway nor a cross-Domain peer: fall back to the bare string,
		// which the sealer resolves against the home allowlist (and emits v1) or rejects as
		// "not admitted". This preserves the prior behavior when no home predicate is wired.
		return targetGateway;
	}

	/** The resolved target Domain id for a cross-Gateway send, or null for a home /
	 * same-Domain (bare-string) target. Recorded on the origin anchor so the reply gate can
	 * require a response_push's verified Domain to match the Domain the send was routed to. A
	 * resolution error (an ambiguous gateway id) surfaces on the relay path first, so this
	 * just falls back to null. */
	function targetDomainId(targetGateway: string, targetDomain?: string): string | null {
		try {
			const target = sealTargetFor(targetGateway, targetDomain);
			return typeof target === "string" ? null : target.domainId;
		} catch {
			return null;
		}
	}

	/** Resolve a wire target (bare or host-qualified) to a local registry name.
	 * A bare name or one qualified with this Gateway resolves locally; a name
	 * qualified with a DIFFERENT Gateway has no local route yet (federation routing
	 * lands in a later phase), so it returns null. `qualified` is the canonical
	 * `localGatewayId/name` form used as the channel session-id target. */
	function resolveLocalTarget(to: string): { name: string; qualified: string } | null {
		const addr = TeamAddress.parse(to, localGatewayId);
		if (addr.gatewayId !== localGatewayId) return null;
		return { name: addr.name, qualified: addr.canonical };
	}

	/** Forward a federated op to another Gateway through the Router and unwrap the
	 * reply. evie holds the call until the destination Gateway answers (or times
	 * out), so a resolved result means the destination handled the op. */
	async function relayToGateway(
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
	): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		if (!evieClient?.isConnected())
			return { ok: false, error: `Router unavailable; cannot reach Gateway "${dstGateway}"` };
		if (!sealer) return { ok: false, error: `federation crypto is not configured` };
		// Resolve the target to a SealTarget once: a home peer is the bare string (v1); a
		// cross-Domain peer becomes an explicit (domainId, gatewayId) target (v2). An explicit
		// dstDomain disambiguates a gateway id shared across two linked Domains. The destination's
		// Domain (if any) also lets us open its v2 reply by the full pair.
		let target: import("./federation/sealer.js").SealTarget;
		let sealed: SealedEnvelope;
		try {
			target = sealTargetFor(dstGateway, dstDomain);
			sealed = sealer.seal(target, op);
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
		// The Domain the target actually resolved to (authoritative over the caller's hint),
		// used to open the destination's v2 reply by the full (domainId, gatewayId) pair.
		const resolvedDstDomain = typeof target === "string" ? undefined : target.domainId;
		const relayId = crypto.randomUUID();
		const call = await evieClient.callTool("gateway_relay", {
			relayId,
			srcGateway: localGatewayId,
			dstGateway,
			srcDomain: localDomainId,
			payload: { sealed },
		});
		if (call.error) return { ok: false, error: call.error };
		const reply = call.result as { ok?: boolean; result?: unknown; error?: string } | undefined;
		if (!reply || reply.ok === false) return { ok: false, error: reply?.error ?? "cross-Gateway relay failed" };
		// The reply result is sealed by the destination Gateway back to us; open it. A
		// cross-Domain reply is v2, so pass the destination's Domain to resolve the peer by
		// the full pair (a bare-id scan would be ambiguous if two friends share an id).
		try {
			return { ok: true, result: sealer.open(dstGateway, reply.result as SealedEnvelope, resolvedDstDomain) };
		} catch (err) {
			return { ok: false, error: `bad sealed reply from "${dstGateway}": ${(err as Error).message}` };
		}
	}

	/** Relay a cross-Gateway op in the background, retrying on transient failure (evie
	 * reconnecting, the origin Gateway restarting) with exponential backoff. The reply
	 * it carries is already durable in the local anchor (poll-recoverable), so a
	 * dropped first attempt no longer strands the origin's request the way the old
	 * fire-and-forget did. */
	function relayWithRetry(dstGateway: string, op: FederatedOp, label: string): void {
		const maxAttempts = 5;
		let attempt = 0;
		const tryOnce = async (): Promise<void> => {
			const r = await relayToGateway(dstGateway, op);
			if (r.ok) return;
			attempt += 1;
			if (attempt >= maxAttempts) {
				console.error(`[respond] ${label} to ${dstGateway} failed after ${maxAttempts} attempts: ${r.error}`);
				return;
			}
			setTimeout(() => void tryOnce(), Math.min(2000 * 2 ** (attempt - 1), 30_000));
		};
		void tryOnce();
	}

	/** Origin side of a cross-Gateway channel send. Keeps a local pollable anchor keyed
	 * by the canonical session id (so the sender can poll and the eventual
	 * response_push delivers back to its conversation), forwards the send to the
	 * destination Gateway with a return-route, and hands the session id back. */
	async function sendCrossGateway(args: {
		targetGateway: string;
		targetName: string;
		targetDomain?: string;
		from: string;
		fromConversationId: string | undefined;
		type?: string;
		effort?: string;
		body?: string;
		files?: ChannelFile[];
	}): Promise<Response> {
		const { targetGateway, targetName, targetDomain, from, fromConversationId, type, effort, body, files } = args;
		if (!evieClient?.isConnected()) {
			return jsonResponse({ error: `Router unavailable; cannot reach Gateway "${targetGateway}"` }, 503);
		}
		if (!fromConversationId) {
			return jsonResponse({ error: `fromConversationId is required for a cross-Gateway send` }, 400);
		}
		const targetAddr = TeamAddress.remote(targetGateway, targetName);
		const qualifiedTo = targetAddr.canonical;
		const srcSession = SessionId.channel(fromConversationId, targetAddr).key;
		const op: FederatedOp = {
			kind: "send",
			from: TeamAddress.local(localGatewayId, from).canonical,
			to: targetName,
			request_type: type,
			effort,
			body: body ?? "",
			...(files && files.length > 0 ? { files } : {}),
			returnRoute: { srcGateway: localGatewayId, srcConversationId: fromConversationId, srcSession },
		};
		const relay = await relayToGateway(targetGateway, op, targetDomain);
		if (!relay.ok)
			return jsonResponse({ error: relay.error ?? `cross-Gateway send to "${qualifiedTo}" failed` }, 502);
		// Keep a local pollable anchor ONLY once the destination accepted the send, so
		// a failed send (offline / timed-out Gateway) never leaves a dangling persistent
		// entry. The destination's reply is asynchronous (its agent answers later), so
		// the anchor is always present before any response_push arrives. Record the resolved
		// target Domain so the reply gate binds the response_push to THIS friend Domain (a
		// reply from any other Domain, even one sharing the bare gateway id, is rejected).
		store.create(srcSession, from, qualifiedTo, {
			persistent: true,
			fromConversationId,
			dstDomainId: targetDomainId(targetGateway, targetDomain) ?? undefined,
		});
		return jsonResponse({
			session_id: srcSession,
			status: "running",
			message: `Message routed to ${qualifiedTo} via the Router. Responses will be pushed back automatically.`,
		});
	}

	function ingest(req: Request, body: Record<string, unknown>): Response {
		const payload: Record<string, unknown> = body && typeof body === "object" ? body : { message: String(body) };
		payload.timestamp = payload.timestamp ?? Date.now();
		const line = `${JSON.stringify(payload)}\n`;
		try {
			const dir = path.dirname(LOG_PATH);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(LOG_PATH, line);
			return jsonResponse({ ok: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[ingest]`, message);
			return jsonResponse({ ok: false, error: message }, 500);
		}
	}

	function pending(): Response {
		const list = store.listAll().map((e) => ({
			session_id: e.id,
			from: e.from,
			to: e.to,
			state: e.state,
		}));
		return jsonResponse(list);
	}

	function teams(): Response {
		const teamsList: TeamInfo[] = [];
		const seen = new Set<string>();
		const isDevcontainer = (name: string) => offlineCatalog.has(name) || knownTeamPaths.has(name);

		for (const [name, subs] of registry) {
			if (name === "host") continue;
			seen.add(name);
			// An online local session keeps its cross-Domain shares fresh: refresh lastSeenAt
			// so a session that is actively connected is never auto-forgotten by the absence
			// sweep, even with no live thread. No-op when sharing is not wired.
			touchShares?.(TeamAddress.local(localGatewayId, name).canonical);
			// A team whose only live sockets are virtual console peers is the human's
			// device, not a crosstalk peer - mark it so the agent-facing listing hides it.
			const isConsole = getAllActiveWs(subs).length > 0 && getAllActiveRealWs(subs).length === 0;
			// Plugin version reported by an active real socket (virtual console peers carry
			// none); the same value across a team's sub-sessions in practice.
			const version = getAllActiveRealWs(subs)[0]?.data.version;
			// The host orchestrator registers its channel identity as "gateway"; surface
			// it as the "host" agent, the machine's primary session (shown first).
			teamsList.push({
				team: name,
				gatewayId: localGatewayId,
				domainId: localDomainId,
				status: "online",
				mode: getTeamMode(subs),
				kind:
					name === "gateway"
						? "gateway"
						: isConsole
							? "console"
							: isDevcontainer(name)
								? "devcontainer"
								: "loose",
				version,
				queue_depth: 0,
			});
		}

		for (const [name] of offlineCatalog) {
			if (seen.has(name)) continue;
			teamsList.push({
				team: name,
				gatewayId: localGatewayId,
				domainId: localDomainId,
				status: "available",
				kind: "devcontainer",
				queue_depth: 0,
			});
		}

		return jsonResponse(teamsList);
	}

	/** Discovery across the mesh: local teams, a fan-out to every online SAME-Domain peer
	 * Gateway (the evie roster is Domain-scoped), and a fan-out to every LINKED cross-Domain
	 * peer. evie supplies only the presence roster (content-blind); each peer's team list is
	 * fetched directly via a gateway_relay list_teams, so evie never sees who runs what. A
	 * cross-Domain peer returns ONLY the sessions it has shared to this Domain (its own
	 * relay handler applies the share filter), so an unshared friend session never appears.
	 * A peer that errors or times out is simply omitted. */
	async function discover(): Promise<Response> {
		const local = (await teams().json()) as TeamInfo[];
		if (!evieClient?.isConnected()) return jsonResponse(local);
		const rosterCall = await evieClient.callTool("list_gateways", {});
		const roster = (rosterCall.result as { gateways?: { gatewayId: string }[] } | undefined)?.gateways ?? [];
		const sameDomain = await Promise.all(
			roster.map(async (h) => {
				const r = await relayToGateway(h.gatewayId, { kind: "list_teams" });
				if (!r.ok) return [] as TeamInfo[];
				return (r.result as { teams?: TeamInfo[] } | undefined)?.teams ?? [];
			}),
		);
		// Cross-Domain leg: query each linked peer for its shared sessions. The returned
		// TeamInfo carries the peer's own gatewayId, which the send path resolves back to the
		// peer's Domain via crossDomainPeers (the SealTarget's separate domainId field, per the
		// Addressing decision - the Domain is never folded into the gateway/name string). One
		// gateway is queried once even if a Domain runs several gateways, keyed by its
		// (domainId, gatewayId) pair (a gateway id is unique within a Domain).
		const peers = crossDomainPeers?.all() ?? [];
		const seenPeerGateways = new Set<string>();
		const crossDomain = await Promise.all(
			peers.map(async (peer) => {
				const key = `${peer.friendDomainId}/${peer.friendGatewayId}`;
				if (seenPeerGateways.has(key)) return [] as TeamInfo[];
				seenPeerGateways.add(key);
				const r = await relayToGateway(peer.friendGatewayId, { kind: "list_teams" });
				if (!r.ok) return [] as TeamInfo[];
				const peerTeams = (r.result as { teams?: TeamInfo[] } | undefined)?.teams ?? [];
				// Tag each shared session with the peer's Domain id (authoritative HERE: this
				// Gateway knows which Domain it linked, while a friend on an older build might
				// stamp none). The (domainId, gatewayId) pair is what the console groups by and
				// the send path resolves the seal target from, since a gateway id collides
				// across Domains.
				return peerTeams.map((t) => ({ ...t, domainId: peer.friendDomainId }));
			}),
		);
		return jsonResponse([...local, ...sameDomain.flat(), ...crossDomain.flat()]);
	}

	async function send(req: Request, body: Record<string, unknown>): Promise<Response> {
		const parsed = SendRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const {
			from,
			fromConversationId,
			to,
			targetDomainId: targetDomain,
			type,
			effort,
			body: msgBody,
			replyJsonSchema,
			files,
			channelOnly,
			sessionId: inboundSessionId,
			returnRoute,
			dstDomainId,
		} = parsed.data;

		// Raw-bytes backstop at the trust boundary before the payload is pushed.
		if (files && files.length > 0) {
			const total = fileBytes(files);
			if (total > MAX_RESPONSE_FILE_BYTES) {
				return jsonResponse(
					{ error: `Attachments total ${total} bytes, over the ${MAX_RESPONSE_FILE_BYTES}-byte limit` },
					413,
				);
			}
		}

		// Cross-Gateway OUTBOUND: a target qualified with another Gateway routes through
		// the Router. An INBOUND federated send (the gateway-relay handler) arrives with
		// a bare `to` plus an explicit sessionId, so it skips this and lands locally.
		const parsedTarget = TeamAddress.parse(to, localGatewayId);
		if (!inboundSessionId && parsedTarget.gatewayId !== localGatewayId) {
			return await sendCrossGateway({
				targetGateway: parsedTarget.gatewayId,
				targetName: parsedTarget.name,
				targetDomain,
				from,
				fromConversationId,
				type,
				effort,
				body: msgBody,
				files,
			});
		}

		// Resolve the (bare or host-qualified) target to a local registry name. A
		// local-qualified or bare name resolves here; a remote-qualified name was
		// handled by the cross-Gateway branch above. `qualifiedTo` is the canonical
		// local form used as the channel session-id target.
		const target = resolveLocalTarget(to);
		if (!target) {
			return jsonResponse({ error: `Gateway for "${to}" is not reachable from this Gateway` }, 404);
		}
		const localName = target.name;
		const qualifiedTo = target.qualified;

		// The "host" cli wake-daemon is never a direct target. The "gateway" channel
		// identity (the host-agent) is reachable ONLY from the console (channelOnly): a
		// send injects a channel message into the host orchestrator. Cross-session
		// (container -> host-agent) sends are deferred to the federation phases that
		// design that trust boundary.
		if (localName === "host" || (localName === "gateway" && !channelOnly)) {
			return jsonResponse(
				{
					error: `"${localName}" is a reserved name; crosstalk_send targets container teams only.`,
				},
				400,
			);
		}

		let subs = registry.get(localName);
		let targetWs = subs ? getFirstWs(subs) : undefined;

		// If offline, attempt to wake the container. The "gateway" host-agent is
		// never a wakeable devcontainer (it is the host process itself), so an
		// offline host-agent goes straight to the 404 below.
		if (!targetWs && localName !== "gateway") {
			const woken = await tryWakeTeam(localName);
			if (woken) {
				// Claude Code needs time after MCP connect to initialize its channel listener.
				// Registration happens instantly but channel notifications aren't ready yet.
				await new Promise((r) => setTimeout(r, 3000));
				subs = registry.get(localName);
				targetWs = subs ? getFirstWs(subs) : undefined;
			}
		}

		if (!targetWs || !subs) {
			return jsonResponse(
				{
					error: `Team "${qualifiedTo}" is not connected`,
					available: [...registry.keys()]
						.filter((k) => k !== "host")
						.map((k) => TeamAddress.local(localGatewayId, k).canonical),
				},
				404,
			);
		}

		const targetMode = getTeamMode(subs);

		// channelOnly senders (the console) must never reach the CLI branch below:
		// it mints a fresh random session id that can never join the sender's
		// deterministic conversation threads. Checked post-wake, so even a
		// sleeping CLI team that this send just woke gets a clean error instead
		// of an orphan session.
		if (channelOnly && targetMode !== "channel") {
			return jsonResponse(
				{ error: `"${localName}" is a CLI-mode agent; console chat supports channel-mode (Claude) teams only` },
				409,
			);
		}

		// Channel mode: stable job id per (sender_conversation_id, target_team) pair.
		// The target is the canonical qualified name, so the console threads the reply
		// under (gatewayId, name). Same pair reuses the same store entry forever; entries
		// are persistent.
		if (targetMode === "channel") {
			try {
				// A federated inbound send carries the origin's session id; a local send
				// derives a stable key from (sender conversation, target).
				const channelJobId =
					inboundSessionId ??
					(fromConversationId
						? SessionId.channel(fromConversationId, TeamAddress.parse(qualifiedTo, localGatewayId)).key
						: null);
				if (!channelJobId) {
					return jsonResponse({ error: `fromConversationId is required for channel-mode targets` }, 400);
				}

				const isFollowUp = store.has(channelJobId);
				// Honor a Domain binding ONLY on an inbound federated send (the gateway-relay
				// handler sets inboundSessionId + dstDomainId together from the verified seal). A
				// plain local /send must never stamp it from the request body, or a local caller
				// could forge a binding that lets a cross-Domain reply land in a local job.
				const inboundDstDomainId = inboundSessionId ? dstDomainId : undefined;
				store.create(channelJobId, from, localName, {
					persistent: true,
					fromConversationId,
					returnRoute,
					dstDomainId: inboundDstDomainId,
				});

				const messageId = crypto.randomUUID();
				const channelPayload: Record<string, unknown> = {
					type: "channel_push",
					from,
					request_type: type || "question",
					body: msgBody || "",
					effort: effort || "auto",
					session_id: channelJobId,
					message_id: messageId,
					is_follow_up: isFollowUp,
				};
				if (replyJsonSchema) channelPayload.replyJsonSchema = replyJsonSchema;
				// message_id becomes the materialization bucket key in the target container.
				if (files && files.length > 0) channelPayload.files = files;
				const payload = JSON.stringify(channelPayload);

				const activeWs = getAllActiveWs(subs);
				if (activeWs.length === 0) {
					throw new Error(`Team "${qualifiedTo}" has no active connections`);
				}

				for (const ws of activeWs) {
					ws.send(payload);
				}

				console.log(
					`[send] channel_push to ${qualifiedTo} [${channelJobId}] msg=${messageId.slice(0, 8)} from ${from} (${activeWs.length} sub-session${activeWs.length > 1 ? "s" : ""})`,
				);

				return jsonResponse({
					session_id: channelJobId,
					status: "running",
					message: `Message pushed to ${localName} via channel. Responses will be pushed back automatically.`,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[send] channel error:`, message);
				return jsonResponse({ error: message }, 500);
			}
		}

		return jsonResponse({ error: "CLI-mode agents are no longer supported." }, 400);
	}

	function respond(req: Request, body: Record<string, unknown>): Response {
		const parsed = RespondBodySchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}

		const { session_id: respondSessionId, replyAsJson, files, ...rest } = parsed.data;

		// Raw-bytes backstop before anything is stored or pushed.
		if (files && files.length > 0) {
			const total = fileBytes(files);
			if (total > MAX_RESPONSE_FILE_BYTES) {
				return jsonResponse(
					{ error: `Attachments total ${total} bytes, over the ${MAX_RESPONSE_FILE_BYTES}-byte limit` },
					413,
				);
			}
		}

		// Check if this is a handshake response (handshakes never carry files).
		if (resolveHandshake?.(respondSessionId, replyAsJson ?? undefined, rest.response ?? undefined)) {
			return jsonResponse({ delivered: true, handshake: true });
		}

		// If JSON reply provided but no explicit response string, pretty-stringify for text consumers
		const response: ResponsePayload = {
			session_id: respondSessionId,
			status: rest.status as ResponsePayload["status"] | undefined,
			response: rest.response,
			question: rest.question,
			reason: rest.reason,
			estimated_minutes: rest.estimated_minutes,
			what_to_decide: rest.what_to_decide,
			message: rest.message,
		};
		// The store result is poll-recoverable and (for channel convs) never swept,
		// so it keeps file metadata only; the bytes ride the live push/mailbox below.
		if (files && files.length > 0) response.files = stripFileBytes(files);
		if (replyAsJson) {
			response.replyAsJson = replyAsJson;
			if (!response.response) {
				response.response = JSON.stringify(replyAsJson, null, 2);
			}
		}

		const canonicalSessionId = SessionId.parse(respondSessionId, localGatewayId)?.key ?? respondSessionId;
		const deliverResult = store.deliver(canonicalSessionId, response);
		if (!deliverResult) {
			console.log(
				`[respond] 404 - no pending job for ${respondSessionId.slice(0, 8)}... (already delivered or expired)`,
			);
			return jsonResponse({ error: `No pending request for session_id "${respondSessionId}"` }, 404);
		}

		console.log(`[respond] ${respondSessionId}${response.status ? ` → ${response.status}` : ""}`);

		// Cross-Gateway reply-pinning: a job created by a federated send belongs to the
		// ORIGIN Gateway's session, not a local conversation. Forward a response_push
		// back through the Router (carrying the full file bytes) and stop here - the
		// local conversationRegistry has no entry for the remote sender.
		if (deliverResult.returnRoute) {
			const rr = deliverResult.returnRoute;
			// Re-check the per-session share on a CROSS-DOMAIN reply (a destination job carries the
			// verified friend Domain): an already-accepted send whose session was un-shared after it
			// landed must have its in-flight reply DROPPED, not relayed home. The share state is the
			// same source the inbound op gate reads, so an un-share bites every direction without
			// evie. The session target is the canonical gateway/name parsed from the job's own
			// (origin-set) session key, the form the share is keyed by. A same-Domain federated reply
			// (dstDomainId null) skips the gate, unchanged.
			if (deliverResult.dstDomainId) {
				const sessionTarget = SessionId.parse(rr.srcSession, localGatewayId)?.target.canonical;
				if (!sessionTarget || !isSharedToForReply?.(sessionTarget, deliverResult.dstDomainId)) {
					console.log(
						`[respond] ${respondSessionId} DROPPED: session no longer shared to Domain "${deliverResult.dstDomainId}"`,
					);
					return jsonResponse({ delivered: false, dropped: "unshared" });
				}
			}
			relayWithRetry(
				rr.srcGateway,
				{
					kind: "response_push",
					session_id: rr.srcSession,
					...(response.status ? { status: response.status } : {}),
					...(response.response ? { response: response.response } : {}),
					...(response.replyAsJson ? { replyAsJson: response.replyAsJson } : {}),
					...(response.question ? { question: response.question } : {}),
					...(response.reason ? { reason: response.reason } : {}),
					...(files && files.length > 0 ? { files } : {}),
				},
				"cross-Gateway reply-pin",
			);
			console.log(`[respond] ${respondSessionId} pinned to Gateway ${rr.srcGateway} via the Router`);
			return jsonResponse({ delivered: true, federated: true });
		}

		// Push response back to the sender. For conversation-routed sends we target the
		// specific sub-session via conversationRegistry so parallel host windows don't
		// all receive each other's replies. Fall back to team broadcast if there
		// is no conversation id on the entry (CLI mode that still uses waitForResult
		// has already been satisfied above and won't hit this branch for a push).
		const push: ResponsePushPayload = {
			type: "response_push",
			session_id: respondSessionId,
			response: response.response,
			replyAsJson: response.replyAsJson,
			question: response.question,
			reason: response.reason,
		};
		if (response.status) push.status = response.status;
		// The push carries the full bytes (the store kept metadata only).
		if (files && files.length > 0) push.files = files;
		const pushMsg = JSON.stringify(push);

		let pushedViaConversation = false;
		if (deliverResult.fromConversationId) {
			// A console-bound reply is delivered by APPENDING to the owner's durable
			// mailbox by data, independent of any live ConsolePeer. For a console job
			// `fromConversationId` is the OWNER id (the inbox is shared by all the
			// owner's devices); a real channel agent's is its device conversation id,
			// which has no mailbox and takes the live-WS branch below. After a gateway
			// restart the mailbox is restored but the virtual peer is rebuilt only on
			// the console's next frame, so routing the reply through the live peer would
			// drop it. The mailbox is the delivery truth; the peer is a wake hint.
			const mailbox = mailboxStore?.get(deliverResult.fromConversationId);
			if (mailbox) {
				mailbox.append({
					kind: "reply",
					session_id: respondSessionId,
					body: response.response,
					status: response.status,
					replyAsJson: response.replyAsJson,
					question: response.question,
					reason: response.reason,
					files: files && files.length > 0 ? files : undefined,
				});
				pushedViaConversation = true;
				console.log(
					`[respond] appended to console mailbox ${deliverResult.fromConversationId.slice(0, 8)}... [${respondSessionId}]`,
				);
			} else {
				const senderWs = conversationRegistry.get(deliverResult.fromConversationId);
				if (senderWs && senderWs.readyState === 1) {
					senderWs.send(pushMsg);
					pushedViaConversation = true;
					console.log(
						`[respond] pushed to ${deliverResult.from} via conversation ${deliverResult.fromConversationId.slice(0, 8)}... [${respondSessionId}]`,
					);
				} else {
					console.log(
						`[respond] conversation ${deliverResult.fromConversationId.slice(0, 8)}... offline, response kept in store [${respondSessionId}]`,
					);
				}
			}
		}

		// Conversation-routed sends never degrade to name-based broadcast: the
		// sender team name may since have been claimed by an unrelated identity
		// (e.g. a real team replacing an evicted console peer), and the result
		// stays poll-recoverable in the store regardless.
		if (!pushedViaConversation && !deliverResult.fromConversationId) {
			const fromSubs = registry.get(deliverResult.from);
			if (fromSubs && getTeamMode(fromSubs) === "channel") {
				try {
					const activeWsList = getAllActiveWs(fromSubs);
					for (const ws of activeWsList) {
						ws.send(pushMsg);
					}
					if (activeWsList.length > 0) {
						console.log(
							`[respond] pushed to ${deliverResult.from} via team broadcast (${activeWsList.length} subs) [${respondSessionId}]`,
						);
					}
				} catch {
					console.log(`[respond] push failed, kept for polling [${respondSessionId.slice(0, 8)}...]`);
				}
			}
		}

		return jsonResponse({ delivered: true });
	}

	function poll(req: Request, body: Record<string, unknown>): Response {
		const parsed = PollRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `session_id is required` }, 400);
		}

		const { session_id } = parsed.data;

		const result = store.poll(session_id);

		if (result === undefined) {
			return jsonResponse({ error: `No pending job for session_id "${session_id}"` }, 404);
		}

		if (result === null) {
			return jsonResponse({
				session_id,
				status: "running",
				message: `Job is still running. Poll again later.`,
			});
		}

		return jsonResponse(result);
	}

	function health(): Response {
		return jsonResponse({
			ok: true,
			teams: registry.size,
			pending_jobs: store.size,
		});
	}

	async function evieToolCall(req: Request, body: Record<string, unknown>): Promise<Response> {
		if (!evieClient?.isConnected()) {
			return jsonResponse({ error: `Evie-bot is not connected.` }, 503);
		}

		const parsed = EvieToolCallSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: action (string) and params (object) are required` }, 400);
		}

		const { action, params } = parsed.data;
		const result = await evieClient.callTool(action, params as Record<string, unknown>);
		return jsonResponse(result, result.error ? 500 : 200);
	}

	/** Broadcast a notice to every registered console mailbox. Notices thread under
	 * the sender on the console and are never respondable: they are appended
	 * directly here (not via a peer push), so no inbound session is recorded. */
	function humanNotify(body: Record<string, unknown>): Response {
		const parsed = HumanNotifySchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, title, summary, full, files } = parsed.data;
		if (files && files.length > 0) {
			const total = fileBytes(files);
			if (total > MAX_RESPONSE_FILE_BYTES) {
				return jsonResponse(
					{ error: `Attachments total ${total} bytes, over the ${MAX_RESPONSE_FILE_BYTES}-byte limit` },
					413,
				);
			}
		}
		if (!mailboxStore) {
			return jsonResponse({ error: "console bridge is not enabled on this gateway" }, 503);
		}
		let delivered = 0;
		mailboxStore.forEach((_conversationId, box) => {
			box.append({
				kind: "notice",
				session_id: NoticeId.of(TeamAddress.local(localGatewayId, from)).key,
				from,
				title,
				summary,
				body: full,
				...(files && files.length > 0 ? { files } : {}),
			});
			delivered++;
		});
		console.log(`[notify] notice from ${from} delivered to ${delivered} console(s)`);
		return jsonResponse({ delivered });
	}

	return {
		ingest,
		pending,
		teams,
		discover,
		send,
		respond,
		poll,
		health,
		evieToolCall,
		humanNotify,
	};
}
