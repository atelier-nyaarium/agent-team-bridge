import { describe, expect, it } from "vitest";
import { createBurstCache } from "../shared/burst-cache.js";

describe("createBurstCache", () => {
	it("computes once for a burst of synchronous get() calls", () => {
		let calls = 0;
		const cache = createBurstCache(() => {
			calls += 1;
			return "value";
		});
		cache.get();
		cache.get();
		cache.get();
		expect(calls).toBe(1);
	});

	it("recomputes on the next tick, once the microtask queue flushes", async () => {
		let calls = 0;
		const cache = createBurstCache(() => {
			calls += 1;
			return calls;
		});
		expect(cache.get()).toBe(1);
		await Promise.resolve();
		expect(cache.get()).toBe(2);
	});

	it("invalidate() forces a fresh computation within the SAME tick", () => {
		let calls = 0;
		const cache = createBurstCache(() => {
			calls += 1;
			return calls;
		});
		expect(cache.get()).toBe(1);
		cache.invalidate();
		expect(cache.get()).toBe(2); // no await, no microtask flush - still recomputed
	});

	it("returns the LATEST computed value to every caller within one burst, not a snapshot from the first call", () => {
		let current = "a";
		const cache = createBurstCache(() => current);
		expect(cache.get()).toBe("a");
		current = "b"; // the underlying source changes mid-burst (not expected in practice, but the
		// cache itself must not silently keep serving the first value forever)
		cache.invalidate();
		expect(cache.get()).toBe("b");
	});
});
