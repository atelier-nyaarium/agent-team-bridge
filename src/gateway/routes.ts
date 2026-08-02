import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { createBurstCache } from "../shared/burst-cache.js";
import type { SealedEnvelope } from "../shared/crypto.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES } from "../shared/evie-protocol.js";
import {
	type ConsolePushEntry,
	type CrossDomainPresenceSession,
	type FederatedOp,
	MAX_CROSSDOMAIN_PRESENCE_SESSIONS,
	ReturnRouteSchema,
} from "../shared/federation-protocol.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "../shared/host-op.js";
import {
	NoticeFull,
	NoticeFullSpoken,
	NoticeSummary,
	type NoticeTierWire,
	NoticeTierWireFields,
	NoticeTitle,
	pickTiers,
} from "../shared/notice.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import { ChannelFilesSchema, TeamInfoSchema } from "../shared/schemas.js";
import {
	Address,
	composeSessionName,
	DEFAULT_SESSION,
	isSlug,
	LOCAL_DOMAIN_SENTINEL,
	parseSessionName,
	parseStoreKey,
	parseTarget,
	SpawnPoint,
	storeKey,
} from "../shared/session-id.js";
import type {
	ChannelFile,
	ConnectionMode,
	GatewayConfig,
	ResponsePayload,
	ResponsePushPayload,
	TeamInfo,
} from "../shared/types.js";
import { type Presented, presentedByRequest, type SessionAuthority } from "./sessionAuthority.js";
import type { VibeCheck } from "./vibeCheck.js";
import type { WakeResult } from "./wake.js";
import {
	type ConversationRegistry,
	getAllActiveWs,
	type HandshakeRepushOutcome,
	resolveLiveIncarnation,
	type TeamRegistry,
	type WsData,
} from "./websocket.js";

////////////////////////////////
//  Interfaces & Types

export interface RoutesDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: PendingJobStore<ResponsePayload>;
	tryWakeTeam: (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => Promise<WakeResult>;
	/** Whether a wake is in flight for a composite team. An asleep record with a wake in flight is
	 * reported as `verifying` (coming up) rather than `available`, so a booting session shows as such
	 * from the moment it is spawned/woken, not only once its MCP registers. */
	isWakeInFlight?: (team: string) => boolean;
	offlineCatalog: Map<string, string>;
	// Durable team -> projectPath map (never cleared, unlike offlineCatalog which
	// empties when the host daemon disconnects). Membership in either marks a team
	// as devcontainer-backed.
	knownTeamPaths: Map<string, string>;
	// The durable session-record store. Used directly by send/respond's live-incarnation
	// resolution; teams() itself defers entirely to `presence.snapshot()` below. Optional for
	// test harnesses with no resume tracking.
	sessionStore?: import("../shared/session-store.js").SessionStore;
	capabilityStore?: Pick<import("./console/capabilityStore.js").CapabilityStore, "snapshot">;
	// The Codex route boundary, constructed with the checked session-resume writer.
	codexAgentService?: import("./codexAgentService.js").CodexAgentService;
	// The presence facade: teams() is exactly `presence.snapshot()`, so a manual GET /teams pull-
	// to-refresh and the poll response's presence plane can never compute two different answers.
	// Optional so a harness testing routes with no presence wiring still gets an empty teams list
	// rather than a throw.
	presence?: { snapshot(): TeamInfo[] };
	// Console mailboxes, for broadcast notices (notify_human). Optional so test
	// harnesses without a console bridge need not supply one.
	mailboxStore?: import("../shared/device-mailbox.js").DeviceMailboxStore;
	config: GatewayConfig;
	evieClient?: import("./evie/evieClient.js").EvieClient | null;
	// E2E seal/open for cross-Gateway frames; absent when federation crypto is off.
	sealer?: import("./federation/sealer.js").Sealer | null;
	/** This Gateway's byte store, for pulling in a blob a peer Gateway holds. Absent in tests that
	 * never move bytes, which makes a cross-Gateway fetch a clean refusal rather than a crash. */
	blobStore?: import("../shared/blob-store.js").BlobStore;
	// The disjoint cross-Domain peer set. A cross-Domain send resolves its target's Domain
	// here (the SealTarget is keyed by the full (domainId, gatewayId) pair, never the bare
	// id), and discovery fans a list_teams to each linked peer. Absent when federation is off.
	crossDomainPeers?: import("./federation/crossDomainPeers.js").CrossDomainPeers | null;
	// The owner's display name (learned from evie's register reply), stamped on
	// every local TeamInfo so a linked friend Domain sees the owner's self-set label over the
	// discovery roster. Absent/null when unset.
	displayName?: (() => string | null | undefined) | null;
	// Whether this Gateway's own Domain is the admin's (the evie-runner who provisions others),
	// learned from the register reply. Stamped on the local TeamInfo so the console shows the
	// admin surfaces only on the admin's own session. Null when unknown (pre-register), mirroring
	// displayName.
	isAdminDomain?: (() => boolean | null) | null;
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
	// un-share bites without evie. Absent when federation sharing is not wired (no recheck).
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
	// The vibe check (AI-managed session descriptions, gateway/vibeCheck.ts): noteInbound counts each
	// message delivered INTO a session toward its next check; resolve intercepts a vc-* answer in
	// respond() exactly the way resolveHandshake intercepts hs-*. Absent in test harnesses.
	vibeCheck?: Pick<VibeCheck, "noteInbound" | "resolve">;
	// The sole resolver of "what must a caller prove to act as X". Absent in test harnesses that do
	// not exercise the identity gates, which then behave as an ungated gateway does.
	auth?: SessionAuthority;
}

