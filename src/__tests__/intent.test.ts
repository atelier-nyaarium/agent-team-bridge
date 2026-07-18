import { describe, expect, it } from "vitest";
import { IntentTracker } from "../gateway/intent.js";

describe("IntentTracker", () => {
	it("with no intent declared, every live team still gets the background floor cadence", () => {
		const tracker = new IntentTracker();
		expect(tracker.watchList(["proj.a", "proj.b"])).toEqual([
			{ team: "proj.a", cadenceMs: 60_000 },
			{ team: "proj.b", cadenceMs: 60_000 },
		]);
	});

	it("a board intent ramps every live team to the board cadence", () => {
		const tracker = new IntentTracker();
		tracker.declare("device-1", { screen: "board" });
		expect(tracker.watchList(["proj.a", "proj.b"])).toEqual([
			{ team: "proj.a", cadenceMs: 2_000 },
			{ team: "proj.b", cadenceMs: 2_000 },
		]);
	});

	it("a terminal intent ramps only its own team, at the device's configured rate", () => {
		const tracker = new IntentTracker();
		tracker.declare("device-1", { screen: "terminal", terminalTeam: "proj.a", terminalRateMs: 500 });
		expect(tracker.watchList(["proj.a", "proj.b"])).toEqual([
			{ team: "proj.a", cadenceMs: 500 },
			{ team: "proj.b", cadenceMs: 60_000 }, // untouched - not the watched terminal
		]);
	});

	it("a terminal intent with no configured rate falls back to the default", () => {
		const tracker = new IntentTracker();
		tracker.declare("device-1", { screen: "terminal", terminalTeam: "proj.a" });
		expect(tracker.cadenceFor("proj.a")).toBe(500);
	});

	it("multiple devices' intents union - the fastest wins per team", () => {
		const tracker = new IntentTracker();
		tracker.declare("device-1", { screen: "board" }); // 2000ms for everything
		tracker.declare("device-2", { screen: "terminal", terminalTeam: "proj.a", terminalRateMs: 250 });
		expect(tracker.cadenceFor("proj.a")).toBe(250); // faster than board's 2000
		expect(tracker.cadenceFor("proj.b")).toBe(2_000); // only board applies here
	});

	it("declaring background intent alone still leaves the background floor (no regression below it)", () => {
		const tracker = new IntentTracker();
		tracker.declare("device-1", { screen: "background" });
		expect(tracker.cadenceFor("proj.a")).toBe(60_000);
	});

	it("re-declaring the same device replaces its prior intent rather than accumulating", () => {
		const tracker = new IntentTracker();
		tracker.declare("device-1", { screen: "board" });
		tracker.declare("device-1", { screen: "background" }); // the SAME device changes its mind
		expect(tracker.cadenceFor("proj.a")).toBe(60_000); // board no longer in effect
	});

	it("an intent expires to the background floor after its TTL lapses (a killed app needs no goodbye)", () => {
		let t = 0;
		const tracker = new IntentTracker({ now: () => t, ttlMs: 15_000 });
		tracker.declare("device-1", { screen: "board" });
		expect(tracker.cadenceFor("proj.a")).toBe(2_000);

		t = 15_001;
		expect(tracker.cadenceFor("proj.a")).toBe(60_000);
	});

	it("re-declaring before expiry refreshes the TTL (a live console's polling keeps it alive)", () => {
		let t = 0;
		const tracker = new IntentTracker({ now: () => t, ttlMs: 15_000 });
		tracker.declare("device-1", { screen: "board" });

		t = 10_000;
		tracker.declare("device-1", { screen: "board" }); // refreshed before the original TTL would fire
		t = 20_000; // past the ORIGINAL expiry, but within the refreshed one
		expect(tracker.cadenceFor("proj.a")).toBe(2_000);
	});

	it("clear() drops a device's intent immediately, ahead of its TTL", () => {
		const tracker = new IntentTracker();
		tracker.declare("device-1", { screen: "board" });
		tracker.clear("device-1");
		expect(tracker.cadenceFor("proj.a")).toBe(60_000);
	});

	it("one device's terminal intent does not leak into another device's board-only view", () => {
		const tracker = new IntentTracker();
		tracker.declare("device-1", { screen: "terminal", terminalTeam: "proj.a", terminalRateMs: 100 });
		expect(tracker.watchList(["proj.a", "proj.b", "proj.c"])).toEqual([
			{ team: "proj.a", cadenceMs: 100 },
			{ team: "proj.b", cadenceMs: 60_000 },
			{ team: "proj.c", cadenceMs: 60_000 },
		]);
	});
});
