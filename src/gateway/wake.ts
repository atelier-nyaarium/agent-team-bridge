////////////////////////////////
//  Interfaces & Types

/** Mirrors HostOpResult's shape: `ok: false` alone means the host daemon gave a definitive answer
 * (an explicit wake_result failure); errorKind marks an outcome the daemon never actually settled -
 * this waiter gave up (timeout) or the host link dropped mid-wait (disconnected) - so the launch
 * itself may still be running or may already have succeeded independently of this waiter. */
export interface WakeResult {
	ok: boolean;
	errorKind?: "timeout" | "disconnected";
}

interface WakeWaiter {
	resolve: (result: WakeResult) => void;
	timer: ReturnType<typeof setTimeout>;
}

////////////////////////////////
//  Class

export class WakeCoordinator {
	private waiters = new Map<string, WakeWaiter[]>();

	waitFor(team: string, timeoutMs: number): Promise<WakeResult> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.removeWaiter(team, entry);
				resolve({ ok: false, errorKind: "timeout" });
			}, timeoutMs);
			const entry: WakeWaiter = { resolve, timer };
			if (!this.waiters.has(team)) this.waiters.set(team, []);
			this.waiters.get(team)!.push(entry);
		});
	}

	notify(team: string, success = true): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		for (const entry of entries) {
			clearTimeout(entry.timer);
			entry.resolve({ ok: success });
		}
		this.waiters.delete(team);
	}

	/** A positive wake_result proves the container started, but it is not deliverable until it
	 * registers. Shorten each in-flight waiter to the registration window so a started-but-never-
	 * registered team (Claude crashed on boot) fails fast instead of stalling the full WAKE_TIMEOUT_MS;
	 * the woken container's own register still resolves it true if it lands within the window. Still a
	 * timeout, not a definitive failure - the narrower window ran out, not the daemon reporting a
	 * failure - so a caller that treats a bare timeout as ambiguous must treat this one the same way. */
	ackReceived(team: string, registerWindowMs: number): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		for (const entry of entries) {
			clearTimeout(entry.timer);
			entry.timer = setTimeout(() => {
				this.removeWaiter(team, entry);
				entry.resolve({ ok: false, errorKind: "timeout" });
			}, registerWindowMs);
		}
	}

	/** Fail every in-flight wake now (the host daemon socket dropped, so no wake_result can arrive),
	 * resolving each waiter so a `/send` awaiting a wake returns at once instead of stalling the full
	 * WAKE_TIMEOUT_MS. Mirrors HostOpCoordinator.failAll, including the "disconnected" tag: the wake
	 * request already reached the host and may complete (or may already have completed) regardless of
	 * the WS drop that triggered this. */
	failAll(): void {
		for (const entries of this.waiters.values()) {
			for (const entry of entries) {
				clearTimeout(entry.timer);
				entry.resolve({ ok: false, errorKind: "disconnected" });
			}
		}
		this.waiters.clear();
	}

	private removeWaiter(team: string, target: WakeWaiter): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		const idx = entries.indexOf(target);
		if (idx >= 0) entries.splice(idx, 1);
		if (entries.length === 0) this.waiters.delete(team);
	}
}
