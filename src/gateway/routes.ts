import crypto from "node:crypto";
import { capFifo } from "../shared/cap-fifo.js";
import { UNREPORTED_CAPABILITIES } from "../shared/capabilities.js";
import type { BoardEntry, DiscoverCoverage } from "../shared/console-protocol.js";
import type { SealedEnvelope } from "../shared/crypto.js";
import type { FederatedOp } from "../shared/federation-protocol.js";
import { pickTiers } from "../shared/notice.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import {
	Address,
	composeSessionName,
	DEFAULT_SESSION,
	LOCAL_DOMAIN_SENTINEL,
	parseSessionName,
	parseStoreKey,
	parseTarget,
	SpawnPoint,
	storeKey,
} from "../shared/session-id.js";
import type { ChannelFile, GatewayConfig, ResponsePayload, ResponsePushPayload, TeamInfo } from "../shared/types.js";
import { createBlobFetcher } from "./blobFetch.js";
import type { CascadeChange } from "./boardCascade.js";
import {
	type BoardActor,
	type BoardResult,
	type BoardStore,
	boardEntryIdForOperation,
	mayWrite,
	visibleTo,
} from "./boardStore.js";
import { createConsolePushOps } from "./consolePushOps.js";
import { sealTargetFor } from "./federation/sealTarget.js";
import { isNoAckSessionId } from "./noAckPush.js";
import { createPresenceExchange } from "./presenceExchange.js";
import {
	type AgentBoardEntry,
	BoardRouteRequestSchema,
	fileBytes,
	getTeamMode,
	jsonResponse,
	MAX_BOARD_REPLIES,
	MAX_RESPONSE_FILE_BYTES,
	POST_WAKE_SETTLE_MS,
	PollRequestSchema,
	RespondBodySchema,
	SendRequestSchema,
	stampBlobHolder,
	stripFileRefs,
} from "./routeSchemas.js";
import { type Presented, presentedByRequest, type SessionAuthority } from "./sessionAuthority.js";
import type { WakeResult } from "./wake.js";
import {
	type ConversationRegistry,
	getAllActiveWs,
	type HandshakeRepushOutcome,
	resolveLiveIncarnation,
	type TeamRegistry,
} from "./websocket.js";

export { MAX_RESPONSE_FILE_BYTES, POST_WAKE_SETTLE_MS };

////////////////////////////////
//  Interfaces & Types

export interface RoutesDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: PendingJobStore<ResponsePayload>;
	tryWakeTeam: (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => Promise<WakeResult>;
	// The durable session-record store. Used directly by send/respond's live-incarnation
	// resolution; teams() itself defers entirely to `presence.snapshot()` below. Optional for
	// test harnesses with no resume tracking.
	sessionStore?: import("../shared/session-store.js").SessionStore;
	capabilityStore?: Pick<import("./console/capabilityStore.js").CapabilityStore, "snapshot">;
	daemonCapabilityStore?: Pick<import("./daemonCapabilities.js").DaemonCapabilityStore, "snapshot">;
	// The presence facade: teams() is exactly `presence.snapshot()`, so a manual GET /teams pull-
	// to-refresh and the poll response's presence plane can never compute two different answers.
	// Optional so a harness testing routes with no presence wiring still gets an empty teams list
	// rather than a throw.
	presence?: { snapshot(): TeamInfo[] };
	// Console mailboxes, for broadcast notices (notify_human). Optional so test
	// harnesses without a console bridge need not supply one.
	mailboxStore?: import("../shared/device-mailbox.js").DeviceMailboxStore;
	config: GatewayConfig;
	routerClient?: import("./router/routerClient.js").RouterClient | null;
	// E2E seal/open for cross-Gateway frames; absent when federation crypto is off.
	sealer?: import("./federation/sealer.js").Sealer | null;
	/** This Gateway's byte store, for pulling in a blob a peer Gateway holds. Absent in tests that
	 * never move bytes, which makes a cross-Gateway fetch a clean refusal rather than a crash. */
	blobStore?: import("../shared/blob-store.js").BlobStore;
	// The disjoint cross-Domain peer set. A cross-Domain send resolves its target's Domain
	// here (the SealTarget is keyed by the full (domainId, gatewayId) pair, never the bare
	// id), and discovery fans a list_teams to each linked peer. Absent when federation is off.
	crossDomainPeers?: import("./federation/crossDomainPeers.js").CrossDomainPeers | null;
	// Whether a gateway id resolves to a LOCAL (single-owner allowlist) peer. Mirrors the
	// sealer's local-first resolution on the SEND side, so a send to your own local Gateway
	// whose id collides with a friend's gateway id is sealed v1 to the local Domain (the bare-string
	// shorthand) rather than hijacked to the friend. Absent when federation crypto is off.
	resolvesLocalGateway?: ((gatewayId: string) => boolean) | null;
	// Refresh the share lastSeenAt for a live local session (its canonical domain.gateway.spawn.session),
	// called from teams() per online team so a session's presence keeps its shares from
	// auto-forgetting. Absent when federation sharing is not wired.
	touchShares?: ((sessionTarget: string) => void) | null;
	// Whether a local session (canonical domain.gateway.spawn.session) is still shared to a friend Domain,
	// re-read on the destination cross-Domain reply forward: an already-accepted send whose
	// session was un-shared has its in-flight reply DROPPED here rather than relayed back to the origin. The
	// share state is the single source both the inbound gate and this reply gate read, so an
	// un-share bites without the Router. Absent when federation sharing is not wired (no recheck).
	isSharedToForReply?: ((sessionTarget: string, domainId: string) => boolean) | null;
	// The session targets currently shared to a friend Domain (the same slimmed discovery filter
	// gatewayRelay.ts's list_teams case applies) - read by presenceForDomain to compute what a
	// linked Domain currently sees, for the cross-Domain-presence push. Absent when federation
	// sharing is not wired.
	sharesFor?: ((domainId: string) => string[]) | null;
	// The cross-Domain-presence landing store (gateway/federation/crossDomainPresence.ts) -
	// presence_push's landing side appends into it. Absent when federation is not wired.
	crossDomainPresenceConsumer?: import("./federation/crossDomainPresence.js").CrossDomainPresenceConsumer | null;
	resolveHandshake?: (
		sessionId: string,
		replyAsJson?: Record<string, unknown>,
		response?: string,
		responderToken?: Presented,
	) => boolean;
	// The pending hs-* id owed by a (team, subId), if any - lets respond() name the exact handshake
	// an unconfirmed caller must answer first. Absent in test harnesses that don't exercise the gate.
	findPendingHandshake?: (team: string, subId: string) => string | undefined;
	// Re-sends a (team, subId)'s still-pending handshake so a caller that lost the original
	// notification gets a fresh one instead of a dead-end 409. Absent in test harnesses that don't
	// exercise the gate; the gate fails open to its unenhanced message when this is undefined.
	repushHandshake?: (team: string, subId: string) => HandshakeRepushOutcome;
	// This Gateway's own Domain owner id (a hash of the owner's signing key), used to key the
	// mirror-tap's agent-to-agent display entries into the owner's mailbox. Null pre-enrollment
	// (arming mode) or when federation is off, matching resolvesLocalGateway's gating.
	ownerId?: (() => string | null) | null;
	// The sole resolver of "what must a caller prove to act as X". Absent in test harnesses that do
	// not exercise the identity gates, which then behave as an ungated gateway does.
	auth?: SessionAuthority;
	// The owner's task board (boardStore.ts). Absent when not wired; the board route then 503s.
	boardStore?: BoardStore;
	// State that must survive a rebuild (see RoutesCarryOver). Absent in test harnesses, which build
	// the route table once and never rebuild it.
	carryOver?: RoutesCarryOver;
}

