import os from "node:os";
import path from "node:path";
import { startHostDaemon, stopSupervisedChildren } from "./mcp/devcontainer/hostDaemon.js";
import { installRejectionGuard } from "./shared/process-guards.js";

// The headless host daemon: it claims the gateway's reserved "host" WS slot and owns the host
// plumbing - the devcontainer catalog scan, on-demand container wake, and the console terminal-view
// host_op (peek + tmux_send). It carries no Claude session and registers no MCP tools, so the
// conversational agents on this machine run as ordinary loose peers. start-host-daemon.sh launches
// it; HOST_WS_TOKEN authenticates the reserved slot and BRIDGE_ROUTER_URL points at the gateway.

// A daemon owning the host slot, catalog, wake, and every console host_op must outlive any single
// stray rejection (e.g. a tmux peek of a session whose server just exited). An uncaughtException
// may mean corrupt state, so log and exit for start-host-daemon.sh's respawn loop to restart clean.
installRejectionGuard("host-daemon");
process.on("uncaughtException", (err) => {
	console.error("[host-daemon] uncaughtException:", err);
	stopSupervisedChildren();
	process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stopSupervisedChildren();
		process.exit(0);
	});
}

const projectDirs = [path.join(os.homedir(), "projects")];
startHostDaemon(projectDirs);
console.error("[host-daemon] started");
