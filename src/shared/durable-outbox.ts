import { fenced, MIGRATING } from "./migration-fence.js";

////////////////////////////////
//  Interfaces & Types

export interface DurableOutboxStore {
	load(): unknown | null;
	saveChecked(state: unknown): void;
}

export interface DurableOutboxOptions<T> {
	durable?: DurableOutboxStore;
	/** Validates what the file held; anything it drops is gone. */
	restore: (raw: unknown | null) => readonly T[];
	/** The file shape, when it is not the bare item list. */
	serialize?: (items: readonly T[]) => unknown;
	keyOf: (item: T) => string;
	maxSize?: number;
}

export type OutboxEnqueueResult = "enqueued" | "replaced" | "refused" | typeof MIGRATING;

////////////////////////////////
//  Class

/**
 * The mechanics two durable queues share: validated restore, FIFO order, replace by key, a bound,
 * one drain at a time, explicit retirement, and the migration fence. What an item means, and what
 * its outcome means, stays with the owner.
 */
export class DurableOutbox<T> {
	private readonly items: T[];
	private draining = false;

	constructor(private readonly options: DurableOutboxOptions<T>) {
		this.items = [...options.restore(options.durable?.load() ?? null)];
	}

	get size(): number {
		return this.items.length;
	}

	values(): readonly T[] {
		return this.items;
	}

	has(key: string): boolean {
		return this.items.some((item) => this.options.keyOf(item) === key);
	}

	enqueue(item: T): OutboxEnqueueResult {
		if (fenced()) return MIGRATING;
		const key = this.options.keyOf(item);
		const index = this.items.findIndex((existing) => this.options.keyOf(existing) === key);
		if (index >= 0) {
			this.items[index] = item;
			this.persist();
			return "replaced";
		}
		if (this.items.length >= (this.options.maxSize ?? Number.MAX_SAFE_INTEGER)) return "refused";
		this.items.push(item);
		this.persist();
		return "enqueued";
	}

	retire(key: string): boolean | typeof MIGRATING {
		if (fenced()) return MIGRATING;
		const index = this.items.findIndex((item) => this.options.keyOf(item) === key);
		if (index < 0) return false;
		this.items.splice(index, 1);
		this.persist();
		return true;
	}

	retireWhere(predicate: (item: T) => boolean): T[] | typeof MIGRATING {
		if (fenced()) return MIGRATING;
		const retired = this.items.filter(predicate);
		if (retired.length === 0) return retired;
		const kept = this.items.filter((item) => !predicate(item));
		this.items.splice(0, this.items.length, ...kept);
		this.persist();
		return retired;
	}

	/** Heads are processed in order; a processor that leaves the head in place ends the drain. */
	async drain(process: (item: T) => Promise<void>): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.items.length > 0) {
				const item = this.items[0] as T;
				const key = this.options.keyOf(item);
				await process(item);
				if (this.items[0] === item || this.has(key)) break;
			}
		} finally {
			this.draining = false;
		}
	}

	/** Persistence failure reaches the caller; a queue that cannot save must not claim it did. */
	private persist(): void {
		this.options.durable?.saveChecked(this.options.serialize?.(this.items) ?? this.items);
	}
}