const SendRequestSchema = z.object({
	from: z.string(),
	fromConversationId: z.string().regex(CONVERSATION_ID_RE).max(MAX_CONVERSATION_ID_LEN).optional(),
	to: z.string(),
	// The Domain id of a cross-Domain target (a session from a linked friend Domain). A
	// gateway id is unique only within a Domain, so when this is set the seal target is
	// resolved by the full (domainId, gatewayId) pair; absent keeps the local/cross-Gateway
	// (bare gateway id) resolution. Console-supplied from the selected session's Domain.
	targetDomainId: z.string().optional(),
	body: z.string().optional(),
	// Human-readable label for a not-yet-existing target: the gateway mints an opaque id under the
	// addressed spawn and stamps this as its sessionLabel, rather than silently adopting the typed
	// session segment as the id. Ignored when the target already exists.
	displayLabel: z.string().min(1).max(64).optional(),
	session_id: z.string().optional(),
	debug: z.boolean().optional(),
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
	// The MCP process's own stable conversationId (see mcp/bridge/helpers.ts's bridgeConversationId),
	// so respond() can tell whether the CALLER's own bridge handshake is still unconfirmed. Absent
	// from console-originated and federated-relay-originated replies (neither is a channel-mode MCP
	// agent), which intentionally skip the gate this enables.
	conversationId: z.string().regex(CONVERSATION_ID_RE).max(MAX_CONVERSATION_ID_LEN).optional(),
	// Optional notice-style tiers on a reply (title = notification-bar line + shortest spoken
	// tier, summary = medium spoken tier, fullSpoken = what the FULL play tier speaks in the
	// body's place). The console reads them like a notice's; absent on a plain reply.
	...NoticeTierWireFields,
	replyAsJson: z.record(z.string(), z.unknown()).optional(),
	question: z.string().optional(),
	reason: z.string().optional(),
	estimated_minutes: z.number().optional(),
	what_to_decide: z.string().optional(),
	message: z.string().optional(),
	files: ChannelFilesSchema.optional(),
});

// Per-payload total across a message's files, and DERIVED rather than restated: this used to be its
// own 16 MB constant and stayed at 16 MB after the reason for it was deleted, which is exactly the
// drift the single source now prevents. A single file may still use the whole bucket.
//
// Advisory by nature, because it sums sender-stated sizes and nothing re-measures them. The real
// enforcement is per-blob on the write path, where the bytes actually land.
export const MAX_RESPONSE_FILE_BYTES = MAX_BLOB_BYTES;

// How long a send waits after waking a session before delivering: registration is instant, but
// Claude Code's channel listener is not ready yet. Named (not inline) because it is one half of a
// cross-module invariant - HANDSHAKE_REPUSH_DEDUPE_MS must stay above it, or the delivery below
// re-pushes a handshake this very wake just minted. Pinned by a test; see websocket.ts.
export const POST_WAKE_SETTLE_MS = 3_000;

// A plugin-action payload is meant to carry a small, action-specific value (e.g. a filename), never
// bytes - unlike files/attachments, it has no dedicated cap upstream and device-mailbox.ts's own
// entryBytes() does not count it, so this is the only backstop against an oversized or pathologically
// nested payload reaching the mailbox (and the durable-store snapshot written on a timer).
const MAX_PLUGIN_ACTION_PAYLOAD_BYTES = 32_768;

/** The total a payload's files CLAIM to be. Sender-stated and never re-measured here, because the
 * bytes are not here: they travel the blob plane, where the write path counts what actually lands
 * against MAX_BLOB_BYTES. This stays as the cheap sanity check on an obviously absurd manifest, not
 * as the memory backstop it used to be. */
function fileBytes(files: ChannelFile[]): number {
	let n = 0;
	for (const f of files) n += f.size;
	return n;
}

/**
 * Drop the reference that makes a file's bytes fetchable, keeping everything that describes it.
 *
 * For the persistent store only. `blobId` names content to anyone holding it, and the routes that
 * read the store (`/pending` to enumerate, `/poll` to fetch) authorize nobody, so a stored reference
 * is readable content for as long as the entry lives, which for a channel conversation is forever.
 * This is the same boundary the old `stripFileBytes` drew when the bytes were inline; moving them
 * out of band changed what has to be withheld, not whether.
 */
function stripFileRefs(files: ChannelFile[]): ChannelFile[] {
	return files.map(({ blobId: _omit, blobGateway: _also, ...meta }) => meta);
}

/**
 * Record which Gateway holds a file's bytes, for files that do not already say.
 *
 * A blobId names WHAT; without a companion saying WHERE, a message that routes to another Gateway
 * names bytes its receiver cannot reach. Only ever fills a blank: a stamp already present belongs to
 * whoever actually holds the bytes, and overwriting it with ours would point every receiver at a
 * Gateway that never had them.
 */
function stampBlobHolder(files: ChannelFile[], gatewayId: string): ChannelFile[] {
	return files.map((f) => (f.blobId && !f.blobGateway ? { ...f, blobGateway: gatewayId } : f));
}

/** The one measurement of a plugin-action payload's size, so the schema-level check and the
 * consolePush landing-side check (the two enforcement sites) can never independently drift on HOW
 * size is measured, mirroring fileBytes()'s role for MAX_RESPONSE_FILE_BYTES. */
function payloadBytes(payload: Record<string, unknown>): number {
	return JSON.stringify(payload).length;
}

