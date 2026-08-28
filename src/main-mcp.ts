import { assertBunFloor } from "./shared/bun-floor.js";

// Judged before the server's own graph loads, so an old bun reads the floor rather than an import failure.
assertBunFloor();

const [{ startMcp }, { installRejectionGuard }] = await Promise.all([
	import("./mcp/index.js"),
	import("./shared/process-guards.js"),
]);

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
