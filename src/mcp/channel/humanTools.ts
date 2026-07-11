import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NoticeFull, NoticeSummary, NoticeTitle } from "../../shared/notice.js";
import { REAL_NEWLINES_GUIDANCE } from "../../shared/schemas.js";
import type { ChannelFile } from "../../shared/types.js";
import { bridgeProjectName, routerPost } from "../bridge/helpers.js";
import { literalEscapeHazard, literalEscapeReject, readReplyAttachment, toolError } from "../bridge/replyTool.js";

////////////////////////////////
//  Schemas

// title, summary, and full are all required (no ghost ping that is only a bar
// headline). Strict: an unknown field (e.g. the retired `tiny`) is rejected, not
// silently stripped. The notice leaf's describes are extended in place (not edited
// at the source) because notice.ts is a synced verbatim-copy module.
const NotifyHumanSchema = z
	.object({
		title: NoticeTitle.describe(`${NoticeTitle.description}${REAL_NEWLINES_GUIDANCE}`),
		summary: NoticeSummary.describe(`${NoticeSummary.description}${REAL_NEWLINES_GUIDANCE}`),
		full: NoticeFull.describe(`${NoticeFull.description}${REAL_NEWLINES_GUIDANCE}`),
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
Push a notification to the human's console(s). Broadcasts to every registered console device: \`title\` becomes the notification-bar line, \`summary\` rides as its own short tier (console features read it directly), and \`full\` the message body, threaded under your team's name. title, summary, and full are all required - a notice must always carry a real body. Use for milestone reports (cycle ends, long-job completion, critical blockers) - not for conversational replies (use channel_reply for those).
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
			const { title, summary, full, attachments } = args;
			// Before attachment materialization (file reads) and before the POST, so a reject costs nothing.
			for (const [field, value] of [
				["title", title],
				["summary", summary],
				["full", full],
			] as const) {
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
