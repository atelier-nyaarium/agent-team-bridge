import { describe, expect, it } from "vitest";
import { INTENT_TTL_MS, IntentTracker } from "../gateway/intent.js";
import { MAX_POLL_HOLD_MS } from "../shared/schemas.js";

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

	it("declare() itself sweeps expired entries - byDevice stays bounded even with cadenceFor/watchList never called", () => {
		// The daemon-side watchList()/cadenceFor() read path is the only OTHER sweep trigger, and it
		// is reachable solely through a host-daemon connection - a gateway with no host daemon ever
		// connected must not leak one entry per distinct device forever. declare() runs on every poll
		// regardless of host-daemon state, so it must bound the map on its own.
		let t = 0;
		const tracker = new IntentTracker({ now: () => t, ttlMs: 1_000 });
		tracker.declare("device-1", { screen: "board" });
		expect(tracker.size).toBe(1);

		t = 2_000; // device-1's entry is now expired
		tracker.declare("device-2", { screen: "board" }); // a DIFFERENT device's declare - never a read
		expect(tracker.size).toBe(1); // device-1 was swept away, only device-2 remains
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

	describe("the production default TTL against a real poll cadence", () => {
		// declare() is the TTL refresh, and consoleHandler.ts calls it once per poll REQUEST, before
		// that request's own held wait begins - so a healthy, continuously-repolling device's gap
		// between two refreshes is bounded by one full held-poll cycle, up to the gateway's own
		// MAX_POLL_HOLD_MS ceiling. The default TTL must survive that gap comfortably, or a single
		// ordinary hold (zero missed polls) would flap the cadence down mid-hold.

		it("survives a single full MAX_POLL_HOLD_MS gap between declarations with room to spare", () => {
			let t = 0;
			const tracker = new IntentTracker({ now: () => t }); // the real production default TTL
			tracker.declare("device-1", { screen: "board" });

			t = MAX_POLL_HOLD_MS; // one entire held poll cycle elapses with no missed poll at all
			expect(tracker.cadenceFor("proj.a")).toBe(2_000); // still alive - not degraded mid-hold
		});

		it("genuinely expires only after roughly 3 full held-poll cycles with zero refresh", () => {
			let t = 0;
			const tracker = new IntentTracker({ now: () => t });
			tracker.declare("device-1", { screen: "board" });

			t = INTENT_TTL_MS - 1;
			expect(tracker.cadenceFor("proj.a")).toBe(2_000); // one tick before expiry: still alive

			t = INTENT_TTL_MS + 1;
			expect(tracker.cadenceFor("proj.a")).toBe(60_000); // now genuinely gone
			expect(INTENT_TTL_MS).toBeGreaterThanOrEqual(3 * MAX_POLL_HOLD_MS);
		});
	});
});
