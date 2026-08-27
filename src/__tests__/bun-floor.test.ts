import { describe, expect, it } from "vitest";
import { BUN_FLOOR, bunFloorVerdict, compareVersions } from "../shared/bun-floor.js";

/**
 * The floor is enforced at the gateway's entry, on a runtime this suite does not run under: vitest
 * is node, where `Bun` is undefined and the real `ws` pins fine. So the refusal is pinned here on the
 * pure verdict, and the fact it is TRUE for a given bun is proven by scripts/check-pinning-runtime.ts
 * under bun itself. Neither can stand in for the other.
 */
describe("bun floor", () => {
	it("compares dotted versions numerically, not lexically", () => {
		expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
		expect(compareVersions("1.4.0", "1.4")).toBe(0);
		expect(compareVersions("1.3.14", "1.4.0")).toBeLessThan(0);
		expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
	});

	it("ignores a pre-release tag and refuses a garbage segment", () => {
		expect(compareVersions("1.4.0-canary.12", "1.4.0")).toBe(0);
		// A non-numeric segment reads as older than anything, so it cannot pass by accident.
		expect(compareVersions("1.x.0", "1.0.0")).toBeLessThan(0);
		expect(compareVersions("nonsense", "0.0.0")).toBeLessThan(0);
	});

	it("holds the floor: below refuses, at and above pass", () => {
		// Mikan's host bun as found, and the exact version the outage was fixed against.
		const below = bunFloorVerdict("1.3.14");
		expect(below.ok).toBe(false);
		if (!below.ok) {
			expect(below.runtime).toBe("bun 1.3.14");
			expect(below.reason).toContain(BUN_FLOOR);
			expect(below.reason).toContain("pin");
		}
		expect(bunFloorVerdict(BUN_FLOOR).ok).toBe(true);
		expect(bunFloorVerdict("1.4.0").ok).toBe(true);
		expect(bunFloorVerdict("1.5.2").ok).toBe(true);
		expect(bunFloorVerdict("2.0.0").ok).toBe(true);
	});

	it("has no floor under node, where the real ws package pins", () => {
		const verdict = bunFloorVerdict(undefined);
		expect(verdict.ok).toBe(true);
		expect(verdict.runtime).toMatch(/^node v/);
	});

	it("refuses a runtime that reports an unparseable version", () => {
		// Better to refuse a bun that cannot say what it is than to assume it is new enough.
		expect(bunFloorVerdict("").ok).toBe(false);
		expect(bunFloorVerdict("dev").ok).toBe(false);
	});
});
