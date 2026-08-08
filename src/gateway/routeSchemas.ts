import type { ServerWebSocket } from "bun";
import { z } from "zod";
import type { BoardEntry } from "../shared/console-protocol.js";
import { MAX_BLOB_BYTES } from "../shared/evie-protocol.js";
import { ReturnRouteSchema } from "../shared/federation-protocol.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "../shared/host-op.js";
import { NoticeFull, NoticeFullSpoken, NoticeSummary, NoticeTierWireFields, NoticeTitle } from "../shared/notice.js";
import { BOARD_BODY_MAX, ChannelFilesSchema } from "../shared/schemas.js";
import { isSlug } from "../shared/session-id.js";
import type { ChannelFile, ConnectionMode } from "../shared/types.js";
import type { WsData } from "./websocket.js";

////////////////////////////////
//  Interfaces & Types

/** An entry as an AGENT sees it: attachments carry the display facts and none of the fetch plumbing.
 * A distinct type rather than a mutated `BoardEntry`, so dropping the ids cannot be mistaken for
 * blanking them and the compiler keeps the two views apart. */
export type AgentBoardEntry = Omit<BoardEntry, "attachments"> & {
	attachments?: { filename: string; mime: string; size: number }[];
};

////////////////////////////////
//  Schemas

export const SendRequestSchema = z.object({
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

export const RespondBodySchema = z.object({
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

// Per-payload total across a message's files, and DERIVED rather than restated: an independently
// declared cap has nothing tying its value back to the real constraint, so it can drift stale once
// the actual limit moves elsewhere. A single file may still use the whole bucket.
//
// Advisory by nature, because it sums sender-stated sizes and nothing re-measures them. The real
// enforcement is per-blob on the write path, where the bytes actually land.
export const MAX_RESPONSE_FILE_BYTES = MAX_BLOB_BYTES;

// How long a send waits after waking a session before delivering: registration is instant, but
// Claude Code's channel listener is not ready yet. Named (not inline) because it is one half of a
// cross-module invariant - HANDSHAKE_REPUSH_DEDUPE_MS must stay above it, or the send path's
// post-wake delivery re-pushes a handshake this very wake just minted. Pinned by a test; see
// websocket.ts.
export const POST_WAKE_SETTLE_MS = 3_000;

// A plugin-action payload is meant to carry a small, action-specific value (e.g. a filename), never
// bytes - unlike files/attachments, it has no dedicated cap upstream and device-mailbox.ts's own
// entryBytes() does not count it, so this is the only backstop against an oversized or pathologically
// nested payload reaching the mailbox (and the durable-store snapshot written on a timer).
export const MAX_PLUGIN_ACTION_PAYLOAD_BYTES = 32_768;

/** Roughly a session's working set of recent board writes, times a handful of sessions. */
export const MAX_BOARD_REPLIES = 512;

export const PollRequestSchema = z.object({
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
export const HumanNotifySchema = z
	.object({
		from: z.string().min(1).max(128),
		title: NoticeTitle,
		summary: NoticeSummary,
		full: NoticeFull,
		fullSpoken: NoticeFullSpoken.optional(),
		files: ChannelFilesSchema.optional(),
	})
	.strict();

// The one board route's request: `action` dispatches, `from` is the caller's own session (hardcoded
// MCP-side, same trust story as PluginActionRequestSchema below) and is the ONLY scoping key -
// claim/release/update/clear act as that session, never as a client-suppliable one. Never fed to
// the Kotlin codegen; this is an HTTP-side shape only, so `.nullable()` is expressible (update's
// parent: absent = leave placement alone, null = move to root).
export const BoardRouteRequestSchema = z
	.object({
		from: z.string().min(1).max(128),
		action: z.enum(["list", "claim", "release", "create", "update", "clear", "attachments"]),
		// list only. Defaults to "all"; never returns another session's entries at any scope.
		scope: z.enum(["unclaimed", "session", "all"]).optional(),
		// claim / release / update / attachments.
		id: z.string().min(1).max(64).optional(),
		// create only: the entry id derives from this, so an HTTP retry replays the same entry.
		operationId: z.string().min(1).max(128).optional(),
		// create only, REQUIRED there, deliberately without a default: whichever way one pointed
		// is where nearly everything would land.
		assignTo: z.enum(["self", "backlog"]).optional(),
		title: z.string().min(1).max(500).optional(),
		body: z.string().max(BOARD_BODY_MAX).nullable().optional(),
		state: z.enum(["open", "in_progress", "paused", "done", "cancelled"]).optional(),
		parent: z.string().min(1).max(64).nullable().optional(),
	})
	.strict();

// `from` is the ONLY identity field, naming the CALLING agent's own session, the same network-level
// trust every other agent-originated route carries (a known gap, not a new one). Strict on purpose:
// with no "to"/"target"/"team" field, the caller's own resolved address is the only possible target.
// pluginId/actionType are slug-constrained so a colon inside either half can never collide the
// composite "pluginId:actionType" claim key with a different, distinct pair.
export const PluginActionRequestSchema = z
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

/** The total a payload's files CLAIM to be. Sender-stated and never re-measured here, because the
 * bytes are not here: they travel the blob plane, where the write path counts what actually lands
 * against MAX_BLOB_BYTES. This is only a cheap sanity check on an obviously absurd manifest, not a
 * memory-safety bound: nothing here caps how much a caller may claim before the blob plane counts it. */
export function fileBytes(files: ChannelFile[]): number {
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
 * Whether the bytes ride inline or out of band, the store must withhold whatever makes them
 * fetchable; only the field carrying that changes.
 */
export function stripFileRefs(files: ChannelFile[]): ChannelFile[] {
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
export function stampBlobHolder(files: ChannelFile[], gatewayId: string): ChannelFile[] {
	return files.map((f) => (f.blobId && !f.blobGateway ? { ...f, blobGateway: gatewayId } : f));
}

/** The one measurement of a plugin-action payload's size, so the schema-level check and the
 * consolePush landing-side check (the two enforcement sites) can never independently drift on HOW
 * size is measured, mirroring fileBytes()'s role for MAX_RESPONSE_FILE_BYTES. */
export function payloadBytes(payload: Record<string, unknown>): number {
	return JSON.stringify(payload).length;
}

export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Get the mode of a team, preferring real sockets over virtual console peers. Every bridge
 * connection is channel mode, so this is effectively always "channel"; kept as the single
 * source the teams listing and the send paths read. */
export function getTeamMode(subs: Map<string, ServerWebSocket<WsData>>): ConnectionMode {
	let virtualMode: ConnectionMode | null = null;
	for (const [, ws] of subs) {
		if (!ws.data.virtual) return ws.data.mode;
		virtualMode = virtualMode ?? ws.data.mode;
	}
	return virtualMode ?? "channel";
}