const PollRequestSchema = z.object({
	session_id: z.string(),
});

// title, summary, and full are REQUIRED: a notice must always carry a headline,
// an addressable short tier, and a real body (no ghost pings). Strict: an unknown
// field (e.g. the retired `tiny`) is rejected, not silently stripped. The tier
// bounds come from the notice leaf (the declared single truth), so this route
// cannot drift from the tool boundary; describes are inert server-side. fullSpoken
// is deliberately OPTIONAL here despite being required on the tool schema - the
// strict gateway would otherwise 400 every notice from a not-yet-reloaded plugin
// during a deploy window, where the lenient RespondBodySchema degrades gracefully.
const HumanNotifySchema = z
	.object({
		from: z.string().min(1).max(128),
		title: NoticeTitle,
		summary: NoticeSummary,
		full: NoticeFull,
		fullSpoken: NoticeFullSpoken.optional(),
		files: ChannelFilesSchema.optional(),
	})
	.strict();

// `from` is the ONLY identity field, and it names the CALLING agent's own session (exactly what
// every other agent-originated route already trusts at the same level - see send()'s own `from`;
// this route adds no NEW trust boundary beyond that pre-existing, network-level one, tracked in
// plans/pain-points.md). Strict on purpose: there is no separate "to"/"target"/"team" field
// a caller could add ON TOP OF its own `from` to reach a different conversation than the one `from`
// itself already resolves to - the caller's own resolved address (via localAddress(from)) is the
// only possible target. pluginId/actionType are slug-constrained (matching every other identifier
// that feeds a composite key in this codebase) so a colon inside either half can never collide the
// composite "pluginId:actionType" claim key with a different, distinct pair.
const PluginActionRequestSchema = z
	.object({
		from: z.string().min(1).max(128),
		pluginId: z.string().min(1).max(64).refine(isSlug, "pluginId must be a slug"),
		actionType: z.string().min(1).max(64).refine(isSlug, "actionType must be a slug"),
		payload: z
			.record(z.string(), z.unknown())
			.optional()
			.refine((p) => !p || payloadBytes(p) <= MAX_PLUGIN_ACTION_PAYLOAD_BYTES, {
				message: `payload exceeds ${MAX_PLUGIN_ACTION_PAYLOAD_BYTES} bytes`,
			}),
	})
	.strict();

////////////////////////////////
//  Functions & Helpers

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Get the mode of a team, preferring real sockets over virtual console peers. Every bridge
 * connection is channel mode, so this is effectively always "channel"; kept as the single
 * source the teams listing and the send paths read. */
function getTeamMode(subs: Map<string, ServerWebSocket<WsData>>): ConnectionMode {
	let virtualMode: ConnectionMode | null = null;
	for (const [, ws] of subs) {
		if (!ws.data.virtual) return ws.data.mode;
		virtualMode = virtualMode ?? ws.data.mode;
	}
	return virtualMode ?? "channel";
}

