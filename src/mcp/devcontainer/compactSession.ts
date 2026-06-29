import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { selfSessionTarget, sendText } from "./tmuxCore.js";

////////////////////////////////
//  Schemas

const CompactSessionSchema = z.object({
	instructions: z
		.string()
		.min(1)
		// Capped well above any real compaction prompt but below ARG_MAX, since the text now rides as a
		// single argv element. Null bytes are rejected: argv is null-terminated, so a stray NUL would
		// silently truncate the line (the old base64 path masked this).
		.max(16384)
		.refine((v) => !/[\r\n]/.test(v) && !v.includes("\u0000"), {
			message: "instructions must be a single line (no newlines or null bytes)",
		})
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
