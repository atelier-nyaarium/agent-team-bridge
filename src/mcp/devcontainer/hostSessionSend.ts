import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertNotContainer } from "./helpers.js";

////////////////////////////////
//  Schemas

const HostSessionSendSchema = z.object({
	command: z
		.string()
		.describe(`Single line of input to send (e.g. "/model opus", "/effort high", "/reload-plugins").`),
});
type HostSessionSendArgs = z.infer<typeof HostSessionSendSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const sendSchema: any = HostSessionSendSchema;

////////////////////////////////
//  Functions & Helpers

const TMUX_TARGET = "claude.0";

const description = `
Send a single line of input to the host Claude Code session (tmux pane 0).
Use host_session_peek before calling this to verify the session is idle and ready.
Use host_session_peek after calling this to confirm the command was accepted.
`.trim();

export function registerHostSessionSend(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"host_session_send",
		{
			title: "Host Session Send",
			description,
			inputSchema: sendSchema,
		},
		async (args: HostSessionSendArgs) => {
			try {
				assertNotContainer();

				// This agent-facing tool keeps its own recipe; tmuxCore.ts holds the hardened, atomic
				// send used by the console terminal view (the canonical recipe to mirror on a change).
				const b64 = Buffer.from(args.command).toString("base64");
				execSync(
					`bash -c "tmux send-keys -t ${TMUX_TARGET} -l \\"\\$(echo '${b64}' | base64 -d)\\" && tmux send-keys -t ${TMUX_TARGET} Enter"`,
					{ encoding: "utf-8", timeout: 10_000 },
				);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ target: "host", command: args.command, sent: true }, null, 2),
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
