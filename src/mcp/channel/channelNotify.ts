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
	const replyInstruction =
		"┃ Reply via `channel_reply`. The conversation stays open, so you can reply multiple times: use status `running` for interim updates (phase reports, progress, ACKs) and `completed` for the final answer. Do not output additional text outside the tool call.";
	const lines = [replyInstruction, `┃ session_id: \`${payload.session_id}\``];
	if (payload.message_id) {
		lines.push(`┃ message_id: \`${payload.message_id}\``);
	}
	if (payload.replyJsonSchema) {
		lines.push(`┃ Reply Schema: ${payload.replyJsonSchema}`);
	}
	const replyReminder = lines.join("\n");

	let filesBlock = "";
	// Discord files key the bucket by discord_message_id; phone-origin files lack
	// one, so fall back to the channel message_id.
	const bucketKey = payload.discord_message_id ?? payload.message_id;
	if (payload.files && payload.files.length > 0 && bucketKey) {
		const materialized = materializeFiles({ discordMessageId: bucketKey, files: payload.files });
		filesBlock = renderFilesBlock({ discordMessageId: bucketKey, files: materialized });
	}

	const bodyWithFiles = filesBlock ? `${payload.body}\n\n${filesBlock}` : payload.body;

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
			content: `${replyReminder}\n\n${bodyWithFiles}`,
			meta: {
				session_id: payload.session_id,
				from: payload.from,
				request_type: payload.request_type,
				effort: String(payload.effort),
				is_follow_up: String(payload.is_follow_up),
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

	console.error(
		`[channel] pushed ${payload.is_follow_up ? "follow-up" : "request"} from ${payload.from} [${payload.session_id.slice(0, 8)}...]`,
	);
}

export async function emitResponseNotification(server: Server, payload: ResponsePushPayload): Promise<void> {
	const parts: string[] = [];
	if (payload.status) parts.push(`Status: ${payload.status}`);
	if (payload.response) parts.push(payload.response);
	if (payload.question) parts.push(`Question: ${payload.question}`);
	if (payload.reason) parts.push(`Reason: ${payload.reason}`);

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
				content: parts.join("\n"),
				meta: { session_id: payload.session_id, type: "response" },
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
