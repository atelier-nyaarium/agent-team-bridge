////////////////////////////////
//  Functions & Helpers

/** Install a process-wide unhandledRejection guard that logs and keeps the process running. A stray
 * async rejection (a fire-and-forget promise that rejected) must never take a long-lived process
 * down; the `name` prefix tells which process logged it. uncaughtException is intentionally NOT
 * centralized here - its recovery policy (whether to flush durable state, which supervisor restarts
 * it) differs per process, so each entrypoint installs its own. */
export function installRejectionGuard(name: string): void {
	process.on("unhandledRejection", (reason) => {
		console.error(`[${name}] unhandledRejection:`, reason);
	});
}
