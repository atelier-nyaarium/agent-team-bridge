import { startGateway } from "./gateway/index.js";
import { installRejectionGuard } from "./shared/process-guards.js";

// A stray async rejection must not take down the gateway; log and keep serving. uncaughtException
// is handled inside startGateway, where the durable-state flush decision is in scope.
installRejectionGuard("gateway");

startGateway().catch((err) => {
	console.error(`[gateway] fatal:`, err);
	process.exit(1);
});
