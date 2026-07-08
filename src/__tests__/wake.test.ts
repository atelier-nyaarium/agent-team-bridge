import { describe, expect, it } from "vitest";
import { WakeCoordinator } from "../gateway/wake.js";

describe("WakeCoordinator", () => {
	it("resolves a waiter true when its team is notified online", async () => {
		const coord = new WakeCoordinator();
		const p = coord.waitFor("alpha", 10_000);
		coord.notify("alpha", true);
		await expect(p).resolves.toEqual({ ok: true });
	});

	it("resolves a definitive failure when notified of a failed wake (no errorKind)", async () => {
		const coord = new WakeCoordinator();
		const p = coord.waitFor("alpha", 10_000);
		coord.notify("alpha", false);
		await expect(p).resolves.toEqual({ ok: false });
	});

	it("resolves an ambiguous timeout rather than hanging", async () => {
		const coord = new WakeCoordinator();
		await expect(coord.waitFor("slow", 10)).resolves.toEqual({ ok: false, errorKind: "timeout" });
	});

	it("notify resolves every waiter for that team and leaves other teams pending", async () => {
		const coord = new WakeCoordinator();
		const a1 = coord.waitFor("a", 10_000);
		const a2 = coord.waitFor("a", 10_000);
		coord.notify("a", true);
		await expect(a1).resolves.toEqual({ ok: true });
		await expect(a2).resolves.toEqual({ ok: true });
		const b = coord.waitFor("b", 10_000);
		coord.notify("b", false);
		await expect(b).resolves.toEqual({ ok: false });
	});

	it("failAll resolves every in-flight wake as ambiguous (disconnected) across all teams", async () => {
		const coord = new WakeCoordinator();
		const a = coord.waitFor("a", 10_000);
		const b = coord.waitFor("b", 10_000);
		coord.failAll();
		await expect(a).resolves.toEqual({ ok: false, errorKind: "disconnected" });
		await expect(b).resolves.toEqual({ ok: false, errorKind: "disconnected" });
	});

	it("ackReceived shortens an in-flight wait so a started-but-unregistered team fails fast, still ambiguous", async () => {
		const coord = new WakeCoordinator();
		// 10s base wait; if ackReceived did not shorten it, this would exceed the test timeout.
		const p = coord.waitFor("alpha", 10_000);
		coord.ackReceived("alpha", 10);
		await expect(p).resolves.toEqual({ ok: false, errorKind: "timeout" });
	});

	it("ackReceived still resolves true when the team registers within the window", async () => {
		const coord = new WakeCoordinator();
		const p = coord.waitFor("alpha", 10_000);
		coord.ackReceived("alpha", 10_000);
		coord.notify("alpha", true);
		await expect(p).resolves.toEqual({ ok: true });
	});

	it("ackReceived shortens every concurrent waiter for a team; a register then resolves them all true", async () => {
		const coord = new WakeCoordinator();
		const a1 = coord.waitFor("alpha", 10_000);
		const a2 = coord.waitFor("alpha", 10_000);
		coord.ackReceived("alpha", 10_000);
		coord.notify("alpha", true);
		await expect(a1).resolves.toEqual({ ok: true });
		await expect(a2).resolves.toEqual({ ok: true });
	});

	it("ackReceived fails every concurrent waiter fast when none registers, still ambiguous", async () => {
		const coord = new WakeCoordinator();
		const a1 = coord.waitFor("alpha", 10_000);
		const a2 = coord.waitFor("alpha", 10_000);
		coord.ackReceived("alpha", 10);
		await expect(a1).resolves.toEqual({ ok: false, errorKind: "timeout" });
		await expect(a2).resolves.toEqual({ ok: false, errorKind: "timeout" });
	});
});
