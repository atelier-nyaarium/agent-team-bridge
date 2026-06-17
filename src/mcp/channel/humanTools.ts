import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NoticeFull, NoticeLegacyTiny, NoticeSummary, NoticeTitle } from "../../shared/notice.js";
import type { ChannelFile } from "../../shared/types.js";
import { bridgeProjectName, routerPost } from "../bridge/helpers.js";
import { readReplyAttachment } from "../bridge/replyTool.js";

////////////////////////////////
//  Schemas

// title is optional ONLY to accept the legacy `tiny` alias during the rename
// transition; the handler requires one of the two. summary/full stay required
// (no ghost ping that is only a bar headline). `.strict()` rejects a typo'd
// field instead of silently dropping it, and it preserves `.shape`, so the MCP
// registration is unaffected (unlike `.refine`/`.preprocess`, which drop shape).
const NotifyHumanSchema = z
	.object({
		title: NoticeTitle.optional(),
		tiny: NoticeLegacyTiny,
		summary: NoticeSummary,
		full: NoticeFull,
		attachments: z
			.array(z.string())
			.optional()
			.describe(`Optional absolute file paths to attach (screenshots, logs). Images render inline on the phone.`),
	})
	.strict();
type NotifyHumanArgs = z.infer<typeof NotifyHumanSchema>;

////////////////////////////////
//  Functions & Helpers

const NOTIFY_DESCRIPTION = `
Push a notification to the human's phone(s). Broadcasts to every registered phone device: \`title\` becomes the notification-bar line, \`summary\` rides as its own short tier (phone features read it directly), and \`full\` the message body, threaded under your team's name. title, summary, and full are all required - a notice must always carry a real body. Use for milestone reports (cycle ends, long-job completion, critical blockers) - not for conversational replies (use channel_reply for those).
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
			const { summary, full, attachments } = args;
			const title = args.title ?? args.tiny;
			if (!title) {
				return {
					content: [{ type: "text" as const, text: `Notify failed: title is required.` }],
					isError: true,
				};
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
					// Send BOTH keys for the transition: an old arbiter reads `tiny`,
					// a new one reads `title` (or `tiny`). Drop `tiny` once arbiters
					// are caught up.
					title,
					tiny: title,
					summary,
					full,
					...(files ? { files } : {}),
				})) as { delivered?: number };
				const delivered = result.delivered ?? 0;
				return {
					content: [
						{
							type: "text" as const,
							text: `Notice delivered to ${delivered} phone(s).${delivered === 0 ? " No phones are currently registered; it was not queued." : ""}`,
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
