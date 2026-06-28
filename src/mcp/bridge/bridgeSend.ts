import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResponsePayload } from "../../shared/types.js";
import { bridgeConversationId, bridgeProjectName, routerPost } from "./helpers.js";

////////////////////////////////
//  Schemas

const BridgeSendSchema = z
	.object({
		to: z
			.string()
			.optional()
			.describe(
				`Target session. A devcontainer session is project.session; use crosstalk_discover to list them. An online session receives it directly; an asleep or not-yet-existing project.session is woken / created on send.`,
			),
		body: z
			.string()
			.optional()
			.describe(
				`Full Markdown formatted details of the request. Provide a detailed description and any context that would be helpful to the other team.`,
			),
		session_id: z
			.string()
			.optional()
			.describe(
				`Polling only: pass a session_id (with no body) to peek at the latest result for an existing conversation. Omit this field for sends - channel conversations are auto-derived from the sender/target pair.`,
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
1. Send: provide to + body. The conversation with that team is automatically reused across all your messages — you do not manage session_ids.
2. Poll: provide session_id only (no body). Peeks at the latest stored result for an existing conversation without consuming it. Rarely needed for channel-mode teams since responses arrive via push.

Channel-mode teams (Claude): responses are pushed back automatically as <channel> notifications. No polling needed. The target team can reply multiple times (progress updates, phase reports) without closing the conversation; just keep watching the channel.

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
		async ({ to, body, session_id }: BridgeSendArgs) => {
			try {
				// Poll mode: session_id present, no body
				if (session_id && !body) {
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

				const result = (await routerPost("/send", {
					from: bridgeProjectName(),
					fromConversationId: bridgeConversationId(),
					to,
					body,
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
