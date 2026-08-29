import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ChannelFile, ChannelPushPayload, ResponsePushPayload } from "../../shared/types.js";
import { dropReferenceArtifacts, materializeFiles, renderFilesBlock } from "./channelFiles.js";

////////////////////////////////
//  Functions & Helpers

/** A materialization failure costs the [FILES] block and nothing else, so the prose survives. */
async function filesBlockFor(bucketKey: string | undefined, files: ChannelFile[] | undefined): Promise<string> {
	if (!bucketKey || !files || files.length === 0) return "";
	const wanted = dropReferenceArtifacts(files);
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

/** Arrives as a `<channel source="bridge" ...>body</channel>` tag. */
export async function emitChannelNotification(server: Server, payload: ChannelPushPayload): Promise<void> {
	const filesBlock = await filesBlockFor(payload.message_id, payload.files);
	// Notices that rode this message. Labeled with their source and closed with what to do about
	// them, since the instructions line below belongs to the message itself.
	const awarenessBlock = payload.awareness
		? `[AWARENESS from ${payload.awareness.from}]\n${payload.awareness.body}\n${
				payload.awareness.act === "act_now"
					? "Act on this before continuing."
					: "For awareness only. It needs no action and no reply."
			}`
		: "";

	// Prose ONLY. Every structured field rides in `meta`, which the harness renders as attributes.
	const blocks = [payload.body, filesBlock, awarenessBlock].filter(Boolean);
	const content = blocks.join("\n\n");

	// Repeated per message: the MCP `instructions` sit at the top of the context and lose salience to
	// fresher injections, which has produced real missed replies. Exactly true, not truthy: a stray
	// wire string would turn a question into an announcement nobody answers.
	const instructions =
		payload.no_ack === true && payload.act === "act_now"
			? "Act on this before continuing what you were doing. Nobody is waiting on a reply, so do not send one."
			: payload.no_ack === true
				? `Awareness only. Nobody is waiting on a reply, so do not send one.`
				: payload.disposition === "informing"
					? "No reply needed. Do not acknowledge. Reply only if this affects you in a way they would want to know now."
					: payload.disposition === "closing"
						? "Thread closed, no reply expected. Do not acknowledge; silence is correct here. Reply only if this breaks something on your side."
						: payload.replyJsonSchema
							? `Reply with the channel_reply_structured tool using this session_id and a responseData matching reply_schema.`
							: `They are waiting on a reply. Reply with the channel_reply tool using this session_id. Plain text output does not reach the sender.`;

	await server.notification({
		method: "notifications/claude/channel",
		params: {
			content,
			meta: {
				session_id: payload.session_id,
				from: payload.from,
				...(payload.replyJsonSchema ? { reply_schema: payload.replyJsonSchema } : {}),
				// A STRING: a boolean took the whole notification down silently. Snake_case too, since
				// the harness drops a key failing /^[a-zA-Z_][a-zA-Z0-9_]*$/ without a word.
				...(payload.no_ack === true ? { no_ack: "true" } : {}),
				...(payload.awareness ? { awareness_act: payload.awareness.act } : {}),
				...(payload.disposition ? { disposition: payload.disposition } : {}),
				...(payload.no_ack === true && payload.act === "act_now" ? { act: "act_now" } : {}),
				instructions,
			},
		},
	});

	// The EMIT, not the delivery: the harness drops it silently when this plugin is not in the
	// session's --channels list, visible only as "Channel notifications skipped" in its own logs.
	console.error(
		`[channel] emitted from ${payload.from} [${payload.session_id.slice(0, 8)}...]${payload.no_ack === true ? " no_ack" : ""}`,
	);
}

export async function emitResponseNotification(server: Server, payload: ResponsePushPayload): Promise<void> {
	const filesBlock = await filesBlockFor(payload.message_id, payload.files);
	const body = payload.response ?? "";

	await server.notification({
		method: "notifications/claude/channel",
		params: {
			// Prose only; status rides in meta, not as a label flattened into the body.
			content: filesBlock ? `${body}\n\n${filesBlock}` : body,
			meta: {
				session_id: payload.session_id,
				...(payload.status ? { status: payload.status } : {}),
			},
		},
	});
	console.error(`[channel] response pushed to sender [${payload.session_id.slice(0, 8)}...]`);
}
