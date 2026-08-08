import { describe, expect, it } from "vitest";
import { ReplayGuard } from "../gateway/federation/replayGuard.js";

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

	it("survives a restart: a snapshot restored into a fresh guard still rejects the replay", () => {
		const now = 1000;
		const g = new ReplayGuard(300_000, 50_000, () => now);
		expect(g.check("hostA", "n1")).toBe(true);
		const snap = g.snapshot();
		expect(snap).toContainEqual(["hostA\nn1", 1000 + 300_000]);

		// Simulate a restart: a brand-new guard loads the persisted seen-set.
		const revived = new ReplayGuard(300_000, 50_000, () => now);
		revived.restore(snap);
		// The captured nonce is still a replay AFTER the restart: restoring a snapshot into a fresh
		// guard must reject it exactly as the original guard would have.
		expect(revived.check("hostA", "n1")).toBe(false);
		// A fresh nonce is still accepted.
		expect(revived.check("hostA", "n2")).toBe(true);
	});

	it("drops expired entries from the snapshot and on restore", () => {
		let now = 1000;
		const g = new ReplayGuard(100, 50_000, () => now);
		g.check("h", "stale");
		now = 1200; // past the 100ms window
		// The expired entry is not carried forward.
		expect(g.snapshot()).toEqual([]);

		const revived = new ReplayGuard(100, 50_000, () => now);
		revived.restore([["h\nstale", 1100]]); // already expired at now=1200
		expect(revived.check("h", "stale")).toBe(true); // forgotten, fresh again
	});
});
