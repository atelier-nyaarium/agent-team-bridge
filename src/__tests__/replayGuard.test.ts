import { describe, expect, it } from "vitest";
import { ReplayGuard } from "../gateway/federation/replayGuard.js";
import { processAmbient } from "../shared/ambient.js";

describe("ReplayGuard", () => {
	it("accepts a fresh (scope, nonce) and rejects an immediate replay", () => {
		const g = new ReplayGuard(processAmbient());
		expect(g.check("hostA", "n1")).toBe(true);
		expect(g.check("hostA", "n1")).toBe(false);
		// Scope and nonce both participate in replay identity.
		expect(g.check("hostB", "n1")).toBe(true);
		expect(g.check("hostA", "n2")).toBe(true);
	});

	it("forgets a nonce once the TTL window passes", () => {
		let now = 1000;
		const g = new ReplayGuard({ now: () => now }, 100, 50_000);
		expect(g.check("h", "n")).toBe(true);
		now = 1050;
		expect(g.check("h", "n")).toBe(false);
		now = 1101;
		expect(g.check("h", "n")).toBe(true);
	});

	it("bounds memory at the entry cap", () => {
		const g = new ReplayGuard(processAmbient(), 300_000, 10);
		for (let i = 0; i < 100; i++) g.check("h", `n${i}`);
		expect(g.size).toBeLessThanOrEqual(10);
	});

	it("survives a restart: a snapshot restored into a fresh guard still rejects the replay", () => {
		const now = 1000;
		const g = new ReplayGuard({ now: () => now }, 300_000, 50_000);
		expect(g.check("hostA", "n1")).toBe(true);
		const snap = g.snapshot();
		expect(snap).toContainEqual(["hostA\nn1", 1000 + 300_000]);

		const revived = new ReplayGuard({ now: () => now }, 300_000, 50_000);
		revived.restore(snap);
		// Restored entries remain replay-protected.
		expect(revived.check("hostA", "n1")).toBe(false);
		expect(revived.check("hostA", "n2")).toBe(true);
	});

	it("drops expired entries from the snapshot and on restore", () => {
		let now = 1000;
		const g = new ReplayGuard({ now: () => now }, 100, 50_000);
		g.check("h", "stale");
		now = 1200;
		expect(g.snapshot()).toEqual([]);

		const revived = new ReplayGuard({ now: () => now }, 100, 50_000);
		revived.restore([["h\nstale", 1100]]);
		expect(revived.check("h", "stale")).toBe(true);
	});
});
