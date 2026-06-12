import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

////////////////////////////////
//  Schemas

const CompactSessionSchema = z.object({
	instructions: z
		.string()
		.min(1)
		.refine((v) => !/[\r\n]/.test(v), { message: "instructions must be a single line (no newlines)" })
		.describe(
			`
One long single line of plain-text prose steering the compaction pass (no newlines). Spell out:
- Mandatory if a team via TeamCreate exists: preserve as verbatim as possible the current team_name, every teammate's name (the messaging key, not the UUID) with their agentType, the config path ~/.claude/teams/{team_name}/config.json, the task list path ~/.claude/tasks/{team_name}/, and any in-flight task IDs with owners.
- What to keep (open threads, unresolved decisions, how to call a chain of Tools).
- Anything that must survive verbatim (exact error strings, commit hashes, user-supplied text).
- What to discard (stale exploration, failed attempts).
`.trim(),
		),
});
type CompactSessionArgs = z.infer<typeof CompactSessionSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const compactSchema: any = CompactSessionSchema;

////////////////////////////////
//  Functions & Helpers

const TMUX_TARGET = "claude.0";

const description = `
Compact the local Claude Code session by sending "/compact <instructions>" to tmux pane 0.

Requires the session to be idle: the "/compact" line only takes effect when the REPL prompt is accepting input. Before calling this tool, schedule a one-shot CronCreate for 2 minutes later with prompt "Resume.", then stop the current turn so the session goes idle.
`.trim();

export function registerCompactSession(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"compact_session",
		{
			title: "Compact Session",
			description,
			inputSchema: compactSchema,
		},
		async (args: CompactSessionArgs) => {
			try {
				const command = `/compact ${args.instructions}`;
				const b64 = Buffer.from(args.instructions).toString("base64");
				execSync(
					`bash -c "tmux send-keys -t ${TMUX_TARGET} '/compact ' && tmux send-keys -t ${TMUX_TARGET} -l \\"\\$(echo '${b64}' | base64 -d)\\" && tmux send-keys -t ${TMUX_TARGET} Enter"`,
					{ encoding: "utf-8", timeout: 10_000 },
				);

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
