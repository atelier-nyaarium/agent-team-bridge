import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isInsideContainer } from "../../shared/env.js";
import { assertTmuxName, type TmuxTarget } from "../../shared/host-op.js";

////////////////////////////////
//  Schemas

const ReloadPluginsSchema = z.object({
	team: z
		.string()
		.optional()
		.describe(
			`Host-only. Team name to target (e.g. "evie-bot"). Resolves to container "{team}_devcontainer-dev-1". Omit to target the host's own session.`,
		),
});
type ReloadPluginsArgs = z.infer<typeof ReloadPluginsSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const reloadSchema: any = ReloadPluginsSchema;

////////////////////////////////
//  Functions & Helpers

// The MCP tool drives the agent's own session, which always runs in the conventional "claude" pane.
const TMUX_SESSION = "claude";

function buildTmuxFn(tmuxPrefix: string): string {
	// For docker exec, wrap the tmux binary call; for local, call tmux directly
	if (tmuxPrefix === "tmux") {
		return `tmux_cmd() { tmux "$@"; }`;
	}
	// docker exec prefix: extract the container portion
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

# /reload-plugins
send_text "/reload-plugins"
sleep 5

# Reconnect an MCP server by name via the /mcp menu.
# Navigates down until the selection indicator is on a line matching the pattern.
# Prioritize plugin:*:switchboard over plain switchboard.
reconnect_mcp() {
	local PATTERN="$1"
	send_text "/mcp"
	sleep 2

	local FOUND=false
	for _ in $(seq 1 20); do
		sleep 1
		SCREEN=$(capture_pane)
		if echo "$SCREEN" | grep -qE "\u276f.*$PATTERN"; then
			FOUND=true
			break
		fi
		send_key Down
	done

	if [ "$FOUND" = true ]; then
		send_key Enter
		sleep 1

		# Navigate submenu to find Reconnect or Enable
		local ACTION_FOUND=false
		for _ in $(seq 1 5); do
			sleep 1
			SCREEN=$(capture_pane)
			if echo "$SCREEN" | grep -qE '\u276f.*(Reconnect|Enable)'; then
				ACTION_FOUND=true
				break
			fi
			send_key Down
		done

		if [ "$ACTION_FOUND" = true ]; then
			send_key Enter
			sleep 5
		else
			send_key Escape
			sleep 1
		fi
	else
		send_key Escape
		sleep 1
	fi
}

reconnect_mcp "nyaascripts"
reconnect_mcp "plugin:.*switchboard"
# Reconnect the nyaaskills cycle MCP too, so a plugin update flips the
# switchboard/nyaaskills pair together in one live session (otherwise a
# renamed cycle tool stays stale until the next manual reconnect).
reconnect_mcp "plugin:.*nyaaskills"

echo "Reload sequence complete."
`;
}

// Write the script to a temp file and spawn it detached so it outlives the caller (the MCP tool
// call or the host_op relay): it drives the target session for ~40s after we have returned.
function writeAndSpawn(script: string): string {
	const scriptPath = path.join(os.tmpdir(), `reload-plugins-${Date.now()}.sh`);
	fs.writeFileSync(scriptPath, script, { mode: 0o755 });
	const child = spawn("bash", [scriptPath], { detached: true, stdio: "ignore" });
	// A spawn 'error' (e.g. resource exhaustion) on a child with no error listener throws as an
	// uncaughtException; log it instead so a failed reload can never take the daemon down.
	child.on("error", (err) => console.error("[reload-plugins] spawn failed:", err));
	child.unref();
	return scriptPath;
}

/** Daemon entry: drive a target session through the plugin update + MCP reconnect sequence. The
 * host daemon runs on the host, so a host target uses bare tmux and a devcontainer target reaches
 * its tmux via docker exec. Returns immediately (the script runs detached). */
export function spawnReloadPlugins(target: TmuxTarget): string {
	// The session name reaches the script as the PANE token and the container name reaches the docker
	// exec prefix; both are shell-interpolated, so a non-slug would be an injection vector.
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
Automate the full plugin update and MCP reconnect sequence for a Claude Code session.
Spawns a background script that drives the tmux session through:
1. /plugin update on the atelier-nyaarium marketplace (covers both switchboard and nyaaskills)
2. /reload-plugins
3. /mcp reconnect nyaascripts
4. /mcp reconnect plugin:switchboard (prioritized over plain switchboard)
5. /mcp reconnect plugin:nyaaskills (so the switchboard/nyaaskills pair flips together)

The tool returns immediately. The script waits for the current tool call to finish before starting.
On the host, omit 'team' to target the host session, or provide 'team' to target a devcontainer.
In a container, always targets the local session (team param is ignored).
`.trim();

export function registerReloadPlugins(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"reload_plugins",
		{
			title: "Reload Plugins",
			description,
			inputSchema: reloadSchema,
		},
		async (args: ReloadPluginsArgs) => {
			try {
				const inContainer = isInsideContainer();

				let tmuxPrefix: string;
				let targetLabel: string;

				if (inContainer) {
					tmuxPrefix = "tmux";
					targetLabel = "self (container)";
				} else if (args.team) {
					// team is shell-interpolated into the docker exec prefix; assert the slug here too
					// (the daemon path spawnReloadPlugins already does), or a crafted name injects.
					assertTmuxName(args.team);
					const container = `${args.team}_devcontainer-dev-1`;
					tmuxPrefix = `docker exec -u vscode "${container}" tmux`;
					targetLabel = `container: ${container}`;
				} else {
					tmuxPrefix = "tmux";
					targetLabel = "self (host)";
				}

				const scriptPath = writeAndSpawn(buildScript(tmuxPrefix, TMUX_SESSION));

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									initiated: true,
									target: targetLabel,
									scriptPath,
									note: "Background script starts ~3s after this tool call completes. Full sequence takes about 40 seconds.",
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
