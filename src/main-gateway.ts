import { startGateway } from "./gateway/index.js";

// A stray async rejection must not take down the gateway; log and keep serving. uncaughtException
// is handled inside startGateway, where the durable-state flush is in scope.
process.on("unhandledRejection", (reason) => {
	console.error("[gateway] unhandledRejection:", reason);
});

startGateway().catch((err) => {
	console.error(`[gateway] fatal:`, err);
	process.exit(1);
});
