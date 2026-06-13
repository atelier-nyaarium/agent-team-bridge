import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

////////////////////////////////
//  Schemas

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const SetEffortLevelSchema = z.object({
	level: z.enum(EFFORT_LEVELS).describe(
		`
Effort level to set on the local Claude Code session.
  low:    Quick, straightforward implementation with minimal overhead
  medium: Balanced approach with standard implementation and testing
  high:   Comprehensive implementation with extensive testing and documentation
  xhigh:  Deeper reasoning than high, just below maximum
  max:    Maximum capability with deepest reasoning
`.trim(),
	),
});
type SetEffortLevelArgs = z.infer<typeof SetEffortLevelSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const setEffortSchema: any = SetEffortLevelSchema;

////////////////////////////////
//  Functions & Helpers

const TMUX_TARGET = "claude.0";

const description = `
Set the effort level on the local Claude Code session by sending "/effort <level>" to tmux pane 0.

Requires the session to be idle: the "/effort" line only takes effect when the REPL prompt is accepting input. Before calling this tool, schedule a one-shot CronCreate for 2 minutes later with prompt "Resume.", then stop the current turn so the session goes idle.
`.trim();

export function registerSetEffortLevel(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"set_effort_level",
		{
			title: "Set Effort Level",
			description,
			inputSchema: setEffortSchema,
		},
		async (args: SetEffortLevelArgs) => {
			try {
				const command = `/effort ${args.level}`;
				const b64 = Buffer.from(command).toString("base64");
				execSync(
					`bash -c "tmux send-keys -t ${TMUX_TARGET} -l \\"\\$(echo '${b64}' | base64 -d)\\" && tmux send-keys -t ${TMUX_TARGET} Enter"`,
					{ encoding: "utf-8", timeout: 10_000 },
				);

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
