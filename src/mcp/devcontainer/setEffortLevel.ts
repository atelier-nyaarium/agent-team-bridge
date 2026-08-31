import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { selfSessionTarget, sendText } from "./tmuxCore.js";

////////////////////////////////
//  Schemas

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const SetEffortLevelSchema = z
	.object({
		level: z.enum(EFFORT_LEVELS).describe(
			`
Effort level to set on the local Claude Code session.

- \`low\`: quick, straightforward, minimal overhead.
- \`medium\`: balanced implementation and testing.
- \`high\`: comprehensive implementation, testing, and documentation.
- \`xhigh\`: deeper reasoning than high, just below maximum.
- \`max\`: maximum capability, deepest reasoning.
`.trim(),
		),
	})
	.strict();
type SetEffortLevelArgs = z.infer<typeof SetEffortLevelSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const setEffortSchema: any = SetEffortLevelSchema;

////////////////////////////////
//  Functions & Helpers

const description = `
# Set Effort Level

Send \`/effort <level>\` to local tmux pane \`0\`.

## Idle session

\`/effort\` only works when the REPL prompt accepts input.

Before calling, schedule one-shot \`CronCreate\` for two minutes later with prompt \`Resume.\`, then stop the current turn.
`.trim();

export function registerSetEffortLevel(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"set_effort_level",
		{
			title: `Set Effort Level`,
			description,
			inputSchema: setEffortSchema,
		},
		async (args: SetEffortLevelArgs) => {
			try {
				const command = `/effort ${args.level}`;
				await sendText(selfSessionTarget(), command);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ level: args.level, command, sent: true }, null, 2),
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
