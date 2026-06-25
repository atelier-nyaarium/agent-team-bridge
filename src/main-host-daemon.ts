import os from "node:os";
import path from "node:path";
import { startHostDaemon } from "./mcp/devcontainer/hostDaemon.js";

// The headless host daemon: it claims the gateway's reserved "host" WS slot and owns the host
// plumbing - the devcontainer catalog scan, on-demand container wake, and the console terminal-view
// host_op (peek + tmux_send). It carries no Claude session and registers no MCP tools, so the
// conversational agents on this machine run as ordinary loose peers. start-host-daemon.sh launches
// it; HOST_WS_TOKEN authenticates the reserved slot and BRIDGE_ROUTER_URL points at the gateway.

const projectDirs = [path.join(os.homedir(), "projects")];
startHostDaemon(projectDirs);
console.error("[host-daemon] started");
