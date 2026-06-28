import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { debugLog } from "../../shared/debug-log.js";
import type { ChannelPushPayload, ResponsePushPayload } from "../../shared/types.js";
import { materializeFiles, renderFilesBlock } from "./evieFiles.js";

////////////////////////////////
//  Functions & Helpers

/**
 * Emit a channel notification to push an incoming message into Claude's session.
 * The message arrives as a <channel source="bridge" ...>body</channel> tag.
 */
export async function emitChannelNotification(server: Server, payload: ChannelPushPayload): Promise<void> {
	let filesBlock = "";
	// Console-origin files key the materialization bucket by the channel message_id.
	const bucketKey = payload.message_id;
	if (payload.files && payload.files.length > 0 && bucketKey) {
		const materialized = materializeFiles({ discordMessageId: bucketKey, files: payload.files });
		filesBlock = renderFilesBlock({ discordMessageId: bucketKey, files: materialized });
	}

	// content is the message prose ONLY (plus the [FILES] block, which is paths the agent must Read).
	// Every structured field - session_id, from, reply_schema - rides in `meta`,
	// which the harness renders as <channel ...> tag attributes; nothing is jammed as a prose preamble.
	// The how-to-reply guidance lives once in the MCP `instructions`, not re-stamped on every message.
	const content = filesBlock ? `${payload.body}\n\n${filesBlock}` : payload.body;

	// #region Hypothesis A: channel_push received by this sub-process
	debugLog("A", "src/mcp/channel/channelNotify.ts:emitChannelNotification", "channel_push received", {
		pid: process.pid,
		sessionId: payload.session_id.slice(0, 8),
		from: payload.from,
		bodyLen: (payload.body ?? "").length,
	});
	// #endregion

	await server.notification({
		method: "notifications/claude/channel",
		params: {
			content,
			meta: {
				session_id: payload.session_id,
				from: payload.from,
				...(payload.replyJsonSchema ? { reply_schema: payload.replyJsonSchema } : {}),
			},
		},
	});

	// #region Hypothesis B: channel notification emitted successfully
	debugLog("B", "src/mcp/channel/channelNotify.ts:emitChannelNotification", "channel notification emitted", {
		pid: process.pid,
		sessionId: payload.session_id.slice(0, 8),
		result: "OK",
	});
	// #endregion

	console.error(`[channel] pushed from ${payload.from} [${payload.session_id.slice(0, 8)}...]`);
}

export async function emitResponseNotification(server: Server, payload: ResponsePushPayload): Promise<void> {
	// #region Hypothesis A: response_push received by this sub-process
	debugLog("A", "src/mcp/channel/channelNotify.ts:emitResponseNotification", "response_push received", {
		pid: process.pid,
		sessionId: payload.session_id.slice(0, 8),
		status: payload.status,
		responseLen: (payload.response ?? "").length,
	});
	// #endregion

	try {
		await server.notification({
			method: "notifications/claude/channel",
			params: {
				// The reply prose only; status rides structured in meta, not as a
				// "Status:" label flattened into the body.
				content: payload.response ?? "",
				meta: {
					session_id: payload.session_id,
					...(payload.status ? { status: payload.status } : {}),
				},
			},
		});

		// #region Hypothesis B: response notification emitted successfully
		debugLog("B", "src/mcp/channel/channelNotify.ts:emitResponseNotification", "response notification emitted", {
			pid: process.pid,
			sessionId: payload.session_id.slice(0, 8),
			result: "OK",
		});
		// #endregion
	} catch (err) {
		// #region Hypothesis B: server.notification() threw an error
		debugLog("B", "src/mcp/channel/channelNotify.ts:emitResponseNotification", "response notification FAILED", {
			pid: process.pid,
			sessionId: payload.session_id.slice(0, 8),
			error: (err as Error).message,
		});
		// #endregion
		throw err;
	}
	console.error(`[channel] response pushed to sender [${payload.session_id.slice(0, 8)}...]`);
}
