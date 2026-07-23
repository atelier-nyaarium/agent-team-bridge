import { describe, expect, it, vi } from "vitest";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import type { DurableStore } from "../shared/durable-store.js";

/** An in-memory stand-in for DurableStore - no real disk I/O, just the load()/save() shape
 * DurableOpStore actually depends on. Passing the SAME instance to two separately-constructed
 * DurableOpStores simulates a gateway restart against the same durable file. */
function fakeDurable(initial: unknown = null): DurableStore {
	let state: unknown = initial;
	return {
		load: () => state,
		save: (s: unknown) => {
			state = s;
		},
	} as unknown as DurableStore;
}

describe("DurableOpStore", () => {
	it("an unknown opId has no record", () => {
		const store = new DurableOpStore(fakeDurable());
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("markInFlight then markComplete replays the stored result on a later get", () => {
		const store = new DurableOpStore(fakeDurable());
		store.markInFlight("conv-a", "op-1");
		expect(store.get("conv-a", "op-1")).toEqual({ state: "in-flight" });
		store.markComplete("conv-a", "op-1", { delivered: true });
		expect(store.get("conv-a", "op-1")).toEqual({ state: "complete", result: { delivered: true } });
	});

	it("clear drops the record so a later get is unknown again", () => {
		const store = new DurableOpStore(fakeDurable());
		const generation = store.markInFlight("conv-a", "op-1");
		store.clear("conv-a", "op-1", generation);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("a failed op never becomes replayable: clearing after in-flight leaves nothing to replay", () => {
		// Mirrors the real call sequence: markInFlight before dispatch, then clear (never
		// markComplete) when the op settles as a failure - so a retry sees "unknown" and
		// re-executes, rather than replaying a stale error.
		const store = new DurableOpStore(fakeDurable());
		const generation = store.markInFlight("conv-a", "op-1");
		store.clear("conv-a", "op-1", generation);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("clear() is a no-op once a record has reached complete: a losing concurrent attempt's failure can never erase a winning attempt's success", () => {
		const store = new DurableOpStore(fakeDurable());
		const generation = store.markInFlight("conv-a", "op-1");
		store.markComplete("conv-a", "op-1", { delivered: true });
		store.clear("conv-a", "op-1", generation);
		expect(store.get("conv-a", "op-1")).toEqual({ state: "complete", result: { delivered: true } });
	});

	it("clear() is a no-op when a NEWER attempt has since taken over the same key (stale generation), even though the record is still in-flight", () => {
		// The regression this guards against: an opCache-eviction-during-in-flight retry re-marks
		// the same key in-flight under a fresh generation. If the ORIGINAL (now-stale) attempt's
		// own deferred failure later calls clear() with its OWN (older) generation, it must not
		// erase the newer attempt's still-live in-flight marker.
		const store = new DurableOpStore(fakeDurable());
		const staleGeneration = store.markInFlight("conv-a", "op-1");
		const currentGeneration = store.markInFlight("conv-a", "op-1");
		expect(currentGeneration).not.toBe(staleGeneration);
		store.clear("conv-a", "op-1", staleGeneration);
		expect(store.get("conv-a", "op-1")).toEqual({ state: "in-flight" });
		// The current (newer) attempt's own clear still works normally.
		store.clear("conv-a", "op-1", currentGeneration);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("survives a simulated restart: a second store built from the same durable snapshot sees the same records", () => {
		const durable = fakeDurable();
		const before = new DurableOpStore(durable);
		before.markInFlight("conv-a", "op-in-flight");
		before.markComplete("conv-a", "op-done", { delivered: true });

		// A fresh store instance reading the SAME durable snapshot - the restart-recovery case.
		const after = new DurableOpStore(durable);
		expect(after.get("conv-a", "op-in-flight")).toEqual({ state: "in-flight" });
		expect(after.get("conv-a", "op-done")).toEqual({ state: "complete", result: { delivered: true } });
	});

	it("an in-flight record left by a crash is still in-flight after restart (re-execute, not replay)", () => {
		// The crash-mid-work scenario the replay rule exists to recover: markInFlight ran, the
		// process died before the op ever settled, so the durable record is stuck in-flight. A
		// restart reading that record must see "in-flight", not silently treat it as done.
		const durable = fakeDurable();
		const crashed = new DurableOpStore(durable);
		crashed.markInFlight("conv-a", "op-crashed");

		const revived = new DurableOpStore(durable);
		expect(revived.get("conv-a", "op-crashed")).toEqual({ state: "in-flight" });
	});

	it("an entry past its TTL is treated as unknown", () => {
		let now = 1_000_000;
		const store = new DurableOpStore(fakeDurable(), 1000, 256, 500, () => now);
		store.markComplete("conv-a", "op-1", { delivered: true });
		expect(store.get("conv-a", "op-1")).toBeDefined();
		now += 1001;
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("an expired entry does not survive a restart either", () => {
		let now = 1_000_000;
		const durable = fakeDurable();
		const before = new DurableOpStore(durable, 1000, 256, 500, () => now);
		before.markComplete("conv-a", "op-1", { delivered: true });
		now += 1001;

		const after = new DurableOpStore(durable, 1000, 256, 500, () => now);
		expect(after.get("conv-a", "op-1")).toBeUndefined();
	});

	it("caps entries per conversation, evicting the oldest first", () => {
		const store = new DurableOpStore(fakeDurable(), 14 * 24 * 60 * 60 * 1000, 2, 500);
		store.markInFlight("conv-a", "op-1");
		store.markInFlight("conv-a", "op-2");
		store.markInFlight("conv-a", "op-3");
		expect(store.get("conv-a", "op-1")).toBeUndefined();
		expect(store.get("conv-a", "op-2")).toBeDefined();
		expect(store.get("conv-a", "op-3")).toBeDefined();
	});

	it("caps the number of distinct conversations tracked, evicting the oldest conversation first", () => {
		const store = new DurableOpStore(fakeDurable(), 14 * 24 * 60 * 60 * 1000, 256, 2);
		store.markInFlight("conv-a", "op-1");
		store.markInFlight("conv-b", "op-1");
		store.markInFlight("conv-c", "op-1");
		expect(store.get("conv-a", "op-1")).toBeUndefined();
		expect(store.get("conv-b", "op-1")).toBeDefined();
		expect(store.get("conv-c", "op-1")).toBeDefined();
	});

	it("one conversation's ops are isolated from another's", () => {
		const store = new DurableOpStore(fakeDurable());
		store.markComplete("conv-a", "op-1", { delivered: true });
		expect(store.get("conv-b", "op-1")).toBeUndefined();
	});

	it("ignores a corrupt/garbage durable snapshot instead of throwing", () => {
		const durable = fakeDurable({ not: "the expected shape" });
		expect(() => new DurableOpStore(durable)).not.toThrow();
		const store = new DurableOpStore(durable);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("rejects a row whose record has an unrecognized state instead of trusting and later replaying it", () => {
		const durable = fakeDurable([["conv-a", [["op-1", { state: "bogus" }, Date.now() + 1000, 1]]]]);
		const store = new DurableOpStore(durable);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("rejects a 'complete' row missing its result instead of trusting and later replaying it", () => {
		const durable = fakeDurable([["conv-a", [["op-1", { state: "complete" }, Date.now() + 1000, 1]]]]);
		const store = new DurableOpStore(durable);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("rejects a 'complete' row whose result doesn't match any real ConsoleOpResult shape", () => {
		const durable = fakeDurable([
			["conv-a", [["op-1", { state: "complete", result: { unexpectedField: 1 } }, Date.now() + 1000, 1]]],
		]);
		const store = new DurableOpStore(durable);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("counts and warns about a row with a malformed opId or expiresAt, not just a malformed generation/record", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const durable = fakeDurable([
				["conv-a", [["op-1", { state: "in-flight" }, "not-a-number", 1]]],
				["conv-b", [[123, { state: "in-flight" }, Date.now() + 1000, 1]]],
			]);
			new DurableOpStore(durable);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("restore rejected 0 malformed conversation(s) and 2 malformed row(s)"),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("does not count an ordinarily-expired (but well-typed) row as a malformed-row rejection", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const durable = fakeDurable([["conv-a", [["op-1", { state: "in-flight" }, Date.now() - 1000, 1]]]]);
			new DurableOpStore(durable);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("evicts the least-recently-WRITTEN conversation, not the first-created one, when the conversation cap is hit", () => {
		// conv-a is created first but is touched again (a fresh op) after conv-b and conv-c are
		// created - it must survive, since a naive creation-order FIFO would wrongly evict it.
		const store = new DurableOpStore(fakeDurable(), 14 * 24 * 60 * 60 * 1000, 256, 2);
		store.markInFlight("conv-a", "op-1");
		store.markInFlight("conv-b", "op-1");
		store.markInFlight("conv-a", "op-2");
		store.markInFlight("conv-c", "op-1");
		expect(store.get("conv-a", "op-1")).toBeDefined();
		expect(store.get("conv-a", "op-2")).toBeDefined();
		expect(store.get("conv-b", "op-1")).toBeUndefined();
		expect(store.get("conv-c", "op-1")).toBeDefined();
	});

	it("evicts the least-recently-WRITTEN op within a conversation, not the first-created one, when the per-conversation cap is hit", () => {
		// op-1 is written first (markInFlight) but re-written again (markComplete) after op-2 and
		// op-3 are created and completed - it must survive, since a naive creation-order FIFO on
		// the inner per-opId map would wrongly evict a just-completed op ahead of stale siblings.
		const store = new DurableOpStore(fakeDurable(), 14 * 24 * 60 * 60 * 1000, 3, 500);
		store.markInFlight("conv-a", "op-1");
		store.markInFlight("conv-a", "op-2");
		store.markComplete("conv-a", "op-2", { delivered: true });
		store.markInFlight("conv-a", "op-3");
		store.markComplete("conv-a", "op-3", { delivered: true });
		store.markComplete("conv-a", "op-1", { delivered: true });
		store.markInFlight("conv-a", "op-4");
		expect(store.get("conv-a", "op-1")).toBeDefined();
		expect(store.get("conv-a", "op-2")).toBeUndefined();
		expect(store.get("conv-a", "op-3")).toBeDefined();
		expect(store.get("conv-a", "op-4")).toBeDefined();
	});

	it("markComplete is write-once: a second genuine success for the same opId never overwrites the first completion's result", () => {
		const store = new DurableOpStore(fakeDurable());
		store.markComplete("conv-a", "op-1", { session_id: "s", status: "running" });
		store.markComplete("conv-a", "op-1", { session_id: "s", status: "sent" });
		expect(store.get("conv-a", "op-1")).toEqual({
			state: "complete",
			result: { session_id: "s", status: "running" },
		});
	});

	it("size reports the total tracked records across every conversation", () => {
		const store = new DurableOpStore(fakeDurable());
		expect(store.size).toBe(0);
		store.markInFlight("conv-a", "op-1");
		store.markInFlight("conv-a", "op-2");
		store.markComplete("conv-b", "op-1", { delivered: true });
		expect(store.size).toBe(3);
	});

	it("sweep actively removes TTL-expired records instead of leaving them as dead weight", () => {
		let now = 1_000_000;
		const store = new DurableOpStore(fakeDurable(), 1000, 256, 500, () => now);
		store.markComplete("conv-a", "op-1", { delivered: true });
		store.markComplete("conv-a", "op-2", { delivered: true });
		expect(store.size).toBe(2);
		expect(store.sweep()).toBe(false);

		now += 1001;
		store.markComplete("conv-b", "op-1", { delivered: true }); // a fresh, non-expired record
		expect(store.sweep()).toBe(true);
		expect(store.size).toBe(1);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
		expect(store.get("conv-a", "op-2")).toBeUndefined();
		expect(store.get("conv-b", "op-1")).toBeDefined();
	});

	it("restore re-applies the per-conversation cap against an oversized persisted snapshot", () => {
		const durable = fakeDurable([
			[
				"conv-a",
				[
					["op-1", { state: "in-flight" }, Date.now() + 1000, 1],
					["op-2", { state: "in-flight" }, Date.now() + 1000, 2],
					["op-3", { state: "in-flight" }, Date.now() + 1000, 3],
				],
			],
		]);
		// A cap of 2 is lower than the 3 rows the snapshot holds - simulating a config rollback or a
		// hand-restored/foreign snapshot written under a looser bound.
		const store = new DurableOpStore(durable, 14 * 24 * 60 * 60 * 1000, 2, 500);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
		expect(store.get("conv-a", "op-2")).toBeDefined();
		expect(store.get("conv-a", "op-3")).toBeDefined();
	});

	it("restore re-applies the conversation cap against an oversized persisted snapshot", () => {
		const durable = fakeDurable([
			["conv-a", [["op-1", { state: "in-flight" }, Date.now() + 1000, 1]]],
			["conv-b", [["op-1", { state: "in-flight" }, Date.now() + 1000, 2]]],
			["conv-c", [["op-1", { state: "in-flight" }, Date.now() + 1000, 3]]],
		]);
		const store = new DurableOpStore(durable, 14 * 24 * 60 * 60 * 1000, 256, 2);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
		expect(store.get("conv-b", "op-1")).toBeDefined();
		expect(store.get("conv-c", "op-1")).toBeDefined();
	});
});
