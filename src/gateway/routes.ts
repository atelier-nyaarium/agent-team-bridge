import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import type { SealedEnvelope } from "../shared/crypto.js";
import { type ConsolePushEntry, type FederatedOp, ReturnRouteSchema } from "../shared/federation-protocol.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "../shared/host-op.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import { ChannelFilesSchema } from "../shared/schemas.js";
import {
	Address,
	composeSessionName,
	DEFAULT_SESSION,
	isComposite,
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
import type { WakeResult } from "./wake.js";
import {
	type ConversationRegistry,
	getAllActiveWs,
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
	// The durable session-record store. teams() surfaces its records as asleep "available"
	// sessions so a session that exists but is not currently registered still lists. Optional
	// for test harnesses with no resume tracking.
	sessionStore?: import("../shared/session-store.js").SessionStore;
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
	resolveHandshake?: (sessionId: string, replyAsJson?: Record<string, unknown>, response?: string) => boolean;
	// This Gateway's own Domain owner id (a hash of the owner's signing key), used to key the
	// mirror-tap's agent-to-agent display entries into the owner's mailbox. Null pre-enrollment
	// (arming mode) or when federation is off, matching resolvesLocalGateway's gating.
	ownerId?: (() => string | null) | null;
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
	// Optional notice-style tiers on a reply (title = notification-bar line + shortest TTS tier,
	// summary = medium tier). The console reads them like a notice's; absent on a plain reply.
	title: z.string().optional(),
	summary: z.string().optional(),
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
// ~4/3 of the bytes) before anything is stored or pushed. Per-payload total, not
// per-file - a single file may use the whole bucket.
const MAX_RESPONSE_FILE_BYTES = 500_000_000;

// A plugin-action payload is meant to carry a small, action-specific value (e.g. a filename), never
// bytes - unlike files/attachments, it has no dedicated cap upstream and device-mailbox.ts's own
// entryBytes() does not count it, so this is the only backstop against an oversized or pathologically
// nested payload reaching the mailbox (and the durable-store snapshot written on a timer).
const MAX_PLUGIN_ACTION_PAYLOAD_BYTES = 32_768;

function fileBytes(files: ChannelFile[]): number {
	let n = 0;
	for (const f of files) n += f.base64 ? Math.floor((f.base64.length * 3) / 4) : f.size;
	return n;
}

/** The one measurement of a plugin-action payload's size, so the schema-level check and the
 * consolePush landing-side check (the two enforcement sites) can never independently drift on HOW
 * size is measured, mirroring fileBytes()'s role for MAX_RESPONSE_FILE_BYTES. */
function payloadBytes(payload: Record<string, unknown>): number {
	return JSON.stringify(payload).length;
}

/** Drop base64 so a persistent store entry never retains the bytes; the live
 * push and the mailbox carry the payload, the store keeps only metadata. */
function stripFileBytes(files: ChannelFile[]): ChannelFile[] {
	return files.map(({ base64: _omit, ...meta }) => meta);
}

const PollRequestSchema = z.object({
	session_id: z.string(),
});

// title, summary, and full are REQUIRED: a notice must always carry a headline,
// an addressable short tier, and a real body (no ghost pings). Strict: an unknown
// field (e.g. the retired `tiny`) is rejected, not silently stripped.
const HumanNotifySchema = z
	.object({
		from: z.string().min(1).max(128),
		title: z.string().min(1).max(200),
		summary: z.string().min(1),
		full: z.string().min(1),
		files: ChannelFilesSchema.optional(),
	})
	.strict();

// `from` is the ONLY identity field, and it names the CALLING agent's own session (exactly what
// every other agent-originated route already trusts at the same level - see send()'s own `from`;
// this route adds no NEW trust boundary beyond that pre-existing, network-level one, tracked in
// plans/gateway-auth-surface.md). Strict on purpose: there is no separate "to"/"target"/"team" field
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
	tryWakeTeam,
	isWakeInFlight,
	offlineCatalog,
	knownTeamPaths,
	sessionStore,
	mailboxStore,
	config,
	evieClient,
	sealer,
	crossDomainPeers,
	displayName,
	isAdminDomain,
	resolvesLocalGateway,
	touchShares,
	isSharedToForReply,
	resolveHandshake,
	ownerId,
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
		payload: { body?: string; files?: ChannelFile[]; status?: string; title?: string; summary?: string },
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
				relayWithRetry(gatewayId, { kind: "console_push", entry, dedupeKey }, "console_push");
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

	/** Relay a cross-Gateway op in the background, retrying on transient failure (evie
	 * reconnecting, the origin Gateway restarting) with exponential backoff. The reply
	 * it carries is already durable in the local anchor (poll-recoverable), so a
	 * dropped first attempt does not strand the origin's request. */
	function relayWithRetry(dstGateway: string, op: FederatedOp, label: string): void {
		const maxAttempts = 5;
		let attempt = 0;
		const tryOnce = async (): Promise<void> => {
			// A relay throw (evie disconnect mid-call, call timeout) is just another transient
			// failure: fold it into the retry path so it never escapes as an unhandled rejection.
			let error: string | undefined;
			try {
				const r = await relayToGateway(dstGateway, op);
				if (r.ok) return;
				error = r.error;
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			attempt += 1;
			if (attempt >= maxAttempts) {
				console.error(`[relay] ${label} to ${dstGateway} failed after ${maxAttempts} attempts: ${error}`);
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
		// The owner's display name, stamped on every local session so a linked friend
		// Domain sees the owner's self-set name over the discovery roster. Spread in only
		// when set, so a Gateway with no display name emits a minimal TeamInfo (the field
		// is nullish on the wire; the friend's gateway is the authoritative source).
		const ownDisplayName = displayName?.();
		const displayNameField = ownDisplayName ? { displayName: ownDisplayName } : {};
		const isAdminDomainField = isAdminDomain?.() ? { isAdminDomain: true } : {};
		// Omit when null so the field is absent rather than null on the wire.
		const domainIdField = localDomainId ? { domainId: localDomainId } : {};
		const commonFields = {
			gatewayId: localGatewayId,
			...domainIdField,
			...displayNameField,
			...isAdminDomainField,
		};

		// Visible sessions are exactly the store records. A confirmed live session always has a record;
		// recordless live peers (flag-less loose sessions, workers, the operator's own console device)
		// stay hidden. A record with a live incarnation is online (that socket has confirmed its lead
		// handshake) or verifying (it has not yet, e.g. re-registered across a gateway restart); a
		// record with no live incarnation is available (asleep, wakeable).
		for (const record of sessionStore?.list() ?? []) {
			const name = sessionStore!.teamOf(record);
			// A record's spawn/id are slugs by construction, but a hand-edited store file is not; a
			// non-composite / non-slug name is not a valid chat and must not surface as an
			// un-wakeable phantom.
			const parts = parseSessionName(name);
			if (!isComposite(name) || !isSlug(parts.project) || !isSlug(parts.session)) continue;
			seen.add(name);
			const live = resolveLiveIncarnation(registry, sessionStore, name);
			if (live) {
				// A live session keeps its cross-Domain shares fresh and its record touch-refreshed, so
				// neither the absence sweep nor the record TTL can reap a session that is connected now.
				const selfAddr = tryLocalAddress(name);
				if (selfAddr) touchShares?.(selfAddr.canonical);
				sessionStore!.touchLive(name);
			}
			teamsList.push({
				team: name,
				...commonFields,
				// online/verifying omit lastActive (active NOW); only asleep carries recency. An asleep
				// record with a wake in flight reads verifying (coming up), so a booting session shows a
				// spinner from spawn/wake, not only once its MCP registers.
				status: live
					? live.data.handshakeConfirmed
						? "online"
						: "verifying"
					: isWakeInFlight?.(name)
						? "verifying"
						: "available",
				...(live ? { mode: live.data.mode, version: live.data.version } : { lastActive: record.lastSeen }),
				kind: "loose",
				sessionLabel: record.sessionLabel,
				queue_depth: 0,
			});
		}

		// Spawn-points: the devcontainer catalog. A bare project is the wakeable spawn-point; its named
		// sessions list above as records.
		for (const [name] of offlineCatalog) {
			if (seen.has(name)) continue;
			seen.add(name);
			teamsList.push({ team: name, ...commonFields, status: "available", kind: "devcontainer", queue_depth: 0 });
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
				const r = await relayToGateway(peer.friendGatewayId, { kind: "list_teams" });
				if (!r.ok) return [] as TeamInfo[];
				const peerTeams = (r.result as { teams?: TeamInfo[] } | undefined)?.teams ?? [];
				// Tag each shared session with the peer's Domain id (authoritative HERE: this
				// Gateway knows which Domain it linked, while a friend on an older build might
				// stamp none). The (domainId, gatewayId) pair is what the console groups by and
				// the send path resolves the seal target from, since a gateway id collides
				// across Domains. The peer's own displayName rides through the spread, so Peers
				// display the friend's name.
				return peerTeams.map((t) => ({ ...t, domainId: peer.friendDomainId }));
			}),
		);
		return jsonResponse([...local, ...sameDomain.flat(), ...crossDomain.flat()]);
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
			files,
			channelOnly,
			displayLabel,
		} = parsed.data;
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
				await new Promise((r) => setTimeout(r, 3000));
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
		opts: { consoleSender?: boolean } = {},
	): Response {
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
			title: rest.title,
			summary: rest.summary,
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
			relayWithRetry(
				rr.srcGateway,
				{
					kind: "response_push",
					session_id: rr.srcSession,
					...(response.status ? { status: response.status } : {}),
					...(response.response ? { response: response.response } : {}),
					...(response.title ? { title: response.title } : {}),
					...(response.summary ? { summary: response.summary } : {}),
					...(response.replyAsJson ? { replyAsJson: response.replyAsJson } : {}),
					...(response.question ? { question: response.question } : {}),
					...(response.reason ? { reason: response.reason } : {}),
					...(files && files.length > 0 ? { files } : {}),
				},
				"cross-Gateway reply-pin",
			);
			console.log(`[respond] ${respondSessionId} pinned to Gateway ${rr.srcGateway} via the Router`);
			// Mirror the LOCAL responder's own thread. Never for the console itself (opts.consoleSender) -
			// a slug-shaped Device Name could in principle register and land a returnRoute job on itself.
			const localAddr = opts.consoleSender ? null : tryLocalAddress(deliverResult.to);
			if (localAddr) {
				mirrorPeer(localAddr, localAddr.canonical, deliverResult.from, {
					body: response.response,
					files,
					status: response.status,
					title: response.title,
					summary: response.summary,
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
					title: response.title,
					summary: response.summary,
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
						title: response.title,
						summary: response.summary,
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
			title,
			summary,
			body: full,
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
	function pluginAction(body: Record<string, unknown>): Response {
		const parsed = PluginActionRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, pluginId, actionType, payload } = parsed.data;
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
		teams,
		discover,
		send,
		respond,
		poll,
		health,
		humanNotify,
		consolePush,
		pluginAction,
	};
}