/**
 * The state a routes rebuild must NOT restart from empty.
 *
 * `createRoutes` runs again when federation activates mid-session, so anything it allocates per call
 * is discarded at that moment. Owned by the caller and passed back in, which is what makes the
 * survival a property of the wiring rather than of nobody having rebuilt yet.
 *
 * Only entries whose loss changes BEHAVIOUR belong here. A burst cache does not: rebuilding it costs
 * one recomputation and can report nothing stale.
 */
/**
 * What a caller is asking to act as, which decides what naming a session proves.
 *
 * "session": the call acts AS the named session, so an unbound name passing is correct - that is
 * what keeps a hand-launched session sending. "owner-data": the call reads or writes the OWNER's
 * own board or mailbox, which no session name can speak for, so the caller must additionally prove
 * it is one of this gateway's bound sessions. Required rather than defaulted: a new route is then a
 * compile error until someone decides which it is, instead of silently taking the weaker one.
 */
export type CallerScope = "session" | "owner-data";

export interface RoutesCarryOver {
	/** Settled replies for the board route's mutating operations. Losing this turns a retried
	 * absolute write into a second write rather than a replay. */
	boardOperationReplies: Map<string, Record<string, unknown>>;
	/** In-flight cross-Gateway blob fetches. Losing this un-coalesces the fetches already running,
	 * so the same bytes are pulled twice. */
	blobFetches: Map<string, Promise<boolean>>;
}

export function createRoutesCarryOver(): RoutesCarryOver {
	return { boardOperationReplies: new Map(), blobFetches: new Map() };
}

////////////////////////////////
//  Functions & Helpers

