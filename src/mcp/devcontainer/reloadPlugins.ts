import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isInsideContainer } from "../../shared/env.js";
import { assertTmuxName, type TmuxTarget } from "../../shared/host-op.js";
import { DEFAULT_SESSION } from "../../shared/session-id.js";
import { selfSessionTarget } from "./tmuxCore.js";

////////////////////////////////
//  Schemas

const ReloadPluginsSchema = z.object({
	team: z
		.string()
		.optional()
		.describe(
			`
Host-only target \`team\`, e.g. \`evie-bot\`.

Resolves to \`{team}_devcontainer-dev-1\`. Omit for the host session.
`.trim(),
		),
});
type ReloadPluginsArgs = z.infer<typeof ReloadPluginsSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const reloadSchema: any = ReloadPluginsSchema;

////////////////////////////////
//  Functions & Helpers

function buildTmuxFn(tmuxPrefix: string): string {
	if (tmuxPrefix === "tmux") {
		return `tmux_cmd() { tmux "$@"; }`;
	}
	return `tmux_cmd() { ${tmuxPrefix} "$@"; }`;
}

function buildScript(tmuxPrefix: string, sessionName: string): string {
	return `#!/bin/bash
set -euo pipefail

${buildTmuxFn(tmuxPrefix)}

PANE="${sessionName}.0"

capture_pane() {
	tmux_cmd capture-pane -t "$PANE" -p
}

send_key() {
	tmux_cmd send-keys -t "$PANE" "$1"
	sleep 1
}

send_text() {
	tmux_cmd send-keys -t "$PANE" -l "$1"
	tmux_cmd send-keys -t "$PANE" Enter
}

# Wait for the MCP tool call to finish before driving the session
sleep 3

# Check the session is idle
SCREEN=$(capture_pane)
if ! echo "$SCREEN" | grep -q '\u276f'; then
	echo "Session does not appear idle. Aborting." >&2
	exit 1
fi

# /plugin - update marketplaces
send_text "/plugin"
sleep 2
send_key Right
send_key Right
sleep 1

# Navigate to the atelier-nyaarium umbrella marketplace and mark for update.
# One row now covers both switchboard and nyaaskills since they share a marketplace.
for _ in $(seq 1 10); do
	sleep 1
	SCREEN=$(capture_pane)
	if echo "$SCREEN" | grep -qE '\u276f.*atelier-nyaarium'; then
		send_key "u"
		break
	fi
	send_key Down
done

send_key Enter
sleep 20

# /reload-plugins, which reconnects the plugin MCP servers itself. Driving the /mcp menu afterwards
# only re-does that, and tearing a live connection down mid-call fails whatever was in flight.
send_text "/reload-plugins"
sleep 5

echo "Reload sequence complete."
`;
}

// Detached: it drives the session for ~40s after we return.
function writeAndSpawn(script: string): string {
	const scriptPath = path.join(os.tmpdir(), `reload-plugins-${Date.now()}.sh`);
	fs.writeFileSync(scriptPath, script, { mode: 0o755 });
	const child = spawn("bash", [scriptPath], { detached: true, stdio: "ignore" });
	// An unlistened spawn error throws as an uncaughtException.
	child.on("error", (err) => console.error("[reload-plugins] spawn failed:", err));
	child.unref();
	return scriptPath;
}

/** Daemon entry. Returns immediately; the script runs detached. */
export function spawnReloadPlugins(target: TmuxTarget): string {
	// Both names are shell-interpolated into the script.
	assertTmuxName(target.sessionName);
	let tmuxPrefix: string;
	if (target.kind === "host") {
		tmuxPrefix = "tmux";
	} else {
		assertTmuxName(target.name);
		tmuxPrefix = `docker exec -u vscode "${target.name}_devcontainer-dev-1" tmux`;
	}
	return writeAndSpawn(buildScript(tmuxPrefix, target.sessionName));
}

const description = `
# Reload Plugins

Update plugins for a Claude Code session.

## Sequence

1. \`/plugin\` update in the \`atelier-nyaarium\` marketplace, covering \`switchboard\` and \`nyaaskills\`.
2. \`/reload-plugins\`, which reconnects plugin MCP servers.

Returns immediately. The script waits for the current tool call to finish.

## Targeting

- On the host, omit \`team\` for this session or provide it for a devcontainer.
- In a container, targets this session and ignores \`team\`.
`.trim();

export function registerReloadPlugins(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"reload_plugins",
		{
			title: `Reload Plugins`,
			description,
			inputSchema: reloadSchema,
		},
		async (args: ReloadPluginsArgs) => {
			try {
				const inContainer = isInsideContainer();

				let tmuxPrefix: string;
				let targetLabel: string;
				// A self target reloads the pane it registered under, from PROJECT_NAME. A cross-container
				// team has no session id, so it drives that container's conventional pane.
				let sessionName: string;

				if (inContainer) {
					tmuxPrefix = "tmux";
					targetLabel = `self (container)`;
					sessionName = selfSessionTarget().sessionName;
				} else if (args.team) {
					// Shell-interpolated into the docker exec prefix.
					assertTmuxName(args.team);
					const container = `${args.team}_devcontainer-dev-1`;
					tmuxPrefix = `docker exec -u vscode "${container}" tmux`;
					targetLabel = `container: ${container}`;
					sessionName = DEFAULT_SESSION;
				} else {
					tmuxPrefix = "tmux";
					targetLabel = `self (host)`;
					sessionName = selfSessionTarget().sessionName;
				}

				// A hand-set composite could make PROJECT_NAME's session non-slug.
				assertTmuxName(sessionName);
				const scriptPath = writeAndSpawn(buildScript(tmuxPrefix, sessionName));

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									initiated: true,
									target: targetLabel,
									scriptPath,
									note: `Background script starts ~3s after this tool call completes. Full sequence takes about 40 seconds.`,
								},
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
