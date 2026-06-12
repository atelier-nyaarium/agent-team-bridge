import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChannelFile } from "../../shared/types.js";
import { bridgeProjectName, routerPost } from "./helpers.js";
import { readReplyAttachment } from "./replyTool.js";

////////////////////////////////
//  Schemas

const NotifyHumanSchema = z.object({
	tiny: z.string().min(1).max(200).describe(`One phrase for the phone's notification bar (~60 chars).`),
	full: z
		.string()
		.optional()
		.describe(`Optional full markdown report (mermaid renders too). Shown as the message body on the phone.`),
	attachments: z
		.array(z.string())
		.optional()
		.describe(`Optional absolute file paths to attach (screenshots, logs). Images render inline on the phone.`),
});
type NotifyHumanArgs = z.infer<typeof NotifyHumanSchema>;

////////////////////////////////
//  Functions & Helpers

const DESCRIPTION = `
Push a notification to the human's phone(s). Broadcasts to every registered phone device: \`tiny\` becomes the notification-bar line and \`full\` the message body, threaded under your team's name. Use for milestone reports (cycle ends, long-job completion, critical blockers) - not for conversational replies (use channel_reply / respond_to_human for those).
`.trim();

export function registerNotifyHuman(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"notify_human",
		{
			title: "notify-human",
			description: DESCRIPTION,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: NotifyHumanSchema as any,
		},
		async (args: NotifyHumanArgs) => {
			const { tiny, full, attachments } = NotifyHumanSchema.parse(args);
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
					tiny,
					...(full ? { full } : {}),
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
