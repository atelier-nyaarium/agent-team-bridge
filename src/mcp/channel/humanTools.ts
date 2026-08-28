import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SPOKEN_TIER_FIELDS } from "../../shared/notice.js";
import { GuidedNoticeTiers } from "../../shared/schemas.js";
import type { ChannelFile } from "../../shared/types.js";
import { bridgeProjectName, routerPost } from "../bridge/helpers.js";
import { literalEscapeHazard, literalEscapeReject, readReplyAttachments, toolError } from "../bridge/replyTool.js";
import { type Capability, capabilityInstructions } from "../capabilities.js";
import { appendRefArtifacts, withNotices } from "../references/attachRefs.js";

////////////////////////////////
//  Schemas

// Every tier required, and strict so a retired field is rejected rather than stripped. Shares
// channel_reply's own GuidedNoticeTiers, so both describes are identical by construction.
export const NotifyHumanSchema = z
	.object({
		...GuidedNoticeTiers,
		attachments: z
			.array(z.string())
			.optional()
			.describe(`Optional absolute attachment paths. Images render inline on the console.`),
	})
	.strict();
type NotifyHumanArgs = z.infer<typeof NotifyHumanSchema>;

////////////////////////////////
//  Functions & Helpers

const NOTIFY_DESCRIPTION = `
# Notify Human

Push a notification to every registered console.

## Required fields

- \`title\`: notification-bar line.
- \`summary\`: short text for console features.
- \`full\`: message body under this team's name.
- \`fullSpoken\`: spoken replacement for \`full\`.

Use for milestones and critical blockers. Use \`channel_reply\` for conversational replies.
`.trim();

// Only this and `channel_reply` scan for refs, so their descriptions carry the capabilities pointer.
export function registerHumanTools(mcpServer: McpServer, capabilities: Capability[] = []): void {
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const notifySchema: any = NotifyHumanSchema;

	mcpServer.registerTool(
		"notify_human",
		{
			title: "Notify Human",
			description: `${NOTIFY_DESCRIPTION}${capabilityInstructions(capabilities)}`.trim(),
			inputSchema: notifySchema,
		},
		async (args: NotifyHumanArgs) => {
			const { title, summary, full, fullSpoken, attachments } = args;
			// Before file reads and the POST, so a reject costs nothing. `full` is this surface's own
			// body field name, which renames per surface.
			for (const field of [...SPOKEN_TIER_FIELDS, "full"] as const) {
				const value = args[field];
				if (typeof value !== "string") continue;
				const hazard = literalEscapeHazard(value);
				if (hazard) return toolError(literalEscapeReject("notify_human", field, hazard));
			}
			let files: ChannelFile[] | undefined;
			let attached: Awaited<ReturnType<typeof readReplyAttachments>> = [];
			if (attachments?.length) {
				try {
					attached = await readReplyAttachments(attachments);
				} catch (err) {
					return {
						content: [{ type: "text" as const, text: `Attachment error: ${(err as Error).message}` }],
						isError: true,
					};
				}
			}
			// `full` is the only field rendered as markdown, so it is the only one scanned.
			const withRefs = await appendRefArtifacts(full, attached);
			if (!withRefs.ok) return toolError(withRefs.error);
			if (withRefs.files.length > 0) files = withRefs.files;
			try {
				// routerPost throws with the server's own message on any non-ok response.
				const result = (await routerPost("/human/notify", {
					from: bridgeProjectName() || "unknown",
					title,
					summary,
					full,
					fullSpoken,
					...(files ? { files } : {}),
				})) as { delivered?: boolean };
				return withNotices(
					{
						content: [
							{
								type: "text" as const,
								text: result.delivered ? `Notice delivered.` : `Notice not delivered.`,
							},
						],
					},
					withRefs.notices,
				);
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Notify failed: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}
