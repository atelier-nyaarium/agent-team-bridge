import { startMcp } from "./mcp/index.js";
import { installRejectionGuard } from "./shared/process-guards.js";

// The MCP server runs WS reconnect + listener loops, so a stray rejection must not kill it. There
// is no supervisor (Claude Code launches and re-establishes this child), so on a true
// uncaughtException just log and exit and let the host reconnect, rather than continue corrupt.
installRejectionGuard("mcp");
process.on("uncaughtException", (err) => {
	console.error("[mcp] uncaughtException:", err);
	process.exit(1);
});

startMcp().catch((err) => {
	console.error(`[mcp] fatal:`, err);
	process.exit(1);
});
