import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChannelFile, ResponsePayload } from "../../shared/types.js";
import { dropReferenceArtifacts } from "../channel/channelFiles.js";
import { bridgeConversationId, bridgeProjectName, routerPost } from "./helpers.js";
import { literalEscapeHazard, literalEscapeReject, readReplyAttachments, toolError } from "./replyTool.js";

////////////////////////////////
//  Schemas

const BridgeSendSchema = z
	.object({
		to: z
			.string()
			.optional()
			.describe(
				`
Target session. Copy the full address from \`crosstalk_discover\`: \`domain.gateway.spawn.session\`.

Never shorten it. A shortened address resolves locally instead of to the intended target.

- An online session receives it directly, with no invite step.
- An asleep session is woken on send.
- A spawn point without a session is not a valid target. Set \`displayLabel\` to create a session under it.

The created session may have a different name. Use the resolved address from the response afterwards.
`.trim(),
			),
		body: z.string().optional().describe(`Full Markdown request details and relevant context.`),
		displayLabel: z
			.string()
			.min(1)
			.max(64)
			.optional()
			.describe(
				`
Human-readable label for a new session, e.g. \`Bug Investigation\`. Never a slug, \`id\`, or generated string.

Required to create a target that does not yet exist. Ignored when the target already exists.
`.trim(),
			),
		disposition: z
			.enum(["asking", "informing", "closing"])
			.optional()
			.describe(
				`
What you need back. Set it on every send; omitted means \`asking\`.

- \`asking\`: you are waiting on a reply.
- \`informing\`: no reply needed. They stay silent unless it affects them in a way you would want to know now.
- \`closing\`: the thread is over. Silence is the correct response.
`.trim(),
			),
		session_id: z
			.string()
			.optional()
			.describe(
				`
Polling only. Pass \`session_id\` with no \`body\` to peek at an existing conversation's latest result.

Omit it for sends. Channel conversations derive from the sender and target pair.
`.trim(),
			),
		attachments: z
			.array(z.string())
			.optional()
			.describe(
				`
Absolute paths to send with \`body\`. Requires \`body\`.

The receiving agent gets local files listed in a \`[FILES]\` block.
`.trim(),
			),
	})
	.strict();
type BridgeSendArgs = z.infer<typeof BridgeSendSchema>;

////////////////////////////////
//  Interfaces & Types

type SendResult = ResponsePayload & { error?: string; available?: string[] };

////////////////////////////////
//  Functions & Helpers

const description = `
# Crosstalk Send

Send a request to another team.

## Send

Provide \`to\` and \`body\`. Conversations are reused automatically; do not manage \`session_id\` values.

## Poll

Provide \`session_id\` only, with no \`body\`, to peek at the latest stored result without consuming it.

## Replies

Channel-mode replies arrive as \`<channel>\` notifications. A team may send multiple progress updates without closing the conversation.

## Disposition

Set \`disposition\` on every send. It is the only thing that lets a thread end; without it every message reads as a question and earns an acknowledgement that wakes you for nothing.

- \`asking\`: you need something back.
- \`informing\`: you need nothing back. They reply only if it affects them in a way you would want to know now.
- \`closing\`: the thread is over. Silence is correct.

## Attachments

Set \`attachments\` when the team needs an artifact, such as a screenshot or log. Replies can attach files too.

Relay responses verbatim unless the user requested a summary.
`.trim();

