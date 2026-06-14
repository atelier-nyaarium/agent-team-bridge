import { describe, expect, it } from "vitest";
import { ReplayGuard } from "../arbiter/federation/replayGuard.js";

describe("ReplayGuard", () => {
	it("accepts a fresh (scope, nonce) and rejects an immediate replay", () => {
		const g = new ReplayGuard();
		expect(g.check("hostA", "n1")).toBe(true);
		expect(g.check("hostA", "n1")).toBe(false);
		// A different scope or nonce is independent.
		expect(g.check("hostB", "n1")).toBe(true);
		expect(g.check("hostA", "n2")).toBe(true);
	});

	it("forgets a nonce once the TTL window passes", () => {
		let now = 1000;
		const g = new ReplayGuard(100, 50_000, () => now);
		expect(g.check("h", "n")).toBe(true);
		now = 1050; // within the window -> still a replay
		expect(g.check("h", "n")).toBe(false);
		now = 1101; // past the window -> forgotten, fresh again
		expect(g.check("h", "n")).toBe(true);
	});

	it("bounds memory at the entry cap", () => {
		const g = new ReplayGuard(300_000, 10);
		for (let i = 0; i < 100; i++) g.check("h", `n${i}`);
		expect(g.size).toBeLessThanOrEqual(10);
	});
});
