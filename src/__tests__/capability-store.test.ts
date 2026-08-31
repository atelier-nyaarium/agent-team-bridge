import { describe, expect, it } from "vitest";
import { CapabilityStore } from "../gateway/console/capabilityStore.js";
import type { DurableStore } from "../shared/durable-store.js";

////////////////////////////////
//  Functions & Helpers

/** A DurableStore standing in for the file, so persistence is observable without touching disk. */
function fakeDurable(seed: unknown = null): DurableStore & { saved: unknown } {
	const box = {
		saved: seed,
		load: () => box.saved,
		save: (state: unknown) => {
			box.saved = state;
		},
	};
	return box as unknown as DurableStore & { saved: unknown };
}

const DAY = 24 * 60 * 60 * 1000;

function atClock(start = 1_000_000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

////////////////////////////////
//  Tests

describe("what the gateway serves", () => {
	it("has no opinion until a device reports, so a caller can tell silence from an empty answer", () => {
		const store = new CapabilityStore(fakeDurable());

		expect(store.snapshot()).toEqual({ known: false, capabilities: [], clientVersions: [] });
	});

	it("serves what a device reported", () => {
		const store = new CapabilityStore(fakeDurable());
		store.report("phone", [{ id: "designer", instructions: "Prefer Switchboard." }]);

		expect(store.snapshot()).toEqual({
			known: true,
			capabilities: [{ id: "designer", instructions: "Prefer Switchboard." }],
			clientVersions: [],
		});
	});

	it("reports each live device's build, and says nothing for one that named none", () => {
		const store = new CapabilityStore(fakeDurable());
		store.report("phone", [{ id: "designer" }], "7.15.0");
		store.report("tablet", [{ id: "designer" }], "7.14.1");
		store.report("laptop", [{ id: "designer" }]);

		// Deduped and sorted, and the silent device is absent rather than represented: a caller
		// reading this to decide something must be able to tell "old" from "did not say".
		expect(store.snapshot().clientVersions).toEqual(["7.14.1", "7.15.0"]);
	});

	it("updates a build on a register that carried no plugin list, since the two claims are separate", () => {
		const store = new CapabilityStore(fakeDurable());
		store.report("phone", [{ id: "designer" }], "7.14.1");
		store.report("phone", undefined, "7.15.0");

		expect(store.snapshot().clientVersions).toEqual(["7.15.0"]);
		// The plugin list it never re-stated still stands.
		expect(store.snapshot().capabilities.map((c) => c.id)).toEqual(["designer"]);
	});

	it("serves the union, so one phone holding a plugin is enough to enable it", () => {
		const store = new CapabilityStore(fakeDurable());
		store.report("phone", [{ id: "designer" }]);
		store.report("tablet", [{ id: "references" }]);

		expect(store.snapshot().capabilities.map((c) => c.id)).toEqual(["designer", "references"]);
	});

	it("distinguishes a device reporting nothing enabled from a device that never spoke", () => {
		const store = new CapabilityStore(fakeDurable());
		store.report("phone", []);

		expect(store.snapshot()).toEqual({ known: true, capabilities: [], clientVersions: [] });
	});

	it("leaves a prior report standing when a register carries no plugin list at all", () => {
		const store = new CapabilityStore(fakeDurable());
		store.report("phone", [{ id: "designer" }]);
		store.report("phone", undefined);

		expect(store.snapshot().capabilities.map((c) => c.id)).toEqual(["designer"]);
	});

	// Discarding the entry is what actually happened: guidance longer than the wire allowed took the
	// whole capability with it, so a plugin the owner had switched on was invisible to every session
	// with nothing logged anywhere. Guidance is the expendable half, never the id.
	it("keeps a capability whose guidance the wire refuses, rather than dropping it entirely", () => {
		const store = new CapabilityStore(fakeDurable());
		store.report("phone", [{ id: "references", instructions: "x".repeat(200_000) }]);

		expect(store.snapshot()).toEqual({ known: true, capabilities: [{ id: "references" }], clientVersions: [] });
	});

	it("still drops an entry with no usable id, which names no capability to keep", () => {
		const store = new CapabilityStore(fakeDurable());
		store.report("phone", [{ id: "Not A Slug" }, { id: "designer" }]);

		expect(store.snapshot().capabilities.map((c) => c.id)).toEqual(["designer"]);
	});
});

describe("whose guidance wins", () => {
	it("takes the most recently reported text, not the most recently seen device", () => {
		const clock = atClock();
		const store = new CapabilityStore(fakeDurable(), 14 * DAY, clock.now);
		store.report("chatty", [{ id: "designer", instructions: "stale" }]);
		clock.advance(1000);
		store.report("quiet", [{ id: "designer", instructions: "fresh" }]);
		// The chatty device keeps polling long after it last said anything.
		clock.advance(1000);
		store.touch("chatty");

		expect(store.snapshot().capabilities).toEqual([{ id: "designer", instructions: "fresh" }]);
	});
});

describe("going quiet", () => {
	it("drops a device that has not been seen for two weeks", () => {
		const clock = atClock();
		const store = new CapabilityStore(fakeDurable(), 14 * DAY, clock.now);
		store.report("retired", [{ id: "designer" }]);
		clock.advance(15 * DAY);

		expect(store.snapshot()).toEqual({ known: false, capabilities: [], clientVersions: [] });
	});

	it("keeps a device alive on any activity, so a dozing phone does not lose its plugins", () => {
		const clock = atClock();
		const store = new CapabilityStore(fakeDurable(), 14 * DAY, clock.now);
		store.report("phone", [{ id: "designer" }]);
		// Polls once a week without ever re-registering.
		for (let i = 0; i < 4; i++) {
			clock.advance(7 * DAY);
			store.touch("phone");
		}

		expect(store.snapshot().capabilities.map((c) => c.id)).toEqual(["designer"]);
	});

	it("sweeps an expired device out of storage", () => {
		const clock = atClock();
		const store = new CapabilityStore(fakeDurable(), 14 * DAY, clock.now);
		store.report("retired", [{ id: "designer" }]);
		clock.advance(15 * DAY);

		expect(store.sweep()).toBe(true);
		expect(store.sweep()).toBe(false);
	});

	it("forgets a revoked device immediately", () => {
		const store = new CapabilityStore(fakeDurable());
		store.report("revoked", [{ id: "designer" }]);

		store.forget("revoked");

		expect(store.snapshot()).toEqual({ known: false, capabilities: [], clientVersions: [] });
	});
});

describe("surviving a restart", () => {
	it("serves the same union after reloading from disk", () => {
		const durable = fakeDurable();
		const first = new CapabilityStore(durable);
		first.report("phone", [{ id: "designer", instructions: "Prefer Switchboard." }]);

		const reloaded = new CapabilityStore(durable);

		expect(reloaded.snapshot()).toEqual(first.snapshot());
	});

	it("drops an unreadable record rather than counting it as a device with nothing enabled", () => {
		const durable = fakeDurable({ phone: { capabilities: [{ id: "NOT A SLUG" }], lastSeen: Date.now() } });
		const store = new CapabilityStore(durable);

		expect(store.snapshot()).toEqual({ known: false, capabilities: [], clientVersions: [] });
	});

	it("keeps the readable half of a partly unreadable record", () => {
		const durable = fakeDurable({
			phone: { capabilities: [{ id: "NOT A SLUG" }, { id: "designer" }], lastSeen: Date.now() },
		});
		const store = new CapabilityStore(durable);

		expect(store.snapshot()).toEqual({ known: true, capabilities: [{ id: "designer" }], clientVersions: [] });
	});

	it("still honours a device that genuinely reported nothing enabled", () => {
		const durable = fakeDurable({ phone: { capabilities: [], lastSeen: Date.now() } });
		const store = new CapabilityStore(durable);

		expect(store.snapshot()).toEqual({ known: true, capabilities: [], clientVersions: [] });
	});

	it("keeps a polling device across a restart, without a register to carry its liveness", () => {
		const clock = atClock();
		const durable = fakeDurable();
		const first = new CapabilityStore(durable, 14 * DAY, clock.now);
		first.report("phone", [{ id: "designer" }]);
		// Three weeks of daily polling and no re-register, with the gateway's own tick running.
		for (let i = 0; i < 21; i++) {
			clock.advance(1 * DAY);
			first.touch("phone");
			first.sweep();
		}

		const reloaded = new CapabilityStore(durable, 14 * DAY, clock.now);

		expect(reloaded.snapshot().capabilities.map((c) => c.id)).toEqual(["designer"]);
		expect(reloaded.sweep()).toBe(false);
	});
});