export function createRoutes({
	registry,
	conversationRegistry,
	store,
	capabilityStore,
	daemonCapabilityStore,
	tryWakeTeam,
	sessionStore,
	presence,
	mailboxStore,
	config,
	routerClient,
	sealer,
	blobStore,
	crossDomainPeers,
	resolvesLocalGateway,
	touchShares,
	isSharedToForReply,
	sharesFor,
	crossDomainPresenceConsumer,
	resolveHandshake,
	auth,
	findPendingHandshake,
	repushHandshake,
	ownerId,
	boardStore,
	carryOver = createRoutesCarryOver(),
}: RoutesDeps) {
	const { localGatewayId, localDomainId } = config;
	/** Settled replies for the board route's mutating operations, keyed `from:operationId`.
	 *
	 * IN MEMORY, which is weaker than the console's durable equivalent and weaker than the rule
	 * CLAUDE.md states for board mutations. The gap is real and narrow: an MCP operation id outlives
	 * this process, so a gateway restart between committing a write and flushing its reply loses the
	 * record, and the caller's retry re-applies an absolute set. `create` is unaffected - its replay
	 * is structural, in the board file itself. Closing it wants this route's own durable file;
	 * DurableOpStore is typed to console results and keyed by conversation, so it cannot just be
	 * borrowed. Tracked in the plan. */
	const boardOperationReplies = carryOver.boardOperationReplies;
	// The local Domain segment for every address we mint. Null (arming mode, pre-enrollment)
	// resolves to the sentinel so a key still forms; a real domain id is lowercase hex.
	const localDomain = localDomainId ?? LOCAL_DOMAIN_SENTINEL;

	/** Build the canonical Address of a LOCAL session from its registry team field (`spawn` or
	 * `spawn.session`). The session segment defaults to DEFAULT_SESSION for a bare spawn name. This
	 * is the ONE producer of a local session's canonical, so the share key, the relay gate, and the
	 * job's store-key address all agree byte-for-byte. */
	function localAddress(name: string): Address {
		const { project, session } = parseSessionName(name);
		return Address.local(localDomain, localGatewayId, project, session);
	}

	/** A console is registry-keyed by a free-form human Device Name (not a slug), so its canonical
	 * sender address uses the owner id (a slug, the shared inbox key) as the spawn segment, never the
	 * device name. The device name stays a display label. */
	function consoleSelfAddress(ownerId: string): Address {
		return Address.local(localDomain, localGatewayId, ownerId, DEFAULT_SESSION);
	}

	/** Null instead of throwing for a non-addressable registry key (a console's device name), so a
	 * registry iteration silently skips the operator's own device. */
	function tryLocalAddress(name: string): Address | null {
		try {
			return localAddress(name);
		} catch {
			return null;
		}
	}

	/** The resolved target Domain id for a cross-Gateway send, or null for a local /
	 * same-Domain (bare-string) target. Recorded on the origin anchor so the reply gate can
	 * require a response_push's verified Domain to match the Domain the send was routed to. A
	 * resolution error (an ambiguous gateway id) surfaces on the relay path first, so this
	 * just falls back to null. */
	function targetDomainId(targetGateway: string, targetDomain?: string): string | null {
		try {
			const target = sealTargetFor({ resolvesLocalGateway, crossDomainPeers }, targetGateway, targetDomain);
			return typeof target === "string" ? null : target.domainId;
		} catch {
			return null;
		}
	}

	/** Resolve a wire target to a local registry name + its canonical Address. A target whose
	 * (domain, gateway) is ours resolves locally (the local-collapse rule); a different gateway or
	 * Domain returns null (the cross-Gateway branch's job). A spawn-point (arity 1/3) is not an
	 * addressable session and returns null too (the send handler fails it fast with a clear error).
	 * `name` is the registry team field (`spawn.session`); `address` is the channel session target. */
	function resolveLocalTarget(to: string): { name: string; address: Address } | null {
		const t = parseTarget(to, localDomain, localGatewayId);
		if (t instanceof SpawnPoint) return null;
		if (t.domain !== localDomain || t.gateway !== localGatewayId) return null;
		return { name: composeSessionName(t.spawn, t.session), address: t };
	}

	/** Forward a federated op to another Gateway through the Router and unwrap the
	 * reply. The Router holds the call until the destination Gateway answers (or times
	 * out), so a resolved result means the destination handled the op. */
	async function relayToGateway(
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
	): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		if (!routerClient?.isConnected())
			return { ok: false, error: `Router unavailable; cannot reach Gateway "${dstGateway}"` };
		if (!sealer) return { ok: false, error: `federation crypto is not configured` };
		// Resolve the target to a SealTarget once: a local peer is the bare string (v1); a
		// cross-Domain peer becomes an explicit (domainId, gatewayId) target (v2). An explicit
		// dstDomain disambiguates a gateway id shared across two linked Domains. The destination's
		// Domain (if any) also lets us open its v2 reply by the full pair.
		let target: import("./federation/sealer.js").SealTarget;
		let sealed: SealedEnvelope;
		try {
			target = sealTargetFor({ resolvesLocalGateway, crossDomainPeers }, dstGateway, dstDomain);
			sealed = sealer.seal(target, op);
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
		// The Domain the target actually resolved to (authoritative over the caller's hint),
		// used to open the destination's v2 reply by the full (domainId, gatewayId) pair.
		const resolvedDstDomain = typeof target === "string" ? undefined : target.domainId;
		const relayId = crypto.randomUUID();
		const call = await routerClient.callTool("gateway_relay", {
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

	/** Relay a cross-Gateway op in the background, retrying on transient failure (the Router
	 * reconnecting, the origin Gateway restarting) with exponential backoff. The reply
	 * it carries is already durable in the local anchor (poll-recoverable), so a
	 * dropped first attempt does not strand the origin's request. Resolves once the
	 * relay finally succeeds OR exhausts its attempts - a caller that only wants
	 * fire-and-forget behavior (the pre-existing convention) can still `void` it. */
	function relayWithRetry(
		dstGateway: string,
		op: FederatedOp,
		label: string,
		dstDomain?: string,
	): Promise<{ ok: boolean; error?: string }> {
		const maxAttempts = 5;
		let attempt = 0;
		return new Promise((resolveOutcome) => {
			const tryOnce = async (): Promise<void> => {
				// A relay throw (Router disconnect mid-call, call timeout) is just another transient
				// failure: fold it into the retry path so it never escapes as an unhandled rejection.
				let error: string | undefined;
				try {
					const r = await relayToGateway(dstGateway, op, dstDomain);
					if (r.ok) {
						resolveOutcome({ ok: true });
						return;
					}
					error = r.error;
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
				}
				attempt += 1;
				if (attempt >= maxAttempts) {
					console.error(`[relay] ${label} to ${dstGateway} failed after ${maxAttempts} attempts: ${error}`);
					resolveOutcome({ ok: false, error });
					return;
				}
				setTimeout(() => void tryOnce(), Math.min(2000 * 2 ** (attempt - 1), 30_000));
			};
			void tryOnce();
		});
	}

	// Constructed per createRoutes call, never hoisted: a rebuild (federation activating mid-session)
	// hands each module the freshly-captured deps, so nothing here keeps serving the pre-federation
	// closure. Anything whose loss would change behaviour rides carryOver instead.
	const { mirrorPeer, consolePush, humanNotify, pluginAction, fanOutConsolePush } = createConsolePushOps({
		mailboxStore,
		ownerId,
		routerClient,
		resolvesLocalGateway,
		localGatewayId,
		localAddress,
		refuseImpersonation,
		relayWithRetry,
	});
	const { fetchBlobFromGateway } = createBlobFetcher({
		blobStore,
		crossDomainPeers,
		localGatewayId,
		relayToGateway,
		inFlight: carryOver.blobFetches,
	});
	const {
		presenceForDomain,
		pushPresenceToDomain,
		pullPresenceFromDomain,
		relayListTeams,
		landCrossDomainPresence,
		invalidatePresenceSnapshotCache,
	} = createPresenceExchange({
		presence,
		sharesFor,
		crossDomainPeers,
		crossDomainPresenceConsumer,
		tryLocalAddress,
		relayToGateway,
	});

	/** Origin side of a cross-Gateway channel send. Keeps a local pollable anchor keyed
	 * by the canonical session id (so the sender can poll and the eventual
	 * response_push delivers back to its conversation), forwards the send to the
	 * destination Gateway with a return-route, and hands the session id back. */
	async function sendCrossGateway(args: {
		targetGateway: string;
		targetName: string;
		targetDomain?: string;
		from: string;
		// Pre-built canonical sender address. The console sets it (owner-id based) because its `from`
		// is a free-form Device Name that is not a slug; an agent send leaves it unset and the sender
		// address is derived from its slug team field instead.
		fromAddress?: string;
		fromConversationId: string | undefined;
		body?: string;
		files?: ChannelFile[];
		// Threaded through to the destination Gateway's own local send() so a not-yet-existing target
		// there mints an opaque id instead of adopting the typed segment - the SAME rule a local send
		// applies, just carried across the relay since the destination decides its own id space.
		displayLabel?: string;
	}): Promise<Response> {
		const {
			targetGateway,
			targetName,
			targetDomain,
			from,
			fromAddress,
			fromConversationId,
			body,
			files,
			displayLabel,
		} = args;
		if (!routerClient?.isConnected()) {
			return jsonResponse({ error: `Router unavailable; cannot reach Gateway "${targetGateway}"` }, 503);
		}
		if (!fromConversationId) {
			return jsonResponse({ error: `fromConversationId is required for a cross-Gateway send` }, 400);
		}
		// Resolve the destination Domain ONCE so the address's domain segment and the anchor's
		// dstDomainId binding are byte-identical (the reply gate compares them). The address carries
		// the DESTINATION's domain so its store key matches the destination's own local key.
		const resolvedDomain = targetDomainId(targetGateway, targetDomain);
		const { project: tSpawn, session: tSession } = parseSessionName(targetName);
		const targetAddr = Address.remote(resolvedDomain ?? localDomain, targetGateway, tSpawn, tSession);
		const qualifiedTo = targetAddr.canonical;
		const srcSession = storeKey({ kind: "conv", conversationId: fromConversationId, address: targetAddr });
		const senderAddr = fromAddress ? null : localAddress(from);
		const senderCanonical = fromAddress ?? senderAddr!.canonical;
		const op: FederatedOp = {
			kind: "send",
			from: senderCanonical,
			to: targetName,
			body: body ?? "",
			...(files && files.length > 0 ? { files } : {}),
			...(displayLabel ? { displayLabel } : {}),
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
			dstDomainId: resolvedDomain ?? undefined,
		});
		// Mirror the LOCAL sender's own outbound leg; the remote target's own gateway mirrors its
		// side independently. Never for a console sender (senderAddr is only ever set for an agent).
		if (senderAddr) {
			mirrorPeer(senderAddr, senderCanonical, targetAddr.canonical, { body, files });
		}
		return jsonResponse({
			session_id: srcSession,
			status: "running",
			message: `Message routed to ${qualifiedTo} via the Router. Responses will be pushed back automatically.`,
		});
	}

	/** Ungated on purpose: it serves non-secret capability ids and their own instruction text, and the
	 * hand-launched host window this exists to serve carries no credential to present. */
	function capabilities(): Response {
		// Kept apart rather than merged here: only the caller knows what it already holds, and a
		// merged list cannot say which source spoke this round.
		const consoleSnapshot = capabilityStore?.snapshot() ?? UNREPORTED_CAPABILITIES;
		return jsonResponse({
			// LEGACY, remove after 2026-11-01. A session started by a plugin from before the split reads
			// these flat fields and nothing else, so they carry exactly what it would have been served then.
			...consoleSnapshot,
			console: consoleSnapshot,
			daemon: daemonCapabilityStore?.snapshot() ?? UNREPORTED_CAPABILITIES,
		});
	}

	/**
	 * Every live job, which is why it is gated: a `session_id` is the credential `/poll` and
	 * `/respond` accept, and a console-originated one embeds the owner's own mailbox key, so
	 * enumerating them hands out the keys to both doors.
	 */
	function pending(req: Request): Response {
		if (!provedLocalSession(req)) {
			return jsonResponse({ error: "the job list is not open to this caller" }, 403);
		}
		const list = store.listAll().map((e) => ({
			session_id: e.id,
			from: e.from,
			to: e.to,
			state: e.state,
		}));
		return jsonResponse(list);
	}

	/** The presence facade owns this computation (`presence.snapshot()`) - GET /teams and the
	 * poll response's presence plane can never disagree, since both read the same function. The
	 * two side effects the facade correctly does NOT own stay here: touching a live session's
	 * cross-Domain shares fresh (an unrelated subsystem), and touchLive's lastSeen refresh (a
	 * purely ambient field, deliberately excluded from the presence identity hash). */
	function teams(): Response {
		const rows = presence?.snapshot() ?? [];
		for (const row of rows) {
			if (row.status !== "online" && row.status !== "verifying") continue;
			const selfAddr = tryLocalAddress(row.team);
			if (selfAddr) touchShares?.(selfAddr.canonical);
			sessionStore?.touchLive(row.team);
		}
		return jsonResponse(rows);
	}

	/** Discovery across the mesh: local teams, a fan-out to every online SAME-Domain peer
	 * Gateway (the Router's roster is Domain-scoped), and a fan-out to every LINKED cross-Domain
	 * peer. The Router supplies only the presence roster (content-blind); each peer's team list is
	 * fetched directly via a gateway_relay list_teams, so the Router never sees who runs what. A
	 * cross-Domain peer returns ONLY the sessions it has shared to this Domain (its own
	 * relay handler applies the share filter), so an unshared friend session never appears.
	 * A peer that errors or times out is simply omitted. */
	/** Mesh discovery, WITH its own completeness. A partial answer must say so: a peer that could
	 * not be asked is otherwise indistinguishable from one with nothing to say, and its sessions get
	 * swept as absent. That ambiguity hid a total relay outage for a day. */
	async function discoverFull(): Promise<{ teams: TeamInfo[]; coverage: DiscoverCoverage }> {
		const local = (await teams().json()) as TeamInfo[];
		const unreachable: string[] = [];
		const unreachablePeers: string[] = [];
		// isRegistered, not isConnected: a REFUSED registration leaves the socket open, and reading
		// that as "no peers" reports a revoked Gateway as an empty mesh.
		if (!routerClient?.isRegistered()) {
			if (routerClient?.isConnected()) console.warn(`[discover] roster unknown: not registered with the Router`);
			return { teams: local, coverage: { rosterKnown: false, asked: 0, answered: 0 } };
		}
		const rosterCall = await routerClient.callTool("list_gateways", {});
		// callTool never rejects; a timeout or refusal arrives as `error`. Without this read, a
		// failed roster and an empty one are the same value.
		if (rosterCall.error) {
			console.warn(`[discover] roster unknown: ${rosterCall.error}`);
			return { teams: local, coverage: { rosterKnown: false, asked: 0, answered: 0 } };
		}
		const roster = (rosterCall.result as { gateways?: { gatewayId: string }[] } | undefined)?.gateways ?? [];
		const sameDomain = await Promise.all(
			roster.map(async (h) => {
				const r = await relayListTeams(h.gatewayId);
				if (!r.ok) {
					console.warn(`[discover] "${h.gatewayId}" contributed nothing: ${r.error}`);
					unreachable.push(h.gatewayId);
				}
				return r.ok ? r.teams : [];
			}),
		);
		// Cross-Domain leg: query each linked peer for its shared sessions. The returned
		// TeamInfo carries the peer's own gatewayId, which the send path resolves back to the
		// peer's Domain via crossDomainPeers (the SealTarget's separate domainId field, per the
		// Addressing decision - the Domain is resolved from the peer's gatewayId, not parsed from the session address). One
		// gateway is queried once even if a Domain runs several gateways, keyed by its
		// (domainId, gatewayId) pair (a gateway id is unique within a Domain).
		const peers = crossDomainPeers?.all() ?? [];
		const seenPeerGateways = new Set<string>();
		const crossDomain = await Promise.all(
			peers.map(async (peer) => {
				const key = `${peer.friendDomainId}/${peer.friendGatewayId}`;
				if (seenPeerGateways.has(key)) return [] as TeamInfo[];
				seenPeerGateways.add(key);
				const r = await relayListTeams(peer.friendGatewayId);
				if (!r.ok) {
					console.warn(`[discover] linked peer "${key}" contributed nothing: ${r.error}`);
					unreachablePeers.push(key);
					return [] as TeamInfo[];
				}
				// Tag each shared session with the peer's Domain id (authoritative HERE: this
				// Gateway knows which Domain it linked, while a friend on an older build might
				// stamp none). The (domainId, gatewayId) pair is what the console groups by and
				// the send path resolves the seal target from, since a gateway id collides
				// across Domains. The peer's own displayName rides through the spread, so Peers
				// display the friend's name.
				return r.teams.map((t) => ({ ...t, domainId: peer.friendDomainId }));
			}),
		);
		const asked = roster.length + seenPeerGateways.size;
		const coverage: DiscoverCoverage = {
			rosterKnown: true,
			asked,
			answered: asked - unreachable.length - unreachablePeers.length,
			...(unreachable.length ? { unreachable } : {}),
			...(unreachablePeers.length ? { unreachablePeers } : {}),
		};
		return { teams: [...local, ...sameDomain.flat(), ...crossDomain.flat()], coverage };
	}

	/** HTTP wrapper. The bare array is the legacy shape older plugins parse; `?coverage=1` opts into
	 * the object form. Carries this Gateway's own identity so the caller can tell ITS row from a
	 * same-named session on another machine. */
	async function discover(url?: URL): Promise<Response> {
		const full = await discoverFull();
		if (url?.searchParams.get("coverage") === "1") {
			return jsonResponse({ ...full, localGatewayId, localDomainId: localDomain });
		}
		return jsonResponse(full.teams);
	}

	/**
	 * 403 when a caller names a sender it cannot prove it is.
	 *
	 * `from` is stamped verbatim onto the message the recipient reads, so a name this gate cannot
	 * resolve is refused rather than waved through: a near-miss spelling (a trailing space, a
	 * differing case) renders identically to the victim's name at the far end while resolving to no
	 * record here. The only names that pass unproven are ones that resolve to a local session with
	 * no armed binding, which is what keeps hand-launched sessions and a purged store working.
	 */
	/**
	 * Has this caller proved it is one of THIS gateway's own sessions?
	 *
	 * The question every owner-scoped door asks, since a session NAME proves nothing on its own: an
	 * unregistered name resolves to UNBOUND, which anything satisfies (see CallerScope). True while
	 * no session is bound at all, matching the byte plane's own posture - a gateway with no
	 * credential to demand cannot demand one without refusing every legitimate caller it has.
	 */
	function provedLocalSession(req: Request): boolean {
		return !auth || auth.mayUseLocalPlane(presentedByRequest(req));
	}

	function refuseImpersonation(req: Request, claimed: string, scope: CallerScope): Response | null {
		if (!auth) return null;
		// Owner data is not addressed to a session, so naming one proves nothing about the right to
		// read or write it: an unregistered name resolves to UNBOUND, which anything satisfies. Ask
		// the local-plane question first, so an unproven caller learns nothing about which names exist.
		if (scope === "owner-data" && !provedLocalSession(req)) {
			console.warn(`[auth] refused an owner-data call claiming "${claimed}" without any session binding`);
			return jsonResponse({ error: "the owner's own data is not open to this caller" }, 403);
		}
		const key = auth.localTeamKey(claimed);
		if (key === null) {
			// Malformed rather than unauthorized: the name cannot denote any session here, so the
			// caller gets the same 400 an unparseable field has always produced. Still a refusal, which
			// is the security-relevant part - `from` reaches the recipient verbatim, so a name that
			// resolves to nothing must not be waved through just because it matched no record.
			return jsonResponse({ error: `Invalid sender: "${claimed}" does not name a local session` }, 400);
		}
		if (auth.satisfies(auth.toClaim(key), presentedByRequest(req))) return null;
		console.warn(`[auth] refused a call claiming "${claimed}" without its binding`);
		return jsonResponse({ error: "sender is not this caller's session" }, 403);
	}

	/**
	 * 403 when someone other than the session a job is addressed to tries to answer it.
	 *
	 * A job addressed to a REMOTE session is refused outright: a remote team's reply only ever
	 * arrives over the sealed response_push relay, never over local HTTP, so nothing legitimate
	 * needs this door.
	 */
	function refuseForeignReply(req: Request, target: string): Response | null {
		if (!auth) return null;
		const key = auth.localTeamKey(target);
		if (key === null) {
			console.warn(`[auth] refused a local reply to "${target}", which is not a local session`);
			return jsonResponse({ error: "reply target is not a local session" }, 403);
		}
		if (auth.satisfies(auth.toActFor(key), presentedByRequest(req))) return null;
		console.warn(`[auth] refused a reply addressed to "${target}" from another session`);
		return jsonResponse({ error: "reply is not from this conversation's session" }, 403);
	}

	/**
	 * 403 when someone other than the session that asked tries to read a job's answer. Mirror of
	 * `refuseForeignReply`, which decides who may answer one.
	 *
	 * A remote asker collects over the sealed response_push relay, never over local HTTP, so its job
	 * is refused here outright.
	 */
	function refuseForeignPoll(req: Request, sessionId: string): Response | null {
		if (!auth) return null;
		const asker = store.askerOf(sessionId);
		// An unknown id is the caller's own 404 to receive, not a refusal.
		if (asker === undefined) return null;
		const key = auth.localTeamKey(asker);
		if (key === null) {
			console.warn(`[auth] refused a local poll of a job asked by "${asker}", which is not a local session`);
			return jsonResponse({ error: "this job's answer is not collected over local HTTP" }, 403);
		}
		if (auth.satisfies(auth.toActFor(key), presentedByRequest(req))) return null;
		// The SAME body and status an id that names nothing gets: an unproven caller must not be able
		// to tell a live job from a dead id. This per-job answer replaced a machine-wide pre-check that
		// refused an unbound session the job IT created (issue #252): an unbound asker resolves to
		// UNBOUND, which its own tokenless poll satisfies, while a bound session's job still demands
		// the binding.
		console.warn(`[auth] refused a poll of a job asked by "${asker}" from another session`);
		return jsonResponse({ error: `No pending job for session_id "${sessionId}"` }, 404);
	}

	async function send(
		req: Request,
		body: Record<string, unknown>,
		opts: { trustedInbound?: boolean; consoleSender?: boolean } = {},
	): Promise<Response> {
		const parsed = SendRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const {
			from,
			fromConversationId,
			to,
			targetDomainId: targetDomain,
			body: msgBody,
			files: rawSendFiles,
			channelOnly,
			displayLabel,
		} = parsed.data;
		// Same rule as respond: only a local agent's own upload gets this Gateway's stamp.
		const files =
			rawSendFiles &&
			(opts.trustedInbound || opts.consoleSender ? rawSendFiles : stampBlobHolder(rawSendFiles, localGatewayId));
		// Only a real external caller is gated. A federated relay speaks for a remote sender, and the
		// console's `from` is its free-form Device Name rather than a session name, so neither can be
		// resolved to a local record and both arrive already authenticated by their own sealed path.
		if (!opts.trustedInbound && !opts.consoleSender) {
			const refused = refuseImpersonation(req, from, "session");
			if (refused) return refused;
			// fromConversationId decides where the eventual REPLY lands, so naming someone else's is
			// strictly stronger than mislabelling a message: it injects the answer into that session's
			// context as though it had asked. A conversation held by a bound socket therefore belongs
			// to that socket alone; an unheld or unbound one stays open, which is what keeps console
			// sends (owner-keyed, no socket) and hand-launched sessions working.
			const holder = fromConversationId ? conversationRegistry.get(fromConversationId) : undefined;
			if (auth && !auth.satisfies(auth.toAnswerFor(holder), presentedByRequest(req))) {
				console.warn(`[auth] refused a send claiming another session's conversation`);
				return jsonResponse({ error: "conversation is not this caller's" }, 403);
			}
		}
		// The federated-inbound-only fields are honored ONLY when the call comes from the trusted
		// internal gateway-relay path (opts.trustedInbound). An external HTTP /send caller cannot set
		// them - they are structurally seal-sourced - so a local caller can never forge a cross-Domain
		// `dstDomainId` binding (the keystone the response_push hard-deny rests on), nor pin the channel
		// job key / skip arity classification via a crafted `sessionId`. `targetDomainId` stays
		// caller-supplied: it is a routing HINT resolved via crossDomainPeers, never a trust input.
		const trustedInbound = opts.trustedInbound === true;
		const inboundSessionId = trustedInbound ? parsed.data.sessionId : undefined;
		const returnRoute = trustedInbound ? parsed.data.returnRoute : undefined;
		const dstDomainId = trustedInbound ? parsed.data.dstDomainId : undefined;

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

		// Classify the target by arity. An INBOUND federated send (the gateway-relay handler) arrives
		// with a bare local `to` plus an explicit sessionId, so it skips classification and lands
		// locally. A spawn-point (arity 1/3) is not an addressable session - fail fast.
		const parsedTarget = inboundSessionId ? null : parseTarget(to, localDomain, localGatewayId);
		if (parsedTarget instanceof SpawnPoint) {
			return jsonResponse(
				{ error: `"${to}" is a spawn-point, not a session; address a session as spawn.session` },
				400,
			);
		}
		// Cross-Gateway OUTBOUND: an Address whose (domain, gateway) is not ours routes through the
		// Router. The local-collapse rule keeps an our-(domain,gateway) target local.
		if (parsedTarget && (parsedTarget.domain !== localDomain || parsedTarget.gateway !== localGatewayId)) {
			const realDomain =
				parsedTarget.domain !== localDomain && parsedTarget.domain !== LOCAL_DOMAIN_SENTINEL
					? parsedTarget.domain
					: targetDomain;
			return await sendCrossGateway({
				targetGateway: parsedTarget.gateway,
				targetName: composeSessionName(parsedTarget.spawn, parsedTarget.session),
				targetDomain: realDomain,
				from,
				// A console send carries a non-slug Device Name as `from`; build its sender address from
				// the owner id instead. For a console send fromConversationId IS the slug owner id (the
				// shared inbox key), not a device conversation id. An agent send leaves fromAddress unset.
				fromAddress:
					opts.consoleSender && fromConversationId
						? consoleSelfAddress(fromConversationId).canonical
						: undefined,
				fromConversationId,
				body: msgBody,
				files,
				displayLabel,
			});
		}

		// Resolve the target to a local registry name + its canonical Address. A local target
		// resolves here; a remote one took the cross-Gateway branch above.
		let target = resolveLocalTarget(to);
		if (!target) {
			return jsonResponse({ error: `Gateway for "${to}" is not reachable from this Gateway` }, 404);
		}
		let localName = target.name;
		let qualifiedTo = target.address.canonical;

		// The headless "host" daemon is never a direct crosstalk target (it carries no agent).
		if (localName === "host") {
			return jsonResponse(
				{
					error: `"${localName}" is a reserved name; crosstalk_send targets container teams only.`,
				},
				400,
			);
		}

		// Resolve the live incarnation serving this record: its canonical pane, else an alias
		// re-incarnation stamped as liveTeam. A send delivers to whichever is live, so a manual
		// `claude --resume` under a different name still receives sends addressed to the record.
		let targetWs = resolveLiveIncarnation(registry, sessionStore, localName);

		// If offline, attempt to wake the container - or, for a target with no record yet, create it.
		if (!targetWs) {
			// A retry sharing the same (sender conversation, resolved target) provenance reattaches to
			// its own prior mint instead of minting a second session. Keyed on localName (the already-
			// resolved canonical spawn.session), never the caller's raw `to` - the same local target can
			// be legally spelled two ways (a short local form and a self-qualified domain.gateway.spawn.session
			// form), and keying on the raw spelling would let two retries of the identical target mint
			// twice. A federated inbound send already has exactly this provenance in inboundSessionId (the
			// origin's own channel job key); a local caller cannot set that field itself, so it always
			// falls back to composing one from its own request.
			const mintedFrom =
				inboundSessionId ?? (fromConversationId ? `${fromConversationId}:${localName}` : undefined);
			const woken = await tryWakeTeam(localName, { displayLabel, mintedFrom });
			if (!woken.ok && woken.error) {
				return jsonResponse({ error: woken.error }, 404);
			}
			if (woken.ok) {
				// Minting (no existing record, a displayLabel was set) lands on a fresh id, never the
				// one typed - switch to addressing that for everything downstream of this wake.
				if (woken.resolvedTeam && woken.resolvedTeam !== localName) {
					localName = woken.resolvedTeam;
					const resolved = tryLocalAddress(localName);
					if (resolved) {
						target = { name: localName, address: resolved };
						qualifiedTo = resolved.canonical;
					}
				}
				// Claude Code needs time after MCP connect to initialize its channel listener.
				// Registration happens instantly but channel notifications aren't ready yet.
				await new Promise((r) => setTimeout(r, POST_WAKE_SETTLE_MS));
				targetWs = resolveLiveIncarnation(registry, sessionStore, localName);
			}
		}

		// Deliver to the resolved incarnation's own team subs (localName for a canonical pane, the
		// alias team for a re-incarnation).
		const subs = targetWs ? registry.get(targetWs.data.teamName ?? localName) : undefined;
		if (!targetWs || !subs) {
			return jsonResponse(
				{
					error: `Team "${qualifiedTo}" is not connected`,
					available: [...registry.keys()]
						.filter((k) => k !== "host")
						.map((k) => tryLocalAddress(k)?.canonical)
						.filter((c): c is string => c != null),
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
						? storeKey({ kind: "conv", conversationId: fromConversationId, address: target.address })
						: null);
				if (!channelJobId) {
					return jsonResponse({ error: `fromConversationId is required for channel-mode targets` }, 400);
				}

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

				const channelPayload: Record<string, unknown> = {
					type: "channel_push",
					from,
					body: msgBody || "",
					session_id: channelJobId,
				};
				// message_id is the file-materialization bucket key, read only when files are present.
				// Mint it (and send it) only then; a fileless send carries no message_id.
				const hasFiles = files !== undefined && files.length > 0;
				const messageId = hasFiles ? crypto.randomUUID() : undefined;
				if (hasFiles) {
					channelPayload.message_id = messageId;
					channelPayload.files = files;
				}
				const payload = JSON.stringify(channelPayload);

				const activeWs = getAllActiveWs(subs);
				if (activeWs.length === 0) {
					throw new Error(`Team "${qualifiedTo}" has no active connections`);
				}

				for (const ws of activeWs) {
					// An unconfirmed recipient gets its still-pending handshake re-pushed AHEAD of the
					// message, so the agent answers the handshake first and its reply never burns a turn
					// on the reply gate's 409. Delivery itself is never gated on confirmation - the nudge
					// rides alongside. repushHandshake's own dedupe window keeps a freshly-minted
					// handshake (a just-woken session) from being duplicated here - which requires that
					// window to stay well ABOVE the post-wake settle delay below, since a wake registers
					// the session (minting the handshake) and then lands here one settle later.
					if (!ws.data.handshakeConfirmed && ws.data.teamName) {
						repushHandshake?.(ws.data.teamName, ws.data.subId);
					}
					ws.send(payload);
				}

				console.log(
					`[send] channel_push to ${qualifiedTo} [${channelJobId}]${messageId ? ` msg=${messageId.slice(0, 8)}` : ""} from ${from} (${activeWs.length} sub-session${activeWs.length > 1 ? "s" : ""})`,
				);

				// Mirror agent-to-agent traffic into the owner's console, tagged under each LOCAL
				// participant's own thread. Never for a console sender (opts.consoleSender). The
				// `!virtual` check is defense-in-depth, not independently reachable today: targetWs is
				// always resolveLiveIncarnation's result, which already excludes virtual (console) peers
				// on every resolution path (see websocket.ts), so a console can never be targetWs here.
				if (targetWs && !targetWs.data.virtual) {
					const toAddr = target.address;
					if (inboundSessionId) {
						// Federated inbound landing: only the local target is ours to mirror. `from` here
						// is already the remote origin's canonical address (set verbatim by the origin
						// gateway), not a local team field.
						mirrorPeer(toAddr, from, toAddr.canonical, { body: msgBody, files });
					} else if (!opts.consoleSender) {
						// A malformed `from` (never slug-validated at the SendRequestSchema boundary) must
						// not turn an already-delivered channel_push into a spurious 500 for the caller.
						const fromAddr = tryLocalAddress(from);
						if (fromAddr && provedLocalSession(req)) {
							mirrorPeer(fromAddr, fromAddr.canonical, toAddr.canonical, { body: msgBody, files });
							mirrorPeer(toAddr, fromAddr.canonical, toAddr.canonical, { body: msgBody, files });
						}
					}
				}

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

		// Unreachable: targetMode is the single-value `channel` literal, so the block above always
		// returns. Retained as the function's fall-through return (TS does not narrow it to never).
		return jsonResponse({ error: "unsupported connection mode" }, 400);
	}

	function respond(
		req: Request,
		body: Record<string, unknown>,
		// Unlike send(), respond() never needs to tell "trusted federated relay" apart from a
		// plain call: its cross-Gateway behavior is already driven by the job's own recorded
		// returnRoute/dstDomainId and the respond session id's own address, not a live flag.
		// onFederatedSettled fires once the cross-Gateway reply-pin relay actually resolves
		// (success or exhausted retries) - respond() itself returns long before that, so a
		// caller needing to know the TRUE outcome (durable op idempotency) cannot use the
		// Response alone.
		opts: { consoleSender?: boolean; trustedInbound?: boolean; onFederatedSettled?: (ok: boolean) => void } = {},
	): Response {
		const parsed = RespondBodySchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}

		const { session_id: respondSessionId, replyAsJson, files: rawFiles, ...rest } = parsed.data;
		// Stamp this Gateway as the holder, but only for a LOCAL agent: it uploaded its bytes here and
		// posts the message here, so this is the one point that knows both facts at once, which is why
		// an agent never has to learn its own Gateway id. A relayed message already carries its
		// origin's stamp and the console carries its own, so neither may be overwritten with ours.
		const files =
			rawFiles &&
			(opts.trustedInbound || opts.consoleSender ? rawFiles : stampBlobHolder(rawFiles, localGatewayId));

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

		// Check if this is a handshake response (handshakes never carry files). The caller's own
		// launcher-delivered binding rides the header, so the resolver can require that only the
		// challenged session answers its own handshake. A console-relayed respond arrives in-process
		// with no header and answers no handshake, so it is unaffected.
		const responderToken = presentedByRequest(req);
		if (
			resolveHandshake?.(respondSessionId, replyAsJson ?? undefined, rest.response ?? undefined, responderToken)
		) {
			return jsonResponse({ delivered: true, handshake: true });
		}

		// Nothing can ENFORCE no-reply, so a reply that comes anyway would miss at store.deliver and
		// reach the agent as a 404 for doing nothing wrong. Gated on there being NO job: a federated
		// peer names its own return-route key, so the prefix alone would let it park a real job here
		// and have this swallow the answer while the agent is told it was sent.
		if (isNoAckSessionId(respondSessionId) && !store.has(respondSessionId)) {
			return jsonResponse({ delivered: true, noAck: true });
		}

		// This reply isn't itself resolving a handshake - but if the CALLER's own bridge handshake is
		// still unconfirmed, bounce it rather than silently deliver: without this, a session that
		// answers a real conversation before its own handshake sits confirmed-looking on the board
		// (messages flowing) while actually still "verifying". Fails open whenever the caller can't be
		// identified as a live, unconfirmed, actually-pending socket - a registry miss, a virtual/console
		// peer, or an unconfirmed socket with no pending entry (its challenge was already consumed by a
		// dead connection, so there is nothing to name) all deliver normally rather than block.
		if (rest.conversationId) {
			const callerWs = conversationRegistry.get(rest.conversationId);
			if (callerWs && callerWs.readyState === 1 && !callerWs.data.virtual && !callerWs.data.handshakeConfirmed) {
				const team = callerWs.data.teamName;
				const pendingHsId = team && findPendingHandshake?.(team, callerWs.data.subId);
				// Deliberately does not name the pending hs-* id: conversationId is not secret (it rides
				// verbatim in every session_id this caller has ever seen), so echoing the id here would let
				// anyone who merely knows a victim's conversationId learn its live handshake id and replay it
				// against /respond to forge or evict that victim's session. A legitimate self-caller already
				// has its own pending id from the original handshake push, so it needs no reminder here.
				if (team && pendingHsId) {
					// Re-push the handshake before bouncing: the caller may have lost the original
					// notification (dropped, batched behind other messages, or aged out of a compacted
					// context) and so has no id left to answer with. A fresh push gives it another chance;
					// "capped" means repeated pushes already went unanswered, so say so plainly instead of
					// repeating the same instruction forever; "socket-gone" means the re-push itself could
					// not be delivered, so the standing instruction to answer it would be misleading.
					const outcome = repushHandshake?.(team, callerWs.data.subId);
					const error =
						outcome === "capped"
							? "Your bridge handshake is still unconfirmed after repeated prompts. This session may be stale or lagging a version behind - consider restarting it."
							: outcome === "socket-gone"
								? "Your bridge handshake could not be re-delivered. Try again shortly."
								: "Your bridge handshake is still pending. Reply to the handshake session first with channel_reply_structured, then resend this reply.";
					return jsonResponse({ error }, 409);
				}
			}
		}

		// If JSON reply provided but no explicit response string, pretty-stringify for text consumers
		const response: ResponsePayload = {
			session_id: respondSessionId,
			status: rest.status as ResponsePayload["status"] | undefined,
			response: rest.response,
			...pickTiers(rest),
			question: rest.question,
			reason: rest.reason,
			estimated_minutes: rest.estimated_minutes,
			what_to_decide: rest.what_to_decide,
			message: rest.message,
		};
		// The STORE keeps names, never a way to get the bytes. `/poll` reads this copy and authorizes
		// nothing, and a channel entry is persistent and never swept, so whatever is written here is
		// readable indefinitely by anyone who can reach the port. A blobId is not metadata: it is a
		// bearer token for the content, since `/blob/get` will hand the bytes to whoever names them.
		// The live push and the mailbox below carry the full record over authenticated paths.
		if (files && files.length > 0) response.files = stripFileRefs(files);
		if (replyAsJson) {
			response.replyAsJson = replyAsJson;
			if (!response.response) {
				response.response = JSON.stringify(replyAsJson, null, 2);
			}
		}

		// A reply may only come from the session the job is addressed to: the id is a pure function of
		// two non-secret values, so anyone who has exchanged one message can compute it and would
		// otherwise be able to answer as that session indefinitely.
		const jobTarget = store.targetOf(respondSessionId);
		if (jobTarget && !opts.consoleSender && !opts.trustedInbound) {
			const refused = refuseForeignReply(req, jobTarget);
			if (refused) return refused;
		}

		// The respond session_id is the opaque store key the agent echoes verbatim; under the
		// fully-qualified grammar there is no bare form to normalize, so deliver against it directly.
		const deliverResult = store.deliver(respondSessionId, response);
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
			// landed must have its in-flight reply DROPPED, not relayed back to the origin. The share state is the
			// same source the inbound op gate reads, so an un-share bites every direction without
			// the Router. The session target is the canonical domain.gateway.spawn.session parsed from the job's own
			// (origin-set) session key, the form the share is keyed by. A same-Domain federated reply
			// (dstDomainId null) skips the gate, unchanged.
			if (deliverResult.dstDomainId) {
				const pinned = parseStoreKey(rr.srcSession);
				const sessionTarget = pinned?.kind === "conv" ? pinned.address.canonical : undefined;
				if (!sessionTarget || !isSharedToForReply?.(sessionTarget, deliverResult.dstDomainId)) {
					console.log(
						`[respond] ${respondSessionId} DROPPED: session no longer shared to Domain "${deliverResult.dstDomainId}"`,
					);
					return jsonResponse({ delivered: false, dropped: "unshared" });
				}
			}
			const relayOutcome = relayWithRetry(
				rr.srcGateway,
				{
					kind: "response_push",
					session_id: rr.srcSession,
					...(response.status ? { status: response.status } : {}),
					...(response.response ? { response: response.response } : {}),
					...pickTiers(response),
					...(response.replyAsJson ? { replyAsJson: response.replyAsJson } : {}),
					...(response.question ? { question: response.question } : {}),
					...(response.reason ? { reason: response.reason } : {}),
					...(files && files.length > 0 ? { files } : {}),
				},
				"cross-Gateway reply-pin",
			);
			if (opts.onFederatedSettled) {
				void relayOutcome.then((r) => opts.onFederatedSettled?.(r.ok));
			}
			console.log(`[respond] ${respondSessionId} pinned to Gateway ${rr.srcGateway} via the Router`);
			// Mirror the LOCAL responder's own thread. Never for the console itself (opts.consoleSender) -
			// a slug-shaped Device Name could in principle register and land a returnRoute job on itself.
			const localAddr = opts.consoleSender ? null : tryLocalAddress(deliverResult.to);
			if (localAddr && provedLocalSession(req)) {
				mirrorPeer(localAddr, localAddr.canonical, deliverResult.from, {
					body: response.response,
					files,
					status: response.status,
					...pickTiers(response),
				});
			}
			return jsonResponse({ delivered: true, federated: true });
		}

		// Push response back to the sender. For conversation-routed sends we target the
		// specific sub-session via conversationRegistry so parallel host windows don't
		// all receive each other's replies. Fall back to team broadcast when the entry
		// has no conversation id.
		const push: ResponsePushPayload = {
			type: "response_push",
			session_id: respondSessionId,
			response: response.response,
		};
		if (response.status) push.status = response.status;
		// The push carries the full bytes; the store kept metadata only. message_id is the
		// materialization bucket key, minted only alongside files as on the send path.
		if (files && files.length > 0) {
			push.files = files;
			push.message_id = crypto.randomUUID();
		}
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
				const entry = {
					kind: "reply" as const,
					session_id: respondSessionId,
					body: response.response,
					...pickTiers(response),
					status: response.status,
					files: files && files.length > 0 ? files : undefined,
				};
				mailbox.append(entry);
				// This direct append is the PRIMARY console-reply path (the ConsolePeer is only a wake
				// hint), so the convergence relay must ride here too - hooking the peer alone left a
				// reply from a remote-held conversation in a mailbox the console never polls.
				void fanOutConsolePush(entry, crypto.randomUUID());
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
				// Mirror agent-to-agent traffic (no mailbox above means the original asker has no
				// console inbox, so it's a real agent; never for the console itself replying, opts.
				// consoleSender). Discriminate a genuinely local reply from this gateway completing its
				// own cross-Gateway origin anchor: the anchor's own session key embeds the REMOTE
				// target's address, never a local one.
				const askerAddr = opts.consoleSender ? null : tryLocalAddress(deliverResult.from);
				if (askerAddr && provedLocalSession(req)) {
					const key = parseStoreKey(respondSessionId);
					const isRemoteAnchor =
						key?.kind === "conv" &&
						(key.address.gateway !== localGatewayId || key.address.domain !== localDomain);
					const mirrorPayload = {
						body: response.response,
						files,
						status: response.status,
						...pickTiers(response),
					};
					// This message is the REPLY: the replier speaks, the original asker receives - the
					// mirror's from/to must reflect that direction, not the original ask's.
					if (isRemoteAnchor) {
						// deliverResult.to is already the remote replier's canonical address here
						// (sendCrossGateway's own anchor records qualifiedTo, not a bare team name).
						mirrorPeer(askerAddr, deliverResult.to, askerAddr.canonical, mirrorPayload);
					} else {
						const replierAddr = tryLocalAddress(deliverResult.to);
						if (replierAddr) {
							mirrorPeer(askerAddr, replierAddr.canonical, askerAddr.canonical, mirrorPayload);
							mirrorPeer(replierAddr, replierAddr.canonical, askerAddr.canonical, mirrorPayload);
						}
					}
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

		// Before the read, since a persistent entry is not consumed and would keep paying out.
		const refused = refuseForeignPoll(req, session_id);
		if (refused) return refused;

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
			router_connected: routerClient?.isConnected() ?? false,
			// Distinct from connected: a refused register leaves the socket open.
			router_registered: routerClient?.isRegistered() ?? false,
		});
	}

	/** The one task-board route behind all six taskBoard* tools. `from` (hardcoded MCP-side) is both
	 * the impersonation gate's claim and the only scoping key, so a session touches the backlog plus
	 * its own entries and nothing else. A refusal answers 200 with `applied:false` + `refused` (a
	 * normal outcome the tool relays); non-200 is reserved for transport, auth and validation. A
	 * multi-field update applies field-by-field and reports the first refusal - each field was its
	 * own absolute intent, so what landed before it stays. */
	/**
	 * What an agent sees of an entry: its attachments as FILENAMES only.
	 *
	 * Without this projection the list route returns the store's entries verbatim, so any field that
	 * later lands on the BoardEntry schema (e.g. `blobId`, `blobGateway`) reaches every visible session
	 * with no code change and no review step. A blobId is a bearer token, and this is the only place an
	 * agent could otherwise obtain one: ids are content digests and no enumeration op exists. The
	 * plumbing lives on the `attachments` action instead, which the tool handler calls and whose answer
	 * never reaches the model's context.
	 */
	function projectForAgent(entry: BoardEntry): AgentBoardEntry {
		if (!entry.attachments) return entry;
		const attachments = entry.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size }));
		return { ...entry, attachments };
	}

	function taskBoard(req: Request, body: Record<string, unknown>): Response {
		const parsed = BoardRouteRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const r = parsed.data;
		const refused = refuseImpersonation(req, r.from, "owner-data");
		if (refused) return refused;
		// Replay before anything else. These writes are ABSOLUTE, so re-running one after a newer
		// write regresses the field - an update whose reply was lost would set the value back on
		// retry, and routerPost retries four times. Keyed per sender so two sessions cannot collide,
		// and only after impersonation is refused, or an unauthenticated caller could read a reply.
		const replayKey = r.operationId ? `${r.from}:${r.operationId}` : undefined;
		const recorded = replayKey ? boardOperationReplies.get(replayKey) : undefined;
		if (recorded) return jsonResponse(recorded);
		if (!boardStore) return jsonResponse({ error: "task board is not enabled on this gateway" }, 503);
		const owner = ownerId?.();
		if (!owner) return jsonResponse({ error: "not yet enrolled; no owner board exists" }, 503);
		// refuseImpersonation already resolved the name when auth is wired; the bare fallback only
		// exists for authless harnesses.
		const sessionKey = auth ? auth.localTeamKey(r.from) : r.from;
		if (!sessionKey) return jsonResponse({ error: `invalid session name "${r.from}"` }, 400);
		// A session's authority, carried into every write so the STORE decides scope. An agent is
		// never the owner here: reassigning and untrashing stay owner-only, through the console.
		const actor: BoardActor = { kind: "session", sessionId: sessionKey };

		// The one exit for a settled outcome, so every one of them is recorded for replay. A 400 goes
		// through jsonResponse directly: a malformed request is not an operation that happened.
		const done = (bodyOut: Record<string, unknown>): Response => {
			if (replayKey) {
				boardOperationReplies.set(replayKey, bodyOut);
				capFifo(boardOperationReplies, MAX_BOARD_REPLIES);
			}
			return jsonResponse(bodyOut);
		};

		// BoardResult, not a widened `refused: string`: the refusal vocabulary is the one signal that
		// discards an owner's edit, so a route may only relay a member of it.
		const answer = (result: BoardResult, extra?: Record<string, unknown>) =>
			result.applied
				? done({ applied: true, ...extra, ...(result.cascaded ? { cascaded: result.cascaded } : {}) })
				: done({ applied: false, refused: result.refused });

		switch (r.action) {
			case "list": {
				const scope = r.scope ?? "all";
				const projection = boardStore.projection(owner);
				const entries = projection.entries
					.filter((e) => {
						if (!visibleTo(e, sessionKey)) return false;
						if (scope === "unclaimed") return e.sessionId === undefined;
						if (scope === "session") return e.sessionId === sessionKey;
						return true;
					})
					.map(projectForAgent);
				// Reads are not recorded: a list re-run is a fresher answer, not a replayed one.
				return jsonResponse({ entries, ...(projection.truncated ? { truncated: true } : {}) });
			}
			case "attachments": {
				// Hop one of a fetch: names to blobIds. Its own action because the list deliberately
				// cannot serve them, and route-side rather than in the plugin because during the
				// gateway-first deploy window an older plugin would relay whole records into an agent's
				// context. Same `visibleTo` gate the list applies, checked here since that filter lives
				// per-case rather than at the route.
				if (!r.id) return jsonResponse({ error: "attachments requires an id" }, 400);
				const entry = boardStore.projection(owner).entries.find((e) => e.id === r.id);
				if (!entry || !visibleTo(entry, sessionKey)) return jsonResponse({ error: "no such entry" }, 404);
				// A read like the list: never recorded, so a re-run cannot replay blobIds for pictures
				// the owner has since swapped.
				return jsonResponse({ attachments: entry.attachments ?? [] });
			}
			case "claim": {
				if (!r.id) return jsonResponse({ error: "claim requires an id" }, 400);
				return answer(boardStore.claim(owner, r.id, sessionKey));
			}
			case "release": {
				if (!r.id) return jsonResponse({ error: "release requires an id" }, 400);
				return answer(boardStore.release(owner, r.id, sessionKey));
			}
			case "create": {
				if (!r.operationId || !r.title || !r.assignTo) {
					return jsonResponse({ error: "create requires operationId, title, and assignTo" }, 400);
				}
				const id = boardEntryIdForOperation(sessionKey, r.operationId);
				// createAtEnd is insert-if-absent and mints inside its own write, so a retried POST
				// neither reverts later edits nor re-ranks, and a refusal cannot leave a rebalance
				// committed behind it.
				return answer(
					boardStore.createAtEnd(
						owner,
						{
							id,
							title: r.title,
							...(typeof r.body === "string" ? { body: r.body } : {}),
							state: "open" as const,
							...(r.parent !== undefined && r.parent !== null ? { parent: r.parent } : {}),
							...(r.assignTo === "self" ? { sessionId: sessionKey } : {}),
						},
						actor,
					),
					{ id },
				);
			}
			case "update": {
				if (!r.id) return jsonResponse({ error: "update requires an id" }, 400);
				// Scope is answered up front, not left to the setters: a request naming no CHANGED
				// field reaches none of them, and would answer applied:true on an entry this session
				// cannot see - a true/entry_missing pair that tells it which ids exist.
				const entry = boardStore.entry(owner, r.id);
				if (!entry) return answer({ applied: false, refused: "entry_missing" });
				const denied = mayWrite(entry, actor);
				if (denied) return answer({ applied: false, refused: denied });
				// One update is several store writes, and either of the last two can cascade. Collected
				// across them so the caller is told about every entry the board moved, not just the last.
				const cascaded: CascadeChange[] = [];
				if (r.title !== undefined) {
					const res = boardStore.setTitle(owner, r.id, r.title, actor);
					if (!res.applied) return answer(res);
				}
				if (r.body !== undefined) {
					const res = boardStore.setBody(owner, r.id, r.body === null ? undefined : r.body, actor);
					if (!res.applied) return answer(res);
				}
				if (r.state !== undefined) {
					const res = boardStore.setState(owner, r.id, r.state, actor);
					if (!res.applied) return answer(res);
					if (res.cascaded) cascaded.push(...res.cascaded);
				}
				if (r.parent !== undefined) {
					const parent = r.parent === null ? undefined : r.parent;
					// An unchanged parent skips placement entirely - a retried update must not re-rank
					// the entry to the end of a group it never left.
					if (parent !== entry.parent) {
						const res = boardStore.setParentAtEnd(owner, r.id, parent, actor);
						if (!res.applied) return answer(res);
						if (res.cascaded) cascaded.push(...res.cascaded);
					}
				}
				return done({ applied: true, ...(cascaded.length > 0 ? { cascaded } : {}) });
			}
			case "clear": {
				return done({ applied: true, cleared: boardStore.clearDone(owner, sessionKey) });
			}
		}
	}

	return {
		pending,
		capabilities,
		teams,
		discover,
		discoverFull,
		send,
		respond,
		poll,
		fetchBlobFromGateway,
		health,
		humanNotify,
		consolePush,
		fanOutConsolePush,
		pluginAction,
		taskBoard,
		presenceForDomain,
		landCrossDomainPresence,
		pushPresenceToDomain,
		pullPresenceFromDomain,
		invalidatePresenceSnapshotCache,
	};
}
