import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertNotContainer } from "./helpers.js";

////////////////////////////////
//  Schemas

const SessionSendSchema = z.object({
	team: z.string().describe(`Team name (e.g. "evie-bot"). Resolves to container "{team}_devcontainer-dev-1".`),
	command: z
		.string()
		.describe(`Single line of input to send (e.g. "/model opus", "/effort high", "/reload-plugins").`),
});
type SessionSendArgs = z.infer<typeof SessionSendSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const sendSchema: any = SessionSendSchema;

////////////////////////////////
//  Functions & Helpers

const description = `
Send a single line of input to a team's Claude Code session (tmux pane 0).
Use session_peek before calling this to verify the session is idle and ready.
Use session_peek after calling this to confirm the command was accepted.
`.trim();

export function registerSessionSend(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"session_send",
		{
			title: "Session Send",
			description,
			inputSchema: sendSchema,
		},
		async (args: SessionSendArgs) => {
			try {
				assertNotContainer();

				const container = `${args.team}_devcontainer-dev-1`;

				// This agent-facing tool keeps its own recipe; the hardened, atomic send used by the
				// console terminal view lives in tmuxCore.ts (the canonical recipe). Keep the two in
				// mind together if the send-keys construction ever changes.
				// Use base64 encoding to avoid shell escaping issues
				const b64 = Buffer.from(args.command).toString("base64");
				execSync(
					`docker exec -u vscode "${container}" bash -c "tmux send-keys -t claude.0 -l \\"\\$(echo '${b64}' | base64 -d)\\" && tmux send-keys -t claude.0 Enter"`,
					{ encoding: "utf-8", timeout: 10_000 },
				);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{ team: args.team, container, command: args.command, sent: true },
								null,
								2,
							),
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
