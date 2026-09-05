import type { Ambient, TimerHandle } from "../shared/ambient.js";
import type { HostOpResult } from "../shared/host-op.js";

////////////////////////////////
//  Interfaces & Types

interface HostOpWaiter {
	resolve: (r: HostOpResult) => void;
	timer: TimerHandle;
}

////////////////////////////////
//  Class

/**
 * Correlates a gateway->host request to its reply by reqId. The host WebSocket
 * otherwise keys only the wake reply (by team name), which cannot disambiguate the
 * concurrent peek/send ops a live terminal produces. Mirrors routerClient's pendingCalls:
 * each request awaits its reqId; the host's reply settles it; a timeout resolves a
 * clean error rather than stalling the held console op.
 */
export class HostOpCoordinator {
	private pending = new Map<string, HostOpWaiter>();

	constructor(private readonly ambient: Pick<Ambient, "setTimer" | "clearTimer">) {}

	wait(reqId: string, timeoutMs: number): Promise<HostOpResult> {
		return new Promise((resolve) => {
			const timer = this.ambient.setTimer(() => {
				this.pending.delete(reqId);
				resolve({ ok: false, error: "host op timed out", errorKind: "timeout" });
			}, timeoutMs);
			this.pending.set(reqId, { resolve, timer });
		});
	}

	settle(reqId: string, result: HostOpResult): void {
		const waiter = this.pending.get(reqId);
		if (!waiter) return;
		this.ambient.clearTimer(waiter.timer);
		this.pending.delete(reqId);
		waiter.resolve(result);
	}

	/** Fail every in-flight op now (the host socket dropped), so a console peek/send returns a
	 * fast retryable error instead of waiting out its full timeout across a host restart. Mirrors
	 * routerClient's fail-in-flight-on-close behaviour. Tagged "disconnected", not a bare failure: the
	 * op was already relayed and the host may complete (or may already have completed) it regardless
	 * of the WS drop that triggered this. */
	failAll(error: string): void {
		for (const [, waiter] of this.pending) {
			this.ambient.clearTimer(waiter.timer);
			waiter.resolve({ ok: false, error, errorKind: "disconnected" });
		}
		this.pending.clear();
	}
}
