import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SPOKEN_TIER_FIELDS } from "../../shared/notice.js";
import { GuidedNoticeTiers } from "../../shared/schemas.js";
import type { ChannelFile } from "../../shared/types.js";
import { bridgeProjectName, routerPost } from "../bridge/helpers.js";
import { literalEscapeHazard, literalEscapeReject, readReplyAttachment, toolError } from "../bridge/replyTool.js";

////////////////////////////////
//  Schemas

// Every tier is required (no ghost ping that is only a bar headline, and no notice
// the console cannot speak). Strict: an unknown field (e.g. the retired `tiny`) is
// rejected, not silently stripped. The tier fields are the SAME GuidedNoticeTiers
// object channel_reply spreads, so both tools' describes are identical by construction.
export const NotifyHumanSchema = z
	.object({
		...GuidedNoticeTiers,
		attachments: z
			.array(z.string())
			.optional()
			.describe(
				`Optional absolute file paths to attach (screenshots, logs). Images render inline on the console.`,
			),
	})
	.strict();
type NotifyHumanArgs = z.infer<typeof NotifyHumanSchema>;

////////////////////////////////
//  Functions & Helpers

const NOTIFY_DESCRIPTION = `
Push a notification to the human's console(s). Broadcasts to every registered console device: \`title\` becomes the notification-bar line, \`summary\` rides as its own short tier (console features read it directly), \`full\` the message body threaded under your team's name, and \`fullSpoken\` what the console speaks in full's place. All four are required. Use for milestone reports (cycle ends, long-job completion, critical blockers) - not for conversational replies (use channel_reply for those).
`.trim();

export function registerHumanTools(mcpServer: McpServer): void {
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const notifySchema: any = NotifyHumanSchema;

	mcpServer.registerTool(
		"notify_human",
		{
			title: "Notify Human",
			description: NOTIFY_DESCRIPTION,
			inputSchema: notifySchema,
		},
		async (args: NotifyHumanArgs) => {
			const { title, summary, full, fullSpoken, attachments } = args;
			// Before attachment materialization (file reads) and before the POST, so a reject costs
			// nothing. The spoken trio comes from the shared field list; `full` is this surface's own
			// body field name (it renames per surface, so each lint loop appends its own). Non-string
			// values are clean by definition, matching postReply's own loop.
			for (const field of [...SPOKEN_TIER_FIELDS, "full"] as const) {
				const value = args[field];
				if (typeof value !== "string") continue;
				const hazard = literalEscapeHazard(value);
				if (hazard) return toolError(literalEscapeReject("notify_human", field, hazard));
			}
			let files: ChannelFile[] | undefined;
			if (attachments?.length) {
				try {
					files = await Promise.all(attachments.map(readReplyAttachment));
				} catch (err) {
					return {
						content: [{ type: "text" as const, text: `Attachment error: ${(err as Error).message}` }],
						isError: true,
					};
				}
			}
			try {
				// routerPost parses the JSON and throws on any non-ok response with
				// the server's error message (including the 413 cap and 503 no-bridge).
				const result = (await routerPost("/human/notify", {
					from: bridgeProjectName() || "unknown",
					title,
					summary,
					full,
					fullSpoken,
					...(files ? { files } : {}),
				})) as { delivered?: boolean };
				return {
					content: [
						{
							type: "text" as const,
							text: result.delivered ? "Notice delivered." : "Notice not delivered.",
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Notify failed: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}
