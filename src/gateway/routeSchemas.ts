import type { ServerWebSocket } from "bun";
import { z } from "zod";
import type { BoardEntry } from "../shared/console-protocol.js";
import { ReturnRouteSchema } from "../shared/federation-protocol.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "../shared/host-op.js";
import { NoticeFull, NoticeFullSpoken, NoticeSummary, NoticeTierWireFields, NoticeTitle } from "../shared/notice.js";
import { MAX_BLOB_BYTES } from "../shared/router-protocol.js";
import { BOARD_BODY_MAX, ChannelFilesSchema } from "../shared/schemas.js";
import { isSlug } from "../shared/session-id.js";
import type { ChannelFile, ConnectionMode } from "../shared/types.js";
import type { WsData } from "./wsTypes.js";

/** Agent projections omit fetchable bearer references. */
export type AgentBoardEntry = Omit<BoardEntry, "attachments"> & {
	attachments?: { filename: string; mime: string; size: number }[];
};

// Stable producer ids make retries one operation.
const producerOpId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[^/\r\n]+$/)
	.optional();

export const SendRequestSchema = z.object({
	// `from` is the caller identity, not a target.
	from: z.string(),
	opId: producerOpId,
	fromConversationId: z.string().regex(CONVERSATION_ID_RE).max(MAX_CONVERSATION_ID_LEN).optional(),
	to: z.string(),
	targetDomainId: z.string().optional(),
	body: z.string().optional(),
	displayLabel: z.string().min(1).max(64).optional(),
	disposition: z.enum(["asking", "informing", "closing"]).optional(),
	session_id: z.string().optional(),
	debug: z.boolean().optional(),
	files: ChannelFilesSchema.optional(),
	channelOnly: z.boolean().optional(),
	sessionId: z.string().optional(),
	returnRoute: ReturnRouteSchema.optional(),
	dstDomainId: z.string().optional(),
});

export const RespondBodySchema = z.object({
	session_id: z.string(),
	opId: producerOpId,
	status: z.string().optional(),
	response: z.string().optional(),
	conversationId: z.string().regex(CONVERSATION_ID_RE).max(MAX_CONVERSATION_ID_LEN).optional(),
	...NoticeTierWireFields,
	replyAsJson: z.record(z.string(), z.unknown()).optional(),
	question: z.string().optional(),
	reason: z.string().optional(),
	estimated_minutes: z.number().optional(),
	what_to_decide: z.string().optional(),
	message: z.string().optional(),
	files: ChannelFilesSchema.optional(),
});

export const MAX_RESPONSE_FILE_BYTES = MAX_BLOB_BYTES;

export const POST_WAKE_SETTLE_MS = 3_000;

export const MAX_PLUGIN_ACTION_PAYLOAD_BYTES = 32_768;

export const MAX_BOARD_REPLIES = 512;

export const PollRequestSchema = z.object({
	session_id: z.string(),
});

export const HumanNotifySchema = z.object({
	from: z.string().min(1).max(128),
	title: NoticeTitle,
	summary: NoticeSummary,
	full: NoticeFull,
	fullSpoken: NoticeFullSpoken.optional(),
	files: ChannelFilesSchema.optional(),
});

export const BoardRouteRequestSchema = z
	.object({
		from: z.string().min(1).max(128),
		action: z.enum(["list", "claim", "release", "create", "update", "clear", "attachments"]),
		scope: z.enum(["unclaimed", "session", "all"]).optional(),
		id: z.string().min(1).max(64).optional(),
		operationId: z.string().min(1).max(128).optional(),
		assignTo: z.enum(["self", "backlog"]).optional(),
		title: z.string().min(1).max(500).optional(),
		body: z.string().max(BOARD_BODY_MAX).nullable().optional(),
		state: z.enum(["open", "in_progress", "paused", "done", "cancelled"]).optional(),
		parent: z.string().min(1).max(64).nullable().optional(),
	})
	.strict();

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

// Sender claims are checked here. Blob writes enforce actual bytes.
export function fileBytes(files: ChannelFile[]): number {
	let n = 0;
	for (const f of files) n += f.size;
	return n;
}

// Persistent entries retain metadata but lose fetchable references.
export function stripFileRefs(files: ChannelFile[]): ChannelFile[] {
	return files.map(({ blobId: _omit, blobGateway: _also, ...meta }) => meta);
}

export function stampBlobHolder(files: ChannelFile[], gatewayId: string): ChannelFile[] {
	// Never overwrite the Gateway that already holds the blob.
	return files.map((f) => (f.blobId && !f.blobGateway ? { ...f, blobGateway: gatewayId } : f));
}

export function payloadBytes(payload: Record<string, unknown>): number {
	return JSON.stringify(payload).length;
}

export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// Real sockets take precedence over virtual peers.
export function getTeamMode(subs: Map<string, ServerWebSocket<WsData>>): ConnectionMode {
	let virtualMode: ConnectionMode | null = null;
	for (const [, ws] of subs) {
		if (!ws.data.virtual) return ws.data.mode;
		virtualMode = virtualMode ?? ws.data.mode;
	}
	return virtualMode ?? "channel";
}
