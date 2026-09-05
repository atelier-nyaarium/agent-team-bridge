import type { Ambient, TimerHandle } from "../shared/ambient.js";
import type { HostOpResult } from "../shared/host-op.js";

interface HostOpWaiter {
	resolve: (r: HostOpResult) => void;
	timer: TimerHandle;
}

export class HostOpCoordinator {
	// reqId separates concurrent host operations.
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

	failAll(error: string): void {
		// Fail pending ops on disconnect; the host may still complete them.
		for (const [, waiter] of this.pending) {
			this.ambient.clearTimer(waiter.timer);
			waiter.resolve({ ok: false, error, errorKind: "disconnected" });
		}
		this.pending.clear();
	}
}
