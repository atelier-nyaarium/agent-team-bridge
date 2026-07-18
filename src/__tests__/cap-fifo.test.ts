import { describe, expect, it } from "vitest";
import { capFifo } from "../shared/cap-fifo.js";

describe("capFifo", () => {
	it("does nothing while a Map is at or under the cap", () => {
		const m = new Map([
			["a", 1],
			["b", 2],
		]);
		capFifo(m, 2);
		expect([...m.keys()]).toEqual(["a", "b"]);
	});

	it("evicts the oldest-inserted keys from a Map until at the cap", () => {
		const m = new Map([
			["a", 1],
			["b", 2],
			["c", 3],
			["d", 4],
		]);
		capFifo(m, 2);
		expect([...m.keys()]).toEqual(["c", "d"]);
	});

	it("evicts the oldest-inserted values from a Set until at the cap", () => {
		const s = new Set(["a", "b", "c", "d"]);
		capFifo(s, 1);
		expect([...s]).toEqual(["d"]);
	});

	it("a single call corrects an overflow of more than one entry over the cap", () => {
		// The while loop (not if) is what makes this safe for a caller that ever inserts a batch
		// before checking - one call always leaves size <= max, regardless of how far over it was.
		const m = new Map([
			["a", 1],
			["b", 2],
			["c", 3],
			["d", 4],
			["e", 5],
		]);
		capFifo(m, 1);
		expect(m.size).toBe(1);
		expect([...m.keys()]).toEqual(["e"]);
	});

	it("a cap of 0 empties the container entirely", () => {
		const m = new Map([
			["a", 1],
			["b", 2],
		]);
		capFifo(m, 0);
		expect(m.size).toBe(0);
	});
});
