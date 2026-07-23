////////////////////////////////
//  Interfaces & Types

export interface BurstCache<T> {
	get(): T;
	invalidate(): void;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Memoize an expensive, otherwise-pure computation for the remainder of the current synchronous
 * execution, auto-clearing on the next microtask - collapses many redundant calls within one
 * synchronous burst (e.g. a fan-out loop over N related items sharing one expensive base
 * computation) into a single real call to `compute`, while any LATER, unrelated caller (once the
 * microtask queue flushes) still gets a fresh read.
 *
 * `invalidate()` is the escape hatch for a caller who knows a SECOND, logically separate burst can
 * start within the same physical tick (e.g. two independent synchronous mutations each triggering
 * their own fan-out pass back to back, with no await between them) - without it, the second pass
 * would silently compare against the first pass's now-stale reading instead of recomputing.
 */
export function createBurstCache<T>(compute: () => T): BurstCache<T> {
	let cache: { value: T } | null = null;
	return {
		get(): T {
			if (cache) return cache.value;
			const value = compute();
			cache = { value };
			queueMicrotask(() => {
				cache = null;
			});
			return value;
		},
		invalidate(): void {
			cache = null;
		},
	};
}
