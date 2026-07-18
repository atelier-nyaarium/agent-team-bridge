import { capFifo } from "../../shared/cap-fifo.js";

////////////////////////////////
//  Class

/**
 * A sliding-window seen-set that rejects a replayed (scope, nonce) pair. The seal
 * carries a per-message random nonce; remembering recently-opened nonces means an
 * attacker who captures an authentic sealed frame cannot re-deliver it to re-run
 * the op. Bounded by a TTL window + a hard entry cap (the practical threat is an
 * immediate re-send; a replay after the window is not caught, by design - a
 * stateless guard cannot remember forever). Check AFTER the signature verifies, so
 * only authentic nonces are recorded and a forged frame cannot poison the set.
 */
export class ReplayGuard {
	private readonly seen = new Map<string, number>();

	public constructor(
		private readonly ttlMs: number = 300_000,
		private readonly maxEntries: number = 50_000,
		private readonly now: () => number = Date.now,
	) {}

	/** Record (scope, nonce) and return true if it is fresh, or false if it was
	 * seen within the window (a replay). */
	public check(scope: string, nonce: string): boolean {
		const key = `${scope}\n${nonce}`;
		const t = this.now();
		const expiry = this.seen.get(key);
		if (expiry !== undefined && expiry > t) return false;
		this.seen.set(key, t + this.ttlMs);
		// Hard cap: evict the oldest-inserted entry (expired ones cluster at the
		// front, so this drops stale before live in the common case).
		capFifo(this.seen, this.maxEntries);
		return true;
	}

	public get size(): number {
		return this.seen.size;
	}

	/** The live (non-expired) seen-set, for persisting across a restart so an
	 * authentic frame captured inside the freshness window cannot replay once after a
	 * deploy. Expired entries are dropped (they would be re-accepted anyway). */
	public snapshot(): Array<[string, number]> {
		const t = this.now();
		const out: Array<[string, number]> = [];
		for (const [key, expiry] of this.seen) {
			if (expiry > t) out.push([key, expiry]);
		}
		return out;
	}

	/** Reload a persisted seen-set on boot, keeping only entries still within their
	 * window. Idempotent and bounded by the same hard cap. */
	public restore(entries: Array<[string, number]>): void {
		const t = this.now();
		for (const [key, expiry] of entries) {
			if (typeof key !== "string" || typeof expiry !== "number") continue;
			if (expiry <= t) continue;
			this.seen.set(key, expiry);
			capFifo(this.seen, this.maxEntries);
		}
	}
}
