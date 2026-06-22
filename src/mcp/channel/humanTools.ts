import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NoticeFull, NoticeSummary, NoticeTitle } from "../../shared/notice.js";
import type { ChannelFile } from "../../shared/types.js";
import { bridgeProjectName, routerPost } from "../bridge/helpers.js";
import { readReplyAttachment } from "../bridge/replyTool.js";

////////////////////////////////
//  Schemas

// title, summary, and full are all required (no ghost ping that is only a bar
// headline). The object stays NON-strict so a stray `tiny` from a not-yet-updated
// caller is silently stripped rather than rejected during the deploy window.
const NotifyHumanSchema = z.object({
	title: NoticeTitle,
	summary: NoticeSummary,
	full: NoticeFull,
	attachments: z
		.array(z.string())
		.optional()
		.describe(`Optional absolute file paths to attach (screenshots, logs). Images render inline on the console.`),
});
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
				})) as { delivered?: number };
				const delivered = result.delivered ?? 0;
				return {
					content: [
						{
							type: "text" as const,
							text: `Notice delivered to ${delivered} console(s).${delivered === 0 ? " No consoles are currently registered; it was not queued." : ""}`,
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
