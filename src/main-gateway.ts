import { startGateway } from "./gateway/index.js";
import { assertBunFloor } from "./shared/bun-floor.js";
import { installRejectionGuard } from "./shared/process-guards.js";

// First, before a socket exists to dial with: a bun below the floor cannot pin the Router, and the
// base image is no longer the only thing standing between the gateway and one (see bun-floor.ts).
assertBunFloor();

// A stray async rejection must not take down the gateway; log and keep serving. uncaughtException
// is handled inside startGateway, where the durable-state flush decision is in scope.
installRejectionGuard("gateway");

startGateway().catch((err) => {
	console.error(`[gateway] fatal:`, err);
	process.exit(1);
});
