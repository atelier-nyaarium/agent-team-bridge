import { describe, expect, it } from "vitest";
import { WakeCoordinator } from "../gateway/wake.js";

describe("WakeCoordinator", () => {
	it("resolves a waiter true when its team is notified online", async () => {
		const coord = new WakeCoordinator();
		const p = coord.waitFor("alpha", 10_000);
		coord.notify("alpha", true);
		await expect(p).resolves.toBe(true);
	});

	it("resolves false when notified of a failed wake", async () => {
		const coord = new WakeCoordinator();
		const p = coord.waitFor("alpha", 10_000);
		coord.notify("alpha", false);
		await expect(p).resolves.toBe(false);
	});

	it("resolves false on timeout rather than hanging", async () => {
		const coord = new WakeCoordinator();
		await expect(coord.waitFor("slow", 10)).resolves.toBe(false);
	});

	it("notify resolves every waiter for that team and leaves other teams pending", async () => {
		const coord = new WakeCoordinator();
		const a1 = coord.waitFor("a", 10_000);
		const a2 = coord.waitFor("a", 10_000);
		coord.notify("a", true);
		await expect(a1).resolves.toBe(true);
		await expect(a2).resolves.toBe(true);
		const b = coord.waitFor("b", 10_000);
		coord.notify("b", false);
		await expect(b).resolves.toBe(false);
	});

	it("failAll resolves every in-flight wake false across all teams (host disconnect)", async () => {
		const coord = new WakeCoordinator();
		const a = coord.waitFor("a", 10_000);
		const b = coord.waitFor("b", 10_000);
		coord.failAll();
		await expect(a).resolves.toBe(false);
		await expect(b).resolves.toBe(false);
	});
});
