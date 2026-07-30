import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ChannelFile, ChannelPushPayload, ResponsePushPayload } from "../../shared/types.js";
import { dropReferenceArtifacts, materializeFiles, renderFilesBlock } from "./evieFiles.js";

////////////////////////////////
//  Functions & Helpers

/** The prose must survive a filesystem that will not take the bytes, so a materialization failure
 * costs the [FILES] block and nothing else.
 *
 * `stripRefs` is false for an inbound SEND: only a reply appends ref artifacts, so a manifest
 * arriving on a send is a file someone genuinely attached, and splitting on it would silently eat
 * that file plus every one after it. */
async function filesBlockFor(
	bucketKey: string | undefined,
	files: ChannelFile[] | undefined,
	stripRefs: boolean,
): Promise<string> {
	if (!bucketKey || !files || files.length === 0) return "";
	const wanted = stripRefs ? dropReferenceArtifacts(files) : files;
	if (wanted.length < files.length) {
		console.error(`[channel] hid ${files.length - wanted.length} ref artifact(s) from ${bucketKey}`);
	}
	if (wanted.length === 0) return "";
	try {
		const materialized = await materializeFiles({ discordMessageId: bucketKey, files: wanted });
		return renderFilesBlock({ discordMessageId: bucketKey, files: materialized });
	} catch (err) {
		console.error(`[channel] could not materialize files for ${bucketKey}: ${(err as Error).message}`);
		return "";
	}
}

/**
 * Emit a channel notification to push an incoming message into Claude's session.
 * The message arrives as a <channel source="bridge" ...>body</channel> tag.
 */
export async function emitChannelNotification(server: Server, payload: ChannelPushPayload): Promise<void> {
	// Inbound files key the materialization bucket by the channel message_id.
	const filesBlock = await filesBlockFor(payload.message_id, payload.files, false);

	// content is the message prose ONLY (plus the [FILES] block, which is paths the agent must Read).
	// Every structured field - session_id, from, reply_schema, instructions - rides in `meta`,
	// which the harness renders as <channel ...> tag attributes; nothing is jammed as a prose preamble.
	const content = filesBlock ? `${payload.body}\n\n${filesBlock}` : payload.body;

	// Per-message reply routing, mirroring the `instructions` key the cycle tools return on every
	// response. The full how-to-reply guidance in the MCP `instructions` sits at the top of the
	// context and loses salience to fresher injections (skills, compaction summaries), which has
	// produced real missed replies; this attribute keeps the reply route in the freshest content.
	const instructions = payload.replyJsonSchema
		? "Reply with the channel_reply_structured tool using this session_id and a responseData matching reply_schema."
		: "Reply with the channel_reply tool using this session_id. Plain text output does not reach the sender.";

	await server.notification({
		method: "notifications/claude/channel",
		params: {
			content,
			meta: {
				session_id: payload.session_id,
				from: payload.from,
				...(payload.replyJsonSchema ? { reply_schema: payload.replyJsonSchema } : {}),
				instructions,
			},
		},
	});

	console.error(`[channel] pushed from ${payload.from} [${payload.session_id.slice(0, 8)}...]`);
}

export async function emitResponseNotification(server: Server, payload: ResponsePushPayload): Promise<void> {
	const filesBlock = await filesBlockFor(payload.message_id, payload.files, true);
	const body = payload.response ?? "";

	await server.notification({
		method: "notifications/claude/channel",
		params: {
			// The reply prose only; status rides structured in meta, not as a
			// "Status:" label flattened into the body.
			content: filesBlock ? `${body}\n\n${filesBlock}` : body,
			meta: {
				session_id: payload.session_id,
				...(payload.status ? { status: payload.status } : {}),
			},
		},
	});
	console.error(`[channel] response pushed to sender [${payload.session_id.slice(0, 8)}...]`);
}
