import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SPOKEN_TIER_FIELDS } from "../../shared/notice.js";
import { GuidedNoticeTiers } from "../../shared/schemas.js";
import type { ChannelFile } from "../../shared/types.js";
import { bridgeProjectName, routerPost } from "../bridge/helpers.js";
import { literalEscapeHazard, literalEscapeReject, readReplyAttachments, toolError } from "../bridge/replyTool.js";
import { type Capability, capabilityInstructions } from "../capabilities.js";
import { appendRefArtifacts } from "../references/attachRefs.js";

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

- \`title\` - notification-bar line
- \`summary\` - short text for console features
- \`full\` - message body under this team's name
- \`fullSpoken\` - spoken replacement for \`full\`

Use for milestones and critical blockers. Use \`channel_reply\` for conversational replies.
`.trim();

// This and `channel_reply` are the ONLY tools whose body is scanned for refs, so their descriptions
// are where the pointer to `switchboard_capabilities` has to reach an agent mid-reply.
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
			// A notice carries agent prose to the same console the chat does, so a ref written in one
			// deserves the same snapshot. `full` is the only field rendered as markdown, so it is the
			// only one scanned.
			const withRefs = await appendRefArtifacts(full, attached);
			if (!withRefs.ok) return toolError(withRefs.error);
			if (withRefs.files.length > 0) files = withRefs.files;
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
