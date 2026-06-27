import os from "node:os";
import path from "node:path";
import { startHostDaemon } from "./mcp/devcontainer/hostDaemon.js";

// The headless host daemon: it claims the gateway's reserved "host" WS slot and owns the host
// plumbing - the devcontainer catalog scan, on-demand container wake, and the console terminal-view
// host_op (peek + tmux_send). It carries no Claude session and registers no MCP tools, so the
// conversational agents on this machine run as ordinary loose peers. start-host-daemon.sh launches
// it; HOST_WS_TOKEN authenticates the reserved slot and BRIDGE_ROUTER_URL points at the gateway.

// A daemon owning the host slot, catalog, wake, and every console host_op must outlive any single
// transient failure. An unhandled rejection (e.g. a tmux peek of a session whose server just
// exited) is logged and ignored. An uncaught exception may mean corrupt state, so log and exit for
// start-host-daemon.sh's respawn loop to restart from a clean process.
process.on("unhandledRejection", (reason) => {
	console.error("[host-daemon] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
	console.error("[host-daemon] uncaughtException:", err);
	process.exit(1);
});

const projectDirs = [path.join(os.homedir(), "projects")];
startHostDaemon(projectDirs);
console.error("[host-daemon] started");
