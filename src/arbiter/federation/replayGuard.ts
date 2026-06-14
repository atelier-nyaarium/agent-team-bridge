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
		if (this.seen.size > this.maxEntries) {
			const oldest = this.seen.keys().next().value;
			if (oldest !== undefined) this.seen.delete(oldest);
		}
		return true;
	}

	public get size(): number {
		return this.seen.size;
	}
}
