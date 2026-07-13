import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	type ChannelReplyArgs,
	ChannelReplySchema,
	type ChannelReplyStructuredArgs,
	ChannelReplyStructuredSchema,
} from "../../shared/schemas.js";
import { bridgeConversationId, isReceivedHandshakeId, setIsMainOrLeadAgent } from "../bridge/helpers.js";
import { postReply, readReplyAttachment, type ToolTextResult, toolError } from "../bridge/replyTool.js";

////////////////////////////////
//  Payload builders (pure - the wire mapping, testable without a network call)

export function buildChannelReplyPayload(args: ChannelReplyArgs): Record<string, unknown> {
	return {
		session_id: args.session_id,
		title: args.title,
		summary: args.summary,
		response: args.full,
		fullSpoken: args.fullSpoken,
		conversationId: bridgeConversationId(),
	};
}

export function buildStructuredReplyPayload(args: ChannelReplyStructuredArgs): Record<string, unknown> {
	return { session_id: args.session_id, replyAsJson: args.responseData, conversationId: bridgeConversationId() };
}

export function isEmptyResponseData(responseData: Record<string, unknown>): boolean {
	return !responseData || Object.keys(responseData).length === 0;
}

////////////////////////////////
//  Handlers (exported directly so tests can call them without an McpServer)

export async function handleChannelReply(args: ChannelReplyArgs): Promise<ToolTextResult> {
	// Prose parity with the gateway's own /true/i handshake fallback: a handshake answered with plain
	// channel_reply (rather than the instructed channel_reply_structured) still fills the role cache,
	// or a prose-confirmed lead would keep re-asking on every reconnect. Scoped to a handshake this
	// process actually received, same as the structured path below.
	if (isReceivedHandshakeId(args.session_id)) {
		setIsMainOrLeadAgent(/true/i.test(args.full));
	}
	const payload = buildChannelReplyPayload(args);
	if (args.attachments && args.attachments.length > 0) {
		try {
			payload.files = await Promise.all(args.attachments.map(readReplyAttachment));
		} catch (err) {
			return toolError(`Attachment error: ${(err as Error).message}`);
		}
	}
	return postReply(payload, { toolName: "channel_reply", logPrefix: "channel", responseFieldLabel: "full" });
}

export async function handleChannelReplyStructured(args: ChannelReplyStructuredArgs): Promise<ToolTextResult> {
	if (isEmptyResponseData(args.responseData)) {
		return toolError(
			`Empty responseData rejected - {} would render as the literal string "{}" on the console with no useful content.`,
		);
	}
	// Remember the answer so a later reconnect confirms silently instead of re-asking. Scoped to a
	// handshake this process actually received: a lead relaying a worker teammate this session_id to
	// answer must never be able to poison the WORKER's own cache via an id it never received.
	if (isReceivedHandshakeId(args.session_id) && typeof args.responseData.isMainOrLead === "boolean") {
		setIsMainOrLeadAgent(args.responseData.isMainOrLead);
	}
	const payload = buildStructuredReplyPayload(args);
	return postReply(payload, { toolName: "channel_reply_structured", logPrefix: "channel" });
}

////////////////////////////////
//  Functions & Helpers

export function registerChannelReply(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"channel_reply",
		{
			title: "Channel Reply",
			description: `Reply to an incoming channel message. Channel conversations are streams: you can call this any number of times on the same session_id. Each call is just another message in the stream; there is no finality or "done" status. session_id, title, summary, full, and fullSpoken are all required. Send responses verbatim unless the requester explicitly asked for a summary.`,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: ChannelReplySchema as any,
		},
		handleChannelReply,
	);
}

export function registerChannelReplyStructured(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"channel_reply_structured",
		{
			title: "Channel Reply (Structured)",
			description: `Reply to a request that carried a reply_schema (e.g. the bridge handshake). responseData is a native object matching that schema. Use ONLY when the inbound <channel> tag has a reply_schema attribute; for all other replies use channel_reply.`,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: ChannelReplyStructuredSchema as any,
		},
		handleChannelReplyStructured,
	);
}
