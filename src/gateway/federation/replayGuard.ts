import type { Clock } from "../../shared/ambient.js";
import { capFifo } from "../../shared/cap-fifo.js";

// Bounded TTL prevents immediate authenticated nonce replays.
export class ReplayGuard {
	private readonly seen = new Map<string, number>();

	public constructor(
		private readonly ambient: Clock,
		private readonly ttlMs: number = 300_000,
		private readonly maxEntries: number = 50_000,
	) {}

	private now(): number {
		return this.ambient.now();
	}

	public check(scope: string, nonce: string): boolean {
		const key = `${scope}\n${nonce}`;
		const t = this.now();
		const expiry = this.seen.get(key);
		if (expiry !== undefined && expiry > t) return false;
		this.seen.set(key, t + this.ttlMs);
		// Keep the seen-set bounded by insertion order.
		capFifo(this.seen, this.maxEntries);
		return true;
	}

	public get size(): number {
		return this.seen.size;
	}

	public snapshot(): Array<[string, number]> {
		// Persist live replay entries only.
		const t = this.now();
		const out: Array<[string, number]> = [];
		for (const [key, expiry] of this.seen) {
			if (expiry > t) out.push([key, expiry]);
		}
		return out;
	}

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
