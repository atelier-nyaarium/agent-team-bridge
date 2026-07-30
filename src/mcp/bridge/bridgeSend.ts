import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChannelFile, ResponsePayload } from "../../shared/types.js";
import { dropReferenceArtifacts } from "../channel/evieFiles.js";
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
				`Target session - paste the address exactly as crosstalk_discover prints it (domain.gateway.spawn.session) - never shorten it, a shortened address resolves locally instead of to the intended target. An online session receives it directly, no invite step needed, whether it already messaged you, your human named it, or you're addressing it unprompted. An asleep session is woken on send. A session-less spawn-point (domain.gateway.spawn, no session segment) is not itself a valid target - mint a new session under it instead by setting displayLabel (else the send fails, asking for one). A mint may pick a different session name than what you typed - the response names the resolved address; use that one for anything after the first message, not the address you originally sent to.`,
			),
		body: z
			.string()
			.optional()
			.describe(
				`Full Markdown formatted details of the request. Provide a detailed description and any context that would be helpful to the other team.`,
			),
		displayLabel: z
			.string()
			.min(1)
			.max(64)
			.optional()
			.describe(
				`Human-readable label for the new session (a short human name like "Bug Investigation", never a slug/id/machine-generated string) - required to create a not-yet-existing target; ignored when the target already exists.`,
			),
		session_id: z
			.string()
			.optional()
			.describe(
				`Polling only: pass a session_id (with no body) to peek at the latest result for an existing conversation. Omit this field for sends - channel conversations are auto-derived from the sender/target pair.`,
			),
		attachments: z
			.array(z.string())
			.optional()
			.describe(
				`Absolute paths to send alongside the body. The receiving agent gets them written to disk and listed as a [FILES] block of paths to Read, so this is how you hand a screenshot or a log to the other team for direct inspection. Requires a body.`,
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
Send a request to another team.

Two call patterns:
1. Send: provide to + body. The conversation with that team is automatically reused across all your messages; you do not manage session_ids.
2. Poll: provide session_id only (no body). Peeks at the latest stored result for an existing conversation without consuming it. Rarely needed for channel-mode teams since responses arrive via push.

Channel-mode teams (Claude): responses are pushed back automatically as <channel> notifications. No polling needed. The target team can reply multiple times (progress updates, phase reports) without closing the conversation; just keep watching the channel.

Set attachments (absolute paths) when the other team needs to see an artifact rather than a description of one, such as a screenshot or a failing log. They arrive written to disk with the paths listed for the recipient to Read, and replies can carry attachments back the same way.

The owner can see every exchange in their console.

When relaying responses back to the user, send them verbatim unless the user explicitly asked for a summary.
`.trim();

function formatResult(result: SendResult, to?: string): { content: Array<{ type: "text"; text: string }> } {
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
		parts.push(result.message || "Still running.");
		parts.push(`\nTo check again, call this tool with just session_id (no body).`);
	} else if (result.status === "error") {
		parts.push(`Error: ${result.reason ?? result.message ?? "Unknown error"}`);
	} else if (result.status === "timeout") {
		parts.push(result.message || `No response in time.`);
	} else {
		// Defensive catch-all: a ResponseStatus added later (or an absent status) would otherwise fall
		// through silently, dropping the body. Surface whatever text the payload carries.
		const body = result.response ?? result.message ?? result.reason;
		if (body) parts.push(`\n${body}`);
	}

	// The gateway strips base64 before persisting, so a polled reply can name its files but never
	// carry them. Naming them is what makes the loss recoverable by asking for a re-send.
	const attached = result.files ? dropReferenceArtifacts(result.files) : [];
	if (attached.length > 0) {
		parts.push(`\nAttachments named on this reply (the store keeps no bytes; ask for a re-send if you need them):`);
		// The name comes from the replying peer and this output is line-structured, so a newline in
		// it would forge entries, including the [session_id: ...] line an agent copies to thread.
		for (const f of attached) parts.push(`- ${f.filename.replace(/[\r\n]+/g, " ")}`);
	}

	if (result.session_id) parts.push(`\n[session_id: ${result.session_id}]`);

	return { content: [{ type: "text" as const, text: parts.join("\n") }] };
}

export function registerBridgeSend(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"crosstalk_send",
		{
			title: "Crosstalk Send",
			description,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: BridgeSendSchema as any,
		},
		async ({ to, body, session_id, displayLabel, attachments }: BridgeSendArgs) => {
			try {
				// Poll mode: session_id present, no body. Attachments exclude it too, or a threaded
				// send that carried files but no prose would poll and discard them silently.
				if (session_id && !body && !attachments?.length) {
					const result = (await routerPost("/poll", { session_id })) as SendResult;

					if (result.error) {
						return {
							content: [{ type: "text" as const, text: `Poll error: ${result.error}` }],
							isError: true,
						};
					}

					return formatResult(result, to);
				}

				// Send mode: requires to, body
				if (!to || !body) {
					throw new Error(`Provide to + body for sending, or just session_id for polling.`);
				}

				// displayLabel becomes a persistent human-rendered session label on the console board.
				// body stays unlinted as a deliberate trade: its PRIMARY consumer is the receiving
				// model (which reads escapes fine), and although a display copy does mirror to the
				// owner's console, rejecting real inter-team work over a cosmetic mirror is worse
				// than the blemish - especially since task bodies often carry unfenced code.
				if (displayLabel) {
					const hazard = literalEscapeHazard(displayLabel);
					if (hazard) return toolError(literalEscapeReject("crosstalk_send", "displayLabel", hazard));
				}

				// This reader is unconfined by design: any absolute path the session can read, with no
				// root or secret policy. Unlike a reply's, the recipient here can be a foreign agent in
				// a linked Domain, so the justification is not the one channel_reply's reader rests on.
				// Accepted because mirrorPeer copies both legs into the owner's mailbox, so nothing
				// leaves unseen.
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
