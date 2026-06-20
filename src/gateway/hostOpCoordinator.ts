import type { HostOpResult } from "../shared/host-op.js";

////////////////////////////////
//  Interfaces & Types

interface HostOpWaiter {
	resolve: (r: HostOpResult) => void;
	timer: ReturnType<typeof setTimeout>;
}

////////////////////////////////
//  Class

/**
 * Correlates a gateway->host request to its reply by reqId. The host WebSocket
 * otherwise keys only the wake reply (by team name), which cannot disambiguate the
 * concurrent peek/send ops a live terminal produces. Mirrors evieClient's pendingCalls:
 * each request awaits its reqId; the host's reply settles it; a timeout resolves a
 * clean error rather than stalling the held console op.
 */
export class HostOpCoordinator {
	private pending = new Map<string, HostOpWaiter>();

	wait(reqId: string, timeoutMs: number): Promise<HostOpResult> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(reqId);
				resolve({ ok: false, error: "host op timed out" });
			}, timeoutMs);
			this.pending.set(reqId, { resolve, timer });
		});
	}

	settle(reqId: string, result: HostOpResult): void {
		const waiter = this.pending.get(reqId);
		if (!waiter) return;
		clearTimeout(waiter.timer);
		this.pending.delete(reqId);
		waiter.resolve(result);
	}
}