async function formatResult(
	result: SendResult,
	to?: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	const target = to || "team";
	const parts = [`Response from ${target}:`];
	if (result.status) parts.push(`Status: ${result.status}`);

	if (result.status === "completed") {
		if (result.response) parts.push(`\n${result.response}`);
	} else if (result.status === "clarification") {
		parts.push(`Question: ${result.question}`);
		parts.push(`\nTo answer, use crosstalk_send with session_id: "${result.session_id}"`);
	} else if (result.status === "deferred") {
		parts.push(`Reason: ${result.reason}`);
		if (result.estimated_minutes) parts.push(`Estimated wait: ${result.estimated_minutes} minutes`);
		parts.push(`\nYou can use crosstalk_wait to wait, then retry.`);
	} else if (result.status === "needs_human") {
		parts.push(`Reason: ${result.reason}`);
		if (result.what_to_decide) parts.push(`Decision needed: ${result.what_to_decide}`);
		parts.push(`\nThe other team needs their human. Inform yours.`);
	} else if (result.status === "running") {
		parts.push(result.message || `Still running.`);
		parts.push(`\nTo check again, call this tool with just session_id (no body).`);
	} else if (result.status === "error") {
		parts.push(`Error: ${result.reason ?? result.message ?? `Unknown error`}`);
	} else if (result.status === "timeout") {
		parts.push(result.message || `No response in time.`);
	} else {
		// A ResponseStatus added later would otherwise drop its body silently.
		const body = result.response ?? result.message ?? result.reason;
		if (body) parts.push(`\n${body}`);
	}

	// A POLLED reply names its attachments and cannot fetch them: the stored copy holds no reference.
	// Naming them is the honest report; the live push path materializes normally.
	const attached = result.files ? dropReferenceArtifacts(result.files) : [];
	if (attached.length > 0) {
		parts.push(`\nAttachments on this reply (a poll recovers names only; ask for a re-send to get the bytes):`);
		// A peer-supplied newline would forge entries in this line-structured output.
		for (const f of attached) parts.push(`- ${f.filename.replace(/[\r\n]+/g, " ")}`);
	}

	if (result.session_id) parts.push(`\n[session_id: ${result.session_id}]`);

	return { content: [{ type: "text" as const, text: parts.join("\n") }] };
}

export function registerBridgeSend(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"crosstalk_send",
		{
			title: `Crosstalk Send`,
			description,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: BridgeSendSchema as any,
		},
		async ({ to, body, session_id, displayLabel, disposition, attachments }: BridgeSendArgs) => {
			try {
				// Attachments exclude poll mode too, or a files-only send would discard them.
				if (session_id && !body && !attachments?.length) {
					const result = (await routerPost("/poll", { session_id })) as SendResult;

					if (result.error) {
						return {
							content: [{ type: "text" as const, text: `Poll error: ${result.error}` }],
							isError: true,
						};
					}

					return await formatResult(result, to);
				}

				if (!to || !body) {
					throw new Error(`Provide to + body for sending, or just session_id for polling.`);
				}

				// `body` stays unlinted: its primary consumer is the receiving model, and rejecting real
				// inter-team work over a cosmetic mirror is worse than the blemish.
				if (displayLabel) {
					const hazard = literalEscapeHazard(displayLabel);
					if (hazard) return toolError(literalEscapeReject("crosstalk_send", "displayLabel", hazard));
				}

				// Unconfined by design, and the recipient may be a foreign agent. Accepted because
				// mirrorPeer copies both legs into the owner's mailbox, so nothing leaves unseen.
				let files: ChannelFile[] = [];
				if (attachments?.length) {
					try {
						files = await readReplyAttachments(attachments);
					} catch (err) {
						return toolError(`Attachment error: ${(err as Error).message}`);
					}
				}

				const result = (await routerPost("/send", {
					from: bridgeProjectName(),
					fromConversationId: bridgeConversationId(),
					to,
					body,
					...(displayLabel ? { displayLabel } : {}),
					...(disposition ? { disposition } : {}),
					...(files.length > 0 ? { files } : {}),
				})) as SendResult;

				if (result.error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Bridge error: ${result.error}${result.available ? `\nAvailable: ${result.available.join(", ")}` : ""}`,
							},
						],
						isError: true,
					};
				}

				return formatResult(result, to);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to send: ${message}` }],
					isError: true,
				};
			}
		},
	);
}
