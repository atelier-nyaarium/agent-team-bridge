import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { selfSessionTarget, sendText } from "./tmuxCore.js";

////////////////////////////////
//  Schemas

const CompactSessionSchema = z
	.object({
		instructions: z
			.string()
			.min(1)
			// One argv element, so it is capped below ARG_MAX and a NUL would truncate the line.
			.max(16384)
			.refine((v) => !/[\r\n]/.test(v) && !v.includes("\u0000"), {
				message: `instructions must be a single line (no newlines or null bytes)`,
			})
			.describe(
				`
Compaction instructions. One plain-text line with no newlines.

## Preserve

- Open threads, unresolved decisions, and tool-call sequences.
- Exact error strings, commit hashes, and user-supplied text.
- Exclude stale exploration and failed attempts.

## Team state

If a team exists via \`TeamCreate\`, preserve as verbatim as possible:

- the current \`team_name\`
- each teammate's messaging name, not UUID, with \`agentType\`
- \`~/.claude/teams/{team_name}/config.json\`
- \`~/.claude/tasks/{team_name}/\`
- in-flight task IDs and owners
`.trim(),
			),
	})
	.strict();
type CompactSessionArgs = z.infer<typeof CompactSessionSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const compactSchema: any = CompactSessionSchema;

////////////////////////////////
//  Functions & Helpers

const description = `
# Compact Session

Send \`/compact <instructions>\` to local tmux pane \`0\`.

## Idle session

\`/compact\` only works when the REPL prompt accepts input.

Before calling, schedule one-shot \`CronCreate\` for two minutes later with prompt \`Resume.\`, then stop the current turn.
`.trim();

export function registerCompactSession(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"compact_session",
		{
			title: `Compact Session`,
			description,
			inputSchema: compactSchema,
		},
		async (args: CompactSessionArgs) => {
			try {
				const command = `/compact ${args.instructions}`;
				await sendText(selfSessionTarget(), command);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ instructions: args.instructions, command, sent: true }, null, 2),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ errors: [{ message: (error as Error).message }] }, null, 2),
						},
					],
					isError: true,
				};
			}
		},
	);
}