export function createRoutes({
	registry,
	conversationRegistry,
	store,
	capabilityStore,
	tryWakeTeam,
	isWakeInFlight,
	offlineCatalog,
	knownTeamPaths,
	sessionStore,
	presence,
	mailboxStore,
	config,
	evieClient,
	sealer,
	blobStore,
	crossDomainPeers,
	displayName,
	isAdminDomain,
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
	vibeCheck,
}: RoutesDeps) {
	const { localGatewayId, localDomainId } = config;
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

	/** THE single writer of a mailbox append that embeds `dedupeKey` onto the entry (the
	 * MailboxEntrySchema field, carried verbatim through any further relay) AND passes the
	 * identical value as `append()`'s own dedup parameter (DeviceMailbox's seenKeys map) - the
	 * two necessarily-equal uses of one key can never independently drift by going through two
	 * separate call sites. Never throws; swallows and logs under `label`, since every caller of
	 * this (mirrorPeer, consolePush, humanNotify) treats console-mailbox delivery as best-effort. */
	function landMailboxEntry(owner: string, entry: ConsolePushEntry, dedupeKey: string, label: string): boolean {
		if (!mailboxStore) return false;
		try {
			mailboxStore.ensure(owner).append({ ...entry, dedupeKey }, dedupeKey);
			return true;
		} catch (err) {
			console.warn(`[${label}] failed to append entry: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/** Append a "peer" display mirror into this Gateway's own Domain-owner mailbox, tagged under
	 * `threadAddr`'s own thread, then fan the same entry out to every other same-Domain Gateway
	 * (fanOutConsolePush) so it lands wherever the owner's console actually polls. A no-op
	 * pre-enrollment (no owner id) or when the console bridge is off (no mailboxStore) - the
	 * mirror is purely additive display, never load-bearing. */
	function mirrorPeer(
		threadAddr: Address,
		from: string,
		to: string,
		payload: NoticeTierWire & {
			body?: string;
			files?: ChannelFile[];
			status?: string;
		},
		// A stable id lets an at-least-once RELAY of this same already-composed entry (the
		// console_push convergence hop, see fanOutConsolePush) dedupe against the same key on
		// each receiving gateway. It does NOT protect against a caller-level HTTP retry of
		// send()/respond() itself - that gap is pre-existing (the channel_push/response_push it
		// mirrors has no such protection either) and is not solved here. Defaults to a fresh id
		// when no caller has one to give.
		dedupeKey: string = crypto.randomUUID(),
	): void {
		const owner = ownerId?.();
		if (!owner || !mailboxStore) return;
		const entry: ConsolePushEntry = {
			kind: "peer",
			session_id: storeKey({ kind: "conv", conversationId: owner, address: threadAddr }),
			from,
			to,
			...payload,
		};
		// Never load-bearing: a failure here must not turn an already-delivered/already-relayed
		// primary operation into a spurious failure for the caller, so the local outcome is
		// ignored and the fan-out is attempted regardless.
		landMailboxEntry(owner, entry, dedupeKey, "mirror");
		void fanOutConsolePush(entry, dedupeKey);
	}

	/** Land a fully-composed mailbox entry (a peer mirror, a notify_human notice, or a plugin_action
	 * relayed from ANOTHER same-Domain Gateway) onto THIS Gateway's own owner mailbox - the
	 * console_push LANDING side. Idempotent per dedupeKey. Local-append only: this function never
	 * fans out further, so a receiving Gateway can never gossip-loop an entry back out to the mesh
	 * (only fanOutConsolePush calls the relay, and nothing calls it from here). A no-op (not an
	 * error, so the origin's relayWithRetry does not burn retries on it) pre-enrollment, when the
	 * console bridge is off, when the attached files exceed the same byte cap every other
	 * mailbox-writing path enforces (send/respond/humanNotify - this is the only path that lands
	 * relayed-in content rather than a request this Gateway already validated itself), when a
	 * plugin_action payload exceeds its own byte cap, or if the append itself fails - mirroring
	 * mirrorPeer's own "purely additive, never load-bearing" posture. */
	function consolePush(entry: ConsolePushEntry, dedupeKey: string): { delivered: boolean } {
		const owner = ownerId?.();
		if (!owner || !mailboxStore) return { delivered: false };
		if (entry.files && entry.files.length > 0 && fileBytes(entry.files) > MAX_RESPONSE_FILE_BYTES) {
			console.warn(`[console_push] dropped an oversized entry (over ${MAX_RESPONSE_FILE_BYTES} bytes)`);
			return { delivered: false };
		}
		if (entry.payload && payloadBytes(entry.payload) > MAX_PLUGIN_ACTION_PAYLOAD_BYTES) {
			console.warn(
				`[console_push] dropped an oversized plugin_action payload (over ${MAX_PLUGIN_ACTION_PAYLOAD_BYTES} bytes)`,
			);
			return { delivered: false };
		}
		return { delivered: landMailboxEntry(owner, entry, dedupeKey, "console_push") };
	}

	/** Land a linked friend's presence_push - the cross-Domain-presence landing side (mirrors
	 * consolePush's own shape and posture above: local-append only, never fans out further).
	 * `srcDomainId` is the sealer-VERIFIED sender (see gatewayRelay.ts's presence_push case),
	 * never a payload-supplied value. A no-op pre-enrollment or when federation is not wired. */
	function landCrossDomainPresence(srcDomainId: string, sessions: CrossDomainPresenceSession[]): void {
		crossDomainPresenceConsumer?.land(srcDomainId, sessions);
	}

	/** Fan a console-bound entry (already appended locally by the caller) out to every OTHER
	 * same-Domain Gateway, so it lands wherever the owner's console actually polls - not just the
	 * Gateway that composed it. Same-Domain peers are enumerated the same way discover() already
	 * does (evie's list_gateways; no new discovery machinery), filtered through the
	 * locally-mirrored Allowlist where available (a mailbox WRITE deserves the extra check
	 * discover()'s read-only list_teams fan-out doesn't bother with) and self-excluded as cheap
	 * insurance against evie ever including the caller in its own roster. Fire-and-forget with
	 * retry (relayWithRetry); never throws. ORIGIN-ONLY: call this from an origination tap point
	 * (mirrorPeer, humanNotify) alone - never from console_push's own landing case in handleOp, or
	 * an entry would gossip-loop around the mesh forever. */
	async function fanOutConsolePush(entry: ConsolePushEntry, dedupeKey: string): Promise<void> {
		if (!evieClient?.isConnected()) return;
		if (!resolvesLocalGateway) {
			// Not just "no extra check" - trusting evie's roster alone for a mailbox WRITE is a
			// deliberately bigger trust extension than list_teams' read-only fan-out takes, so a
			// missing filter is worth a log, not a silent downgrade.
			console.warn("[console_push] fan-out running with no allowlist filter (resolvesLocalGateway unset)");
		}
		try {
			const rosterCall = await evieClient.callTool("list_gateways", {});
			const roster = (rosterCall.result as { gateways?: { gatewayId: string }[] } | undefined)?.gateways ?? [];
			for (const { gatewayId } of roster) {
				if (gatewayId === localGatewayId) continue;
				if (resolvesLocalGateway && !resolvesLocalGateway(gatewayId)) continue;
				void relayWithRetry(gatewayId, { kind: "console_push", entry, dedupeKey }, "console_push");
			}
		} catch (err) {
			console.warn(
				`[console_push] fan-out roster fetch failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/** Resolve a target Gateway id to a SealTarget, LOCAL-FIRST (mirroring the sealer's own
	 * resolution order). A gateway id the local single-owner allowlist resolves is the
	 * bare-string shorthand and seals v1 - checked BEFORE the cross-Domain scan, so a send to
	 * your OWN local Gateway whose id collides with a friend's gateway id is never hijacked to
	 * the friend. Only a gateway id NOT in the local Domain is matched against the disjoint
	 * cross-Domain peer set: a single peer resolves to an explicit `(domainId, gatewayId)`
	 * SealTarget (v2, the Addressing decision's separate domainId field, never folded into the
	 * id string); a gateway id ambiguous across two friend Domains throws rather than guess. */
	function sealTargetFor(targetGateway: string, targetDomain?: string): import("./federation/sealer.js").SealTarget {
		// Local first: a gateway the local allowlist admits is the bare-string v1 shorthand, so a
		// local/friend gateway-id collision can never route a local send to the friend. A caller
		// that named an explicit cross-Domain target still falls to the cross-Domain resolution
		// below (a friend gateway is never in the local allowlist), so the local check is safe.
		if (resolvesLocalGateway?.(targetGateway)) return targetGateway;
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
		// Neither a known local gateway nor a cross-Domain peer: fall back to the bare string,
		// which the sealer resolves against the local allowlist (and emits v1) or rejects as
		// "not admitted". This preserves the prior behavior when no local predicate is wired.
		return targetGateway;
	}

	/** The resolved target Domain id for a cross-Gateway send, or null for a local /
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
		// Resolve the target to a SealTarget once: a local peer is the bare string (v1); a
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

	/** In-progress cross-Gateway fetches, keyed by blob. Cleared on settle, so this is a coalescer
	 * rather than a cache: a later reader of an absent blob still triggers a fresh attempt. */
	const blobFetches = new Map<string, Promise<boolean>>();

	/**
	 * Pull a whole blob in from the Gateway that holds it, and report whether this Gateway now has it.
	 *
	 * The hop that makes an attachment survive routing. Bytes live on ONE Gateway while the message
	 * naming them routes by its own rules, so a receiver regularly asks a Gateway that never had
	 * them. Rather than teaching every client which Gateway holds what, a client always asks its own
	 * and this fills the gap behind it, caching the result. Content addressing means the cache needs
	 * no invalidation, and a re-fetch of something already held costs one stat.
	 *
	 * Bounded exactly like every other transfer: a range at a time, against MAX_BLOB_BYTES, refusing
	 * a peer whose cursor stops advancing. A failure returns false rather than throwing, because the
	 * caller's next move is to report the file unavailable, not to fail the whole message.
	 */
	function fetchBlobFromGateway(blobId: string, fromGateway: string): Promise<boolean> {
		// Single-flight per blob. A client-facing door now initiates outbound mesh traffic, and while
		// the bytes are absent every request re-enters here, so concurrent readers of one attachment
		// would each open their own 16-round-trip relay loop for identical content. They share one.
		const inFlight = blobFetches.get(blobId);
		if (inFlight) return inFlight;
		const started = runBlobFetch(blobId, fromGateway).finally(() => blobFetches.delete(blobId));
		blobFetches.set(blobId, started);
		return started;
	}

	/**
	 * Every Domain a holder's gateway id could mean, most likely first.
	 *
	 * A gateway id defaults to the machine's hostname and duplicates are an anticipated condition
	 * (see GATEWAY_ID in docker-compose.yml), so a friend's `desktop` and my own `desktop` are the
	 * same string. `sealTargetFor` is local-first by deliberate design, which is right for a SEND -
	 * misrouting a message is a disclosure - but wrong for a fetch, where local-first silently asks a
	 * sibling that never held the file.
	 *
	 * So a fetch tries every candidate rather than betting on one. That is safe here and nowhere else
	 * in this file: a blob is named by the digest of its own contents, so a wrong guess cannot return
	 * wrong bytes, only no bytes. Asking is the cheap half; being wrong about who to ask was costing
	 * the attachment entirely.
	 */
	function holderCandidates(fromGateway: string): Array<string | undefined> {
		const domains = (crossDomainPeers?.all() ?? [])
			.filter((p) => p.friendGatewayId === fromGateway)
			.map((p) => p.friendDomainId);
		// Undefined first: the bare form is the local/same-Domain resolution and the common case.
		return [undefined, ...domains];
	}

	async function runBlobFetch(blobId: string, fromGateway: string): Promise<boolean> {
		if (!blobStore || fromGateway === localGatewayId) return false;
		for (const domain of holderCandidates(fromGateway)) {
			if (await fetchBlobFrom(blobId, fromGateway, domain)) return true;
		}
		return false;
	}

	async function fetchBlobFrom(blobId: string, fromGateway: string, fromDomain?: string): Promise<boolean> {
		if (!blobStore) return false;
		let offset = blobStore.stat(blobId).have;
		for (;;) {
			if (offset > MAX_BLOB_BYTES) return false;
			const relay = await relayToGateway(
				fromGateway,
				{ kind: "blob_fetch", blobId, offset, length: BLOB_CHUNK_BYTES },
				fromDomain,
			);
			if (!relay.ok) return false;
			const res = relay.result as { chunk?: string; eof?: boolean } | undefined;
			if (!res) return false;
			const bytes = Buffer.from(res.chunk ?? "", "base64");
			if (bytes.length === 0 && !res.eof) return false;
			const written = blobStore.write(blobId, offset, bytes, !!res.eof);
			if (res.eof) return written.complete;
			if (written.have <= offset) return false;
			offset = written.have;
		}
	}

	/** Relay a cross-Gateway op in the background, retrying on transient failure (evie
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
				// A relay throw (evie disconnect mid-call, call timeout) is just another transient
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
		if (!evieClient?.isConnected()) {
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

	/** What the owner's consoles can render, so a starting session knows which tools to register.
	 * Ungated on purpose: it serves non-secret plugin ids and their own instruction text, and the
	 * hand-launched host window this exists to serve carries no credential to present. */
	function capabilities(): Response {
		return jsonResponse(capabilityStore?.snapshot() ?? { known: false, capabilities: [] });
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

	// presence.snapshot() is domain-INDEPENDENT (an O(local sessions) walk + sort, per
	// presence.ts), but presenceForDomain below is invoked once per linked-and-shared Domain from
	// crossDomainPresence.ts's recomputeAll() - up to MAX_LINKED_DOMAINS_FOR_PRESENCE (500) calls
	// in one fully-synchronous pass triggered by a single, ordinary local presence mutation (any
	// session's working-state flip). createBurstCache makes that whole burst pay for one
	// computation, not one per Domain, while any OTHER, later caller (a plain GET /teams) still
	// gets a fresh one.
	const presenceSnapshotCache = createBurstCache<TeamInfo[]>(() => presence?.snapshot() ?? []);
	function presenceSnapshotForThisTick(): TeamInfo[] {
		return presenceSnapshotCache.get();
	}

	/** Force the next `presenceSnapshotForThisTick()` call to recompute rather than reuse a cached
	 * read. Two genuinely separate local presence mutations (e.g. a reconnect's evict-then-confirm)
	 * can each synchronously trigger their own `recomputeAll()` pass within the SAME tick, before the
	 * microtask that clears the cache ever runs - without this, the second pass would silently
	 * compare against the first pass's now-stale intermediate snapshot and conclude nothing changed.
	 * Called once at the start of every `recomputeAll`/`recomputeDomain` entry (crossDomainPresence.ts)
	 * so each TOP-LEVEL call sees fresh state while still sharing one computation across its own
	 * per-Domain loop. */
	function invalidatePresenceSnapshotCache(): void {
		presenceSnapshotCache.invalidate();
	}

	/** Kind-filter + slug-validate + field-slice one TeamInfo row down to a CrossDomainPresenceSession
	 * - shared by `presenceForDomain` (this Gateway's own outbound rows, still needing its own
	 * `sharesFor` gate on top) and the backstop-pull reconciler (a linked peer's OWN already-shared-
	 * filtered `list_teams` response, needing no further gate). Only devcontainer/loose sessions are
	 * ever shareable (matching `gateCrossDomainTarget`'s own kind check); free-text fields are
	 * truncated - this crosses a cross-Domain trust boundary TeamInfo itself was never scoped for.
	 * `tryLocalAddress`, not the throwing `localAddress`: a row's team name is not always
	 * slug-validated at intake (an ordinary devcontainer directory name can be uppercase, contain an
	 * underscore/space, or exceed 64 chars), so an invalid one is skipped here, never an uncaught
	 * throw. Returns null for a row that fails either check. */
	function toCrossDomainPresenceSession(t: TeamInfo): CrossDomainPresenceSession | null {
		if (t.kind !== "devcontainer" && t.kind !== "loose") return null;
		if (!tryLocalAddress(t.team)) return null;
		return {
			team: t.team,
			gatewayId: t.gatewayId,
			status: t.status,
			kind: t.kind,
			sessionLabel: t.sessionLabel?.slice(0, 64),
			description: t.description?.slice(0, 120),
			lastActive: t.lastActive,
			queueDepth: t.queue_depth,
			working: t.working,
			needsLogin: t.needsLogin,
		};
	}

	/** What Domain `toDomainId` currently sees of this Gateway's own sessions - the exact
	 * `sharesFor` filter gatewayRelay.ts's list_teams case already applies for a PULL, reused
	 * here for the cross-Domain-presence PUSH (see crossDomainPresence.ts's source side). The
	 * underlying local snapshot is cached for the current synchronous tick only (see
	 * presenceSnapshotForThisTick) - never across ticks. */
	function presenceForDomain(toDomainId: string): CrossDomainPresenceSession[] {
		const local = presenceSnapshotForThisTick();
		const shared = new Set(sharesFor?.(toDomainId) ?? []);
		const out: CrossDomainPresenceSession[] = [];
		for (const t of local) {
			if (out.length >= MAX_CROSSDOMAIN_PRESENCE_SESSIONS) break;
			const addr = tryLocalAddress(t.team);
			if (!addr || !shared.has(addr.canonical)) continue;
			const session = toCrossDomainPresenceSession(t);
			if (session) out.push(session);
		}
		return out;
	}

	/** Push this Gateway's current presenceForDomain(toDomainId) content to EVERY gateway linked
	 * peer under that Domain (a Domain may run more than one, mirroring discover()'s own "one
	 * gateway is queried once even if a Domain runs several" fan-out) - a single-shot attempt (no
	 * retry of its own; the caller, crossDomainPresence.ts's coalesced pusher, owns backoff/retry
	 * so the two retry loops never compound). Resolves ok once at least one gateway accepts it;
	 * partial delivery to a Domain's other gateway(s) is not itself a failure. Threads the
	 * explicit dstDomain through relayToGateway's 3-argument form so an ambiguous bare-gateway-id
	 * collision across two different linked Domains can never misroute it. */
	async function pushPresenceToDomain(
		toDomainId: string,
		sessions: CrossDomainPresenceSession[],
	): Promise<{ ok: boolean; error?: string }> {
		const gateways = (crossDomainPeers?.all() ?? [])
			.filter((p) => p.friendDomainId === toDomainId)
			.map((p) => p.friendGatewayId);
		if (gateways.length === 0) return { ok: false, error: `no linked gateway for Domain "${toDomainId}"` };
		const results = await Promise.all(
			gateways.map((g) => relayToGateway(g, { kind: "presence_push", sessions }, toDomainId)),
		);
		const ok = results.some((r) => r.ok);
		return ok ? { ok: true } : { ok: false, error: results[0]?.error };
	}

	/** The shape every `{kind:"list_teams"}` relay reply must match before any caller trusts it as
	 * typed content - capped at `MAX_CROSSDOMAIN_PRESENCE_SESSIONS` as a blanket sanity bound on how
	 * much one reply can cost to process, matching the push path's own wire-level `.max()`. */
	const ListTeamsRelayResultSchema = z.object({
		teams: z.array(TeamInfoSchema).max(MAX_CROSSDOMAIN_PRESENCE_SESSIONS).optional(),
	});

	/** Relay a `{kind:"list_teams"}` call to `dstGateway` and validate the reply against
	 * `ListTeamsRelayResultSchema` before any caller treats it as typed content. `relayToGateway`
	 * itself returns `result` as `unknown` by design (the reply is a PEER's content, not this
	 * process's own), so every caller that reads it as `TeamInfo[]` has to remember to validate it -
	 * this is the one place that discipline lives, rather than being a convention each call site can
	 * separately forget (as `pullPresenceFromDomain` initially did). Resolves `{ok:false}` for either
	 * a relay failure OR a reply that fails validation - a version-skewed or buggy peer omitting a
	 * required field must never land as if it were a legitimate empty answer. */
	async function relayListTeams(
		dstGateway: string,
		dstDomain?: string,
	): Promise<{ ok: true; teams: TeamInfo[] } | { ok: false; error: string }> {
		const r = await relayToGateway(dstGateway, { kind: "list_teams" }, dstDomain);
		if (!r.ok) return { ok: false, error: r.error ?? "relay failed" };
		const parsed = ListTeamsRelayResultSchema.safeParse(r.result);
		if (!parsed.success) {
			const error = `malformed list_teams reply from "${dstGateway}": ${parsed.error.message}`;
			console.warn(`[relay] ${error}`);
			return { ok: false, error };
		}
		return { ok: true, teams: parsed.data.teams ?? [] };
	}

	/** The cross-Domain-presence backstop pull: query every one of `fromDomainId`'s gateways for its
	 * OWN `list_teams` at once (a sequential await-per-gateway loop would let one hung gateway delay
	 * even STARTING the request to that Domain's other, possibly healthy, gateways by up to the full
	 * relay timeout, degrading this Domain's own backstop cadence far below the reconciler's intended
	 * 10s tick), deduped by gateway id like `discover()`'s own fan-out, converted through the same
	 * `toCrossDomainPresenceSession` filter the push side uses - no `sharesFor` gate here, since the
	 * peer's own gateway already decided what to share to this Domain before answering. Resolves
	 * `null` if every gateway for this Domain was unreachable OR answered with something that failed
	 * validation this attempt (the caller must not overwrite existing landed state with emptiness on
	 * a failed pull); an array (possibly empty, if the Domain genuinely shares nothing back) once at
	 * least one gateway answered with a valid reply. */
	async function pullPresenceFromDomain(fromDomainId: string): Promise<CrossDomainPresenceSession[] | null> {
		const peers = (crossDomainPeers?.all() ?? []).filter((p) => p.friendDomainId === fromDomainId);
		if (peers.length === 0) return null;
		const seenGateways = new Set<string>();
		const toQuery = peers.filter((peer) => {
			if (seenGateways.has(peer.friendGatewayId)) return false;
			seenGateways.add(peer.friendGatewayId);
			return true;
		});
		const results = await Promise.all(toQuery.map((peer) => relayListTeams(peer.friendGatewayId)));
		const rows: TeamInfo[] = [];
		let anyOk = false;
		for (const r of results) {
			if (!r.ok) continue;
			anyOk = true;
			rows.push(...r.teams);
		}
		if (!anyOk) return null;
		const out: CrossDomainPresenceSession[] = [];
		for (const t of rows) {
			if (out.length >= MAX_CROSSDOMAIN_PRESENCE_SESSIONS) break;
			const session = toCrossDomainPresenceSession(t);
			if (session) out.push(session);
		}
		return out;
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
				const r = await relayListTeams(h.gatewayId);
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
				if (!r.ok) return [] as TeamInfo[];
				// Tag each shared session with the peer's Domain id (authoritative HERE: this
				// Gateway knows which Domain it linked, while a friend on an older build might
				// stamp none). The (domainId, gatewayId) pair is what the console groups by and
				// the send path resolves the seal target from, since a gateway id collides
				// across Domains. The peer's own displayName rides through the spread, so Peers
				// display the friend's name.
				return r.teams.map((t) => ({ ...t, domainId: peer.friendDomainId }));
			}),
		);
		return jsonResponse([...local, ...sameDomain.flat(), ...crossDomain.flat()]);
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
	function refuseImpersonation(req: Request, claimed: string): Response | null {
		if (!auth) return null;
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
			const refused = refuseImpersonation(req, from);
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

				// Count this delivery toward the target's next vibe check: a console send is a "user"
				// message; agent crosstalk and a federated inbound send both count as "agent". Counted
				// once per send regardless of sub-session fan-out.
				vibeCheck?.noteInbound(localName, opts.consoleSender ? "user" : "agent");

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
						if (fromAddr) {
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

		// A vibe-check answer (vc-*): store the description on the session record and stop - it is a
		// gateway question, never a store delivery.
		if (
			vibeCheck?.resolve(respondSessionId, replyAsJson ?? undefined, rest.response ?? undefined, responderToken)
		) {
			return jsonResponse({ delivered: true, vibeCheck: true });
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
			// evie. The session target is the canonical domain.gateway.spawn.session parsed from the job's own
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
			if (localAddr) {
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
				mailbox.append({
					kind: "reply",
					session_id: respondSessionId,
					body: response.response,
					...pickTiers(response),
					status: response.status,
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
					// The reply landing back in the asker's session is an inbound message too - from
					// the responding agent (covers a federated response_push, which also lands here),
					// or from the user when the console answers a thread delivered to it.
					if (senderWs.data.teamName) {
						vibeCheck?.noteInbound(senderWs.data.teamName, opts.consoleSender ? "user" : "agent");
					}
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
				if (askerAddr) {
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

	/** Broadcast a notice to the owner's mailbox (one shared inbox drained by every one of their
	 * devices). Notices thread under the sender on the console and are never respondable: they
	 * are appended directly here (not via a peer push), so no inbound session is recorded.
	 * Ensures the mailbox by owner id rather than iterating whatever conversations already happen
	 * to be registered ON THIS GATEWAY: a Gateway with zero consoles ever registered against it
	 * (the ordinary shape for a multi-gateway Domain's non-home Gateway) would otherwise have an
	 * empty mailbox map, silently dropping the notice instead of landing it somewhere the owner
	 * will eventually poll. fanOutConsolePush then relays the same entry to every other
	 * same-Domain Gateway too, so it reaches wherever the console actually is. */
	function humanNotify(req: Request, body: Record<string, unknown>): Response {
		const parsed = HumanNotifySchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, title, summary, full, fullSpoken, files: rawNoticeFiles } = parsed.data;
		// Stamped like every other locally-composed message. This route has no federated or console
		// caller - a notice is always posted by an agent on this machine, whose bytes are therefore
		// here - and the notice then fans out to wherever the owner's console actually polls, so
		// without the stamp a multi-Gateway owner can never fetch a notify_human attachment.
		const files = rawNoticeFiles && stampBlobHolder(rawNoticeFiles, localGatewayId);
		const refused = refuseImpersonation(req, from);
		if (refused) return refused;
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
		const owner = ownerId?.();
		if (!owner) {
			return jsonResponse({ error: "not yet enrolled; no owner to notify" }, 503);
		}
		const dedupeKey = crypto.randomUUID();
		const entry: ConsolePushEntry = {
			kind: "notice",
			// `from` is agent-origin (the notifying session's PROJECT_NAME, a slug), so localAddress
			// never throws here - unlike a console send's free-form Device Name. notify_human is an
			// agent-only tool; a console never posts a notice, so the sender is always a slug.
			session_id: storeKey({ kind: "notice", sender: localAddress(from) }),
			from,
			body: full,
			...pickTiers({ title, summary, fullSpoken }),
			...(files && files.length > 0 ? { files } : {}),
		};
		if (!landMailboxEntry(owner, entry, dedupeKey, "notify")) {
			return jsonResponse({ error: "failed to store notice" }, 500);
		}
		void fanOutConsolePush(entry, dedupeKey);
		console.log(`[notify] notice from ${from} delivered to owner ${owner}`);
		return jsonResponse({ delivered: true });
	}

	/** Land a generic plugin-action envelope (pluginId/actionType/payload) into the owner's mailbox
	 * as a `plugin_action` entry, threaded under the CALLING agent's own address - never a
	 * client-suppliable target - so a caller can only ever act on its own conversation.
	 * Best-effort/never-load-bearing, matching every other mailbox-writing path here: the console
	 * routes an unclaimed pluginId:actionType to nothing (silently skipped), so a dropped write here
	 * is no worse than a dropped claim there. */
	function pluginAction(req: Request, body: Record<string, unknown>): Response {
		const parsed = PluginActionRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, pluginId, actionType, payload } = parsed.data;
		const refused = refuseImpersonation(req, from);
		if (refused) return refused;
		if (!mailboxStore) {
			return jsonResponse({ error: "console bridge is not enabled on this gateway" }, 503);
		}
		const owner = ownerId?.();
		if (!owner) {
			return jsonResponse({ error: "not yet enrolled; no owner to notify" }, 503);
		}
		let threadAddr: Address;
		try {
			threadAddr = localAddress(from);
		} catch {
			return jsonResponse({ error: `invalid "from" session name: ${from}` }, 400);
		}
		const dedupeKey = crypto.randomUUID();
		const entry: ConsolePushEntry = {
			kind: "plugin_action",
			session_id: storeKey({ kind: "conv", conversationId: owner, address: threadAddr }),
			pluginId,
			actionType,
			...(payload ? { payload } : {}),
		};
		if (!landMailboxEntry(owner, entry, dedupeKey, "plugin_action")) {
			return jsonResponse({ error: "failed to store plugin action" }, 500);
		}
		void fanOutConsolePush(entry, dedupeKey);
		console.log(`[plugin_action] ${pluginId}:${actionType} from ${from} delivered to owner ${owner}`);
		return jsonResponse({ delivered: true });
	}

	return {
		pending,
		capabilities,
		teams,
		discover,
		send,
		respond,
		poll,
		fetchBlobFromGateway,
		health,
		humanNotify,
		consolePush,
		pluginAction,
		presenceForDomain,
		landCrossDomainPresence,
		pushPresenceToDomain,
		pullPresenceFromDomain,
		invalidatePresenceSnapshotCache,
	};
}
