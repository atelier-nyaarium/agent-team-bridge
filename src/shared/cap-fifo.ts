////////////////////////////////
//  Functions & Helpers

/** Evict the oldest-inserted entries from a Map or Set until its size is at most `max`. Map/Set
 * iteration is insertion-ordered, so the first key is always the oldest - this is the "drop the
 * oldest once a bounded collection overflows" idiom, used wherever a store caps itself by entry
 * count rather than a TTL. A `while` (not `if`) so a caller that ever inserts more than one entry
 * before checking can never overshoot the cap - each call structurally guarantees `size <= max`
 * on return, regardless of how many entries went in since the last check. */
export function capFifo<K>(
	container: { readonly size: number; keys(): IterableIterator<K>; delete(key: K): boolean },
	max: number,
): void {
	while (container.size > max) {
		const oldest = container.keys().next().value;
		if (oldest === undefined) break;
		container.delete(oldest);
	}
}
