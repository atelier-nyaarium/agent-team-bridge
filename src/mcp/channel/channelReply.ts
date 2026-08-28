import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	type ChannelReplyArgs,
	ChannelReplySchema,
	type ChannelReplyStructuredArgs,
	ChannelReplyStructuredSchema,
} from "../../shared/schemas.js";
import { bridgeConversationId, confirmHandshakeRole } from "../bridge/helpers.js";
import { postReply, readReplyAttachments, type ToolTextResult, toolError } from "../bridge/replyTool.js";
import { type Capability, capabilityInstructions } from "../capabilities.js";
import { appendRefArtifacts, withNotices } from "../references/attachRefs.js";

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
	// Parity with the gateway's /true/i fallback, or a prose-confirmed lead re-asks every reconnect.
	confirmHandshakeRole(args.session_id, /true/i.test(args.full));
	const payload = buildChannelReplyPayload(args);
	let files: Awaited<ReturnType<typeof readReplyAttachments>> = [];
	if (args.attachments && args.attachments.length > 0) {
		try {
			files = await readReplyAttachments(args.attachments);
		} catch (err) {
			return toolError(`Attachment error: ${(err as Error).message}`);
		}
	}

	// Named against the agent's own attachments, so nothing collides. A hard failure stops the send
	// on purpose: the agent is still here to correct the ref.
	const withRefs = await appendRefArtifacts(args.full, files);
	if (!withRefs.ok) return toolError(withRefs.error);
	if (withRefs.files.length > 0) payload.files = withRefs.files;

	const sent = await postReply(payload, {
		toolName: "channel_reply",
		logPrefix: "channel",
		responseFieldLabel: "full",
	});
	return withNotices(sent, withRefs.notices);
}

export async function handleChannelReplyStructured(args: ChannelReplyStructuredArgs): Promise<ToolTextResult> {
	if (isEmptyResponseData(args.responseData)) {
		return toolError(
			`Empty responseData rejected - {} would render as the literal string "{}" on the console with no useful content.`,
		);
	}
	// Scoped to a handshake this process received, so a relayed session_id cannot poison a worker.
	if (typeof args.responseData.isMainOrLead === "boolean") {
		confirmHandshakeRole(args.session_id, args.responseData.isMainOrLead);
	}
	const payload = buildStructuredReplyPayload(args);
	return postReply(payload, { toolName: "channel_reply_structured", logPrefix: "channel" });
}

////////////////////////////////
//  Functions & Helpers

// Threaded in, not read from a global, so a description cannot be composed before the answer.
export function registerChannelReply(mcpServer: McpServer, capabilities: Capability[] = []): void {
	const guidance = capabilityInstructions(capabilities);
	mcpServer.registerTool(
		"channel_reply",
		{
			title: `Channel Reply`,
			description: `
# Channel Reply

Reply to an incoming channel message. Conversations are streams, so call this repeatedly on the same \`session_id\` when needed.

\`session_id\`, \`title\`, \`summary\`, \`full\`, and \`fullSpoken\` are required.

Send responses verbatim unless the requester asked for a summary.${guidance}
`.trim(),
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
			title: `Channel Reply (Structured)`,
			description: `
# Channel Reply (Structured)

Reply to a request with \`reply_schema\`, such as the bridge handshake. \`responseData\` must match that schema.

Use only when the inbound \`<channel>\` tag has \`reply_schema\`. Otherwise use \`channel_reply\`.
`.trim(),
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: ChannelReplyStructuredSchema as any,
		},
		handleChannelReplyStructured,
	);
}
