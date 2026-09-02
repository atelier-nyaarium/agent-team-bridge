import { describe, expect, it, vi } from "vitest";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { isBoardReply } from "../shared/board-structure.js";
import type { DurableStore } from "../shared/durable-store.js";

/** Shared memory simulates the durable file across store instances. */
function fakeDurable(initial: unknown = null): DurableStore {
	let state: unknown = initial;
	return {
		load: () => state,
		save: (s: unknown) => {
			state = s;
		},
	} as unknown as DurableStore;
}

/** markInFlight answers null under the migration fence, which is never the case here. */
function mark(store: DurableOpStore, conversationId: string, opId: string): number {
	const generation = store.markInFlight(conversationId, opId);
	if (generation === null) throw new Error("unexpectedly fenced");
	return generation;
}

describe("DurableOpStore", () => {
	it("an unknown opId has no record", () => {
		const store = new DurableOpStore(fakeDurable());
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("markInFlight then markComplete replays the stored result on a later get", () => {
		const store = new DurableOpStore(fakeDurable());
		mark(store, "conv-a", "op-1");
		expect(store.get("conv-a", "op-1")).toEqual({ state: "in-flight" });
		store.markComplete("conv-a", "op-1", { delivered: true });
		expect(store.get("conv-a", "op-1")).toEqual({ state: "complete", result: { delivered: true } });
	});

	it("a failed op never becomes replayable: clearing after in-flight leaves nothing to replay", () => {
		// Failed operations clear in-flight state so retries execute again.
		const store = new DurableOpStore(fakeDurable());
		const generation = mark(store, "conv-a", "op-1");
		store.clear("conv-a", "op-1", generation);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("clear() is a no-op once a record has reached complete: a losing concurrent attempt's failure can never erase a winning attempt's success", () => {
		const store = new DurableOpStore(fakeDurable());
		const generation = mark(store, "conv-a", "op-1");
		store.markComplete("conv-a", "op-1", { delivered: true });
		store.clear("conv-a", "op-1", generation);
		expect(store.get("conv-a", "op-1")).toEqual({ state: "complete", result: { delivered: true } });
	});

	it("clear() is a no-op when a NEWER attempt has since taken over the same key (stale generation), even though the record is still in-flight", () => {
		// A stale attempt must not clear a newer in-flight generation.
		const store = new DurableOpStore(fakeDurable());
		const staleGeneration = mark(store, "conv-a", "op-1");
		const currentGeneration = mark(store, "conv-a", "op-1");
		expect(currentGeneration).not.toBe(staleGeneration);
		store.clear("conv-a", "op-1", staleGeneration);
		expect(store.get("conv-a", "op-1")).toEqual({ state: "in-flight" });
		store.clear("conv-a", "op-1", currentGeneration);
		expect(store.get("conv-a", "op-1")).toBeUndefined();
	});

	it("survives a simulated restart: a second store built from the same durable snapshot sees the same records", () => {
		const durable = fakeDurable();
		const before = new DurableOpStore(durable);
		before.markInFlight("conv-a", "op-in-flight");
		before.markComplete("conv-a", "op-done", { delivered: true });

		const after = new DurableOpStore(durable);
		expect(after.get("conv-a", "op-in-flight")).toEqual({ state: "in-flight" });
		expect(after.get("conv-a", "op-done")).toEqual({ state: "complete", result: { delivered: true } });
	});

	it("an in-flight record left by a crash is still in-flight after restart (re-execute, not replay)", () => {
		// Restart preserves in-flight state after a crash before settlement.
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
		mark(store, "conv-a", "op-1");
		mark(store, "conv-a", "op-2");
		mark(store, "conv-a", "op-3");
		expect(store.get("conv-a", "op-1")).toBeUndefined();
		expect(store.get("conv-a", "op-2")).toBeDefined();
		expect(store.get("conv-a", "op-3")).toBeDefined();
	});

	it("caps the number of distinct conversations tracked, evicting the oldest conversation first", () => {
		const store = new DurableOpStore(fakeDurable(), 14 * 24 * 60 * 60 * 1000, 256, 2);
		mark(store, "conv-a", "op-1");
		mark(store, "conv-b", "op-1");
		mark(store, "conv-c", "op-1");
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
		// Eviction follows activity, not creation order.
		const store = new DurableOpStore(fakeDurable(), 14 * 24 * 60 * 60 * 1000, 256, 2);
		mark(store, "conv-a", "op-1");
		mark(store, "conv-b", "op-1");
		mark(store, "conv-a", "op-2");
		mark(store, "conv-c", "op-1");
		expect(store.get("conv-a", "op-1")).toBeDefined();
		expect(store.get("conv-a", "op-2")).toBeDefined();
		expect(store.get("conv-b", "op-1")).toBeUndefined();
		expect(store.get("conv-c", "op-1")).toBeDefined();
	});

	it("evicts the least-recently-WRITTEN op within a conversation, not the first-created one, when the per-conversation cap is hit", () => {
		// Updates refresh recency within a conversation.
		const store = new DurableOpStore(fakeDurable(), 14 * 24 * 60 * 60 * 1000, 3, 500);
		mark(store, "conv-a", "op-1");
		mark(store, "conv-a", "op-2");
		store.markComplete("conv-a", "op-2", { delivered: true });
		mark(store, "conv-a", "op-3");
		store.markComplete("conv-a", "op-3", { delivered: true });
		store.markComplete("conv-a", "op-1", { delivered: true });
		mark(store, "conv-a", "op-4");
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
		mark(store, "conv-a", "op-1");
		mark(store, "conv-a", "op-2");
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
		store.markComplete("conv-b", "op-1", { delivered: true });
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
		// Restore enforces the current cap on older snapshots.
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

describe("DurableOpStore.withValidator", () => {
	it("replays a non-console result across a restart", () => {
		const durable = fakeDurable();
		DurableOpStore.withValidator(durable, isBoardReply).markComplete("sess-a", "op-1", { applied: true });

		const restarted = DurableOpStore.withValidator(durable, isBoardReply);
		expect(restarted.get("sess-a", "op-1")).toEqual({ state: "complete", result: { applied: true } });
	});

	it("rejects a restored row its own validator does not accept", () => {
		// Ignore rows belonging to another operation store.
		const durable = fakeDurable([
			["sess-a", [["op-1", { state: "complete", result: { delivered: true } }, Date.now() + 100_000, 1]]],
		]);

		expect(DurableOpStore.withValidator(durable, isBoardReply).get("sess-a", "op-1")).toBeUndefined();
	});
});
