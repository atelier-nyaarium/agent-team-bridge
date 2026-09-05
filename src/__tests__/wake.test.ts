import { describe, expect, it, vi } from "vitest";
import { decideWakeCreate, WakeCoordinator } from "../gateway/wake.js";
import { processAmbient } from "../shared/ambient.js";

describe("WakeCoordinator", () => {
	it("resolves a waiter true when its team is notified online", async () => {
		const coord = new WakeCoordinator(processAmbient());
		const p = coord.waitFor("alpha", 10_000);
		coord.notify("alpha", true);
		await expect(p).resolves.toEqual({ ok: true });
	});

	it("resolves a definitive failure when notified of a failed wake (no errorKind)", async () => {
		const coord = new WakeCoordinator(processAmbient());
		const p = coord.waitFor("alpha", 10_000);
		coord.notify("alpha", false);
		await expect(p).resolves.toEqual({ ok: false });
	});

	it("resolves an ambiguous timeout rather than hanging", async () => {
		const coord = new WakeCoordinator(processAmbient());
		await expect(coord.waitFor("slow", 10)).resolves.toEqual({ ok: false, errorKind: "timeout" });
	});

	it("notify resolves every waiter for that team and leaves other teams pending", async () => {
		const coord = new WakeCoordinator(processAmbient());
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
		const coord = new WakeCoordinator(processAmbient());
		const a = coord.waitFor("a", 10_000);
		const b = coord.waitFor("b", 10_000);
		coord.failAll();
		await expect(a).resolves.toEqual({ ok: false, errorKind: "disconnected" });
		await expect(b).resolves.toEqual({ ok: false, errorKind: "disconnected" });
	});

	it("ackReceived shortens an in-flight wait so a started-but-unregistered team fails fast, still ambiguous", async () => {
		const coord = new WakeCoordinator(processAmbient());
		// 10s base wait; if ackReceived did not shorten it, this would exceed the test timeout.
		const p = coord.waitFor("alpha", 10_000);
		coord.ackReceived("alpha", 10);
		await expect(p).resolves.toEqual({ ok: false, errorKind: "timeout" });
	});

	it("ackReceived still resolves true when the team registers within the window", async () => {
		const coord = new WakeCoordinator(processAmbient());
		const p = coord.waitFor("alpha", 10_000);
		coord.ackReceived("alpha", 10_000);
		coord.notify("alpha", true);
		await expect(p).resolves.toEqual({ ok: true });
	});

	it("ackReceived shortens every concurrent waiter for a team; a register then resolves them all true", async () => {
		const coord = new WakeCoordinator(processAmbient());
		const a1 = coord.waitFor("alpha", 10_000);
		const a2 = coord.waitFor("alpha", 10_000);
		coord.ackReceived("alpha", 10_000);
		coord.notify("alpha", true);
		await expect(a1).resolves.toEqual({ ok: true });
		await expect(a2).resolves.toEqual({ ok: true });
	});

	it("ackReceived fails every concurrent waiter fast when none registers, still ambiguous", async () => {
		const coord = new WakeCoordinator(processAmbient());
		const a1 = coord.waitFor("alpha", 10_000);
		const a2 = coord.waitFor("alpha", 10_000);
		coord.ackReceived("alpha", 10);
		await expect(a1).resolves.toEqual({ ok: false, errorKind: "timeout" });
		await expect(a2).resolves.toEqual({ ok: false, errorKind: "timeout" });
	});

	it("ackReceived can only bring the deadline in, never push it out", async () => {
		// Asserted on TIMING, not on the value: both the clamped and the unclamped path resolve to the
		// same timeout result, so only the clock tells them apart.
		vi.useFakeTimers();
		try {
			const coord = new WakeCoordinator(processAmbient());
			// A window wider than what the wait has left. Re-arming to it hands the team another 10s past
			// a deadline 5s away, which is the opposite of this method's purpose.
			const p = coord.waitFor("alpha", 5_000);
			let settled = false;
			void p.then(() => {
				settled = true;
			});
			coord.ackReceived("alpha", 10_000);

			await vi.advanceTimersByTimeAsync(5_000);
			expect(settled).toBe(true);
			await expect(p).resolves.toEqual({ ok: false, errorKind: "timeout" });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("decideWakeCreate", () => {
	it("reattaches an existing record and ignores a displayLabel entirely, even one that was supplied", () => {
		// displayLabel is ignored once a record already exists: not applied as a rename, not used to
		// pick between two candidate records, just dropped.
		expect(decideWakeCreate("proj.existing", true, undefined)).toEqual({ kind: "reattach" });
		expect(decideWakeCreate("proj.existing", true, "Some Label")).toEqual({ kind: "reattach" });
	});

	it("mints under a supplied displayLabel when no record exists yet", () => {
		expect(decideWakeCreate("proj.newsession", false, "Bug Hunt")).toEqual({
			kind: "mint",
			sessionLabel: "Bug Hunt",
		});
	});

	it("refuses with a specific, actionable error when no record exists and no displayLabel was supplied", () => {
		expect(decideWakeCreate("proj.newsession", false, undefined)).toEqual({
			kind: "refuse",
			error: `"proj.newsession" does not exist yet; retry with a displayLabel to create it`,
		});
	});

	it("refuses a whitespace/invisible-only displayLabel the same as an absent one, rather than minting a garbage-labeled session", () => {
		// A raw-truthiness check would treat all of these as "supplied" - sanitizeLabel does not.
		const refused = {
			kind: "refuse",
			error: `"proj.newsession" does not exist yet; retry with a displayLabel to create it`,
		};
		expect(decideWakeCreate("proj.newsession", false, "   ")).toEqual(refused);
		expect(decideWakeCreate("proj.newsession", false, "\u200b")).toEqual(refused);
		expect(decideWakeCreate("proj.newsession", false, ".")).toEqual(refused);
	});

	it("mints under the sanitized form of a displayLabel that needed trimming", () => {
		expect(decideWakeCreate("proj.newsession", false, "  Bug Hunt  ")).toEqual({
			kind: "mint",
			sessionLabel: "Bug Hunt",
		});
	});
});
