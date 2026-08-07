import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_TRASH_TTL_MS, BoardStore } from "../gateway/boardStore.js";
import type { BoardEntry } from "../shared/console-protocol.js";
import { DurableStore } from "../shared/durable-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";

const OWNER = "owner-1";

function entry(id: string, over: Partial<BoardEntry> = {}): BoardEntry {
	return { id, title: `t-${id}`, state: "open", rank: "m", ...over };
}

let dir: string;
let store: BoardStore;
let registry: PlaneRegistry;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-store-"));
	registry = new PlaneRegistry();
	store = new BoardStore(new DurableStore(dir, "task-board"), registry, undefined);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("claim contention", () => {
	beforeEach(() => {
		store.upsert(OWNER, [entry("a"), entry("a1", { parent: "a" })]);
	});

	it("a claim takes the subtree, and a lost-reply repeat is a no-op instead of a theft", () => {
		expect(store.claim(OWNER, "a", "sess-1")).toEqual({ applied: true });
		expect(store.entry(OWNER, "a1")?.sessionId).toBe("sess-1");
		expect(store.claim(OWNER, "a", "sess-1")).toEqual({ applied: true });
		expect(store.claim(OWNER, "a", "sess-2")).toEqual({ applied: false, refused: "held" });
	});

	it("release refuses a non-holder and returns the subtree to the pile for the holder", () => {
		store.claim(OWNER, "a", "sess-1");
		expect(store.release(OWNER, "a", "sess-2")).toEqual({ applied: false, refused: "held" });
		expect(store.release(OWNER, "a", "sess-1")).toEqual({ applied: true });
		expect(store.entry(OWNER, "a")?.sessionId).toBeUndefined();
		expect(store.entry(OWNER, "a1")?.sessionId).toBeUndefined();
	});

	it("claiming an ancestor never seizes a member another session holds", () => {
		store.upsert(OWNER, [entry("a2", { parent: "a", sessionId: "sess-2" })]);
		expect(store.claim(OWNER, "a", "sess-1")).toEqual({ applied: false, refused: "held" });
		expect(store.entry(OWNER, "a2")?.sessionId).toBe("sess-2");
		expect(store.entry(OWNER, "a")?.sessionId).toBeUndefined();
	});

	it("releasing a shared ancestor lets go of only the caller's own members", () => {
		store.claim(OWNER, "a", "sess-1");
		store.setSession(OWNER, "a1", "sess-2");
		expect(store.release(OWNER, "a", "sess-1")).toEqual({ applied: true });
		expect(store.entry(OWNER, "a")?.sessionId).toBeUndefined();
		expect(store.entry(OWNER, "a1")?.sessionId).toBe("sess-2");
	});
});

describe("tree rules", () => {
	it("a parent change that would loop refuses and leaves the board untouched", () => {
		store.upsert(OWNER, [entry("a"), entry("b", { parent: "a" }), entry("c", { parent: "b" })]);
		expect(store.setParent(OWNER, "a", "c", "m")).toEqual({ applied: false, refused: "cycle" });
		expect(store.entry(OWNER, "a")?.parent).toBeUndefined();
	});

	it("an upsert may nest under a parent arriving in the same batch, but not under a ghost", () => {
		expect(store.upsert(OWNER, [entry("p"), entry("k", { parent: "p" })])).toEqual({ applied: true });
		expect(store.upsert(OWNER, [entry("x", { parent: "ghost" })])).toEqual({
			applied: false,
			refused: "parent_missing",
		});
	});

	it("remove refuses a batch that would orphan a survivor, so a move must ship its whole subtree", () => {
		store.upsert(OWNER, [entry("a"), entry("a1", { parent: "a" })]);
		expect(store.remove(OWNER, ["a"])).toEqual({ applied: false, refused: "would_orphan" });
		expect(store.remove(OWNER, ["a", "a1"])).toEqual({ applied: true });
		expect(store.entry(OWNER, "a")).toBeUndefined();
	});
});

describe("trash and sweeps", () => {
	it("trash flags the subtree, restore brings it back where it was", () => {
		store.upsert(OWNER, [entry("a"), entry("a1", { parent: "a", state: "done" })]);
		store.setTrashed(OWNER, "a", true, 1000);
		expect(store.entry(OWNER, "a1")?.trashedAt).toBe(1000);
		expect(store.entry(OWNER, "a1")?.state).toBe("done");
		store.setTrashed(OWNER, "a", false);
		expect(store.entry(OWNER, "a")?.trashedAt).toBeUndefined();
		expect(store.entry(OWNER, "a1")?.parent).toBe("a");
	});

	it("a session ending trashes its finished work and returns the rest to the pile", () => {
		store.upsert(OWNER, [
			entry("done1", { sessionId: "s", state: "done" }),
			entry("open1", { sessionId: "s", state: "in_progress" }),
			entry("other", { sessionId: "other-session" }),
		]);
		expect(store.sessionEnded("s", "release", 5000)).toBe(2);
		expect(store.entry(OWNER, "done1")).toMatchObject({ trashedAt: 5000 });
		expect(store.entry(OWNER, "done1")?.sessionId).toBeUndefined();
		expect(store.entry(OWNER, "open1")).not.toHaveProperty("trashedAt");
		expect(store.entry(OWNER, "open1")?.sessionId).toBeUndefined();
		expect(store.entry(OWNER, "other")?.sessionId).toBe("other-session");
	});

	it("the cancel disposition finishes the session's unfinished work in the same pass that trashes it", () => {
		store.upsert(OWNER, [
			entry("open1", { sessionId: "s", state: "open" }),
			entry("busy", { sessionId: "s", state: "in_progress" }),
			entry("done1", { sessionId: "s", state: "done" }),
		]);
		store.sessionEnded("s", "cancel", 5000);
		// Cancelled, and therefore trashed by the same rule that trashes an already-finished entry -
		// one pass, so a crash cannot leave the two halves disagreeing.
		for (const id of ["open1", "busy"]) {
			expect(store.entry(OWNER, id)).toMatchObject({ state: "cancelled", trashedAt: 5000 });
		}
		expect(store.entry(OWNER, "done1")).toMatchObject({ state: "done", trashedAt: 5000 });
		expect(store.entry(OWNER, "busy")?.sessionId).toBeUndefined();
	});

	it("cancel leaves an already-trashed entry's state alone, matching what the prompt counted", () => {
		// The forget prompt counts live unfinished work. An entry the owner trashed earlier was never
		// in that count, so restating it would change something they were not asked about.
		store.upsert(OWNER, [entry("binned", { sessionId: "s", state: "in_progress" })]);
		store.setTrashed(OWNER, "binned", true);
		store.sessionEnded("s", "cancel", 5000);
		expect(store.entry(OWNER, "binned")?.state).toBe("in_progress");
		expect(store.entry(OWNER, "binned")?.sessionId).toBeUndefined();
	});

	it("the disposition covers every entry the STORE holds, not a set a client enumerated", () => {
		// The console can only name entries it has polled. The gateway sees all of them.
		store.upsert(OWNER, [entry("seen", { sessionId: "s" }), entry("unpolled", { sessionId: "s" })]);
		expect(store.sessionEnded("s", "cancel", 5000)).toBe(2);
		expect(store.entry(OWNER, "unpolled")?.state).toBe("cancelled");
	});

	it("the trash sweep deletes only past the window and promotes a swept parent's survivor to root", () => {
		store.upsert(OWNER, [entry("old"), entry("kid", { parent: "old" }), entry("fresh")]);
		store.setTrashed(OWNER, "old", true, 1000);
		store.setTrashed(OWNER, "kid", false);
		const sweepAt = 1000 + BOARD_TRASH_TTL_MS + 1;
		store.setTrashed(OWNER, "fresh", true, sweepAt - 1);
		store.sweepTrash(sweepAt);
		expect(store.entry(OWNER, "old")).toBeUndefined();
		expect(store.entry(OWNER, "kid")?.parent).toBeUndefined();
		expect(store.entry(OWNER, "fresh")).toBeDefined();
	});

	it("clearDone trashes exactly the session's finished entries", () => {
		store.upsert(OWNER, [
			entry("d", { sessionId: "s", state: "done" }),
			entry("c", { sessionId: "s", state: "cancelled" }),
			entry("o", { sessionId: "s", state: "open" }),
			entry("theirs", { sessionId: "s2", state: "done" }),
		]);
		expect(store.clearDone(OWNER, "s", 42)).toBe(2);
		expect(store.entry(OWNER, "o")).not.toHaveProperty("trashedAt");
		expect(store.entry(OWNER, "theirs")).not.toHaveProperty("trashedAt");
	});
});

describe("durability and the plane", () => {
	it("a committed board survives a process restart byte-identically", () => {
		store.upsert(OWNER, [entry("a", { body: "long form" }), entry("b", { parent: "a" })]);
		store.claim(OWNER, "a", "sess-1");
		const reborn = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined);
		expect(reborn.projection(OWNER)).toEqual(store.projection(OWNER));
	});

	it("a refusal leaves the file untouched", () => {
		store.upsert(OWNER, [entry("a")]);
		const before = fs.readFileSync(path.join(dir, "task-board.json"), "utf8");
		store.setParent(OWNER, "a", "ghost", "m");
		expect(fs.readFileSync(path.join(dir, "task-board.json"), "utf8")).toBe(before);
	});

	it("a same-value op neither rewrites the file nor bumps the revision", () => {
		store.upsert(OWNER, [entry("a", { body: "text" })]);
		const file = path.join(dir, "task-board.json");
		const before = fs.readFileSync(file, "utf8");
		expect(store.setState(OWNER, "a", "open")).toEqual({ applied: true });
		expect(store.setBody(OWNER, "a", "text")).toEqual({ applied: true });
		expect(store.upsert(OWNER, [entry("a", { body: "text" })])).toEqual({ applied: true });
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});

	it("one invalid entry on disk drops alone instead of emptying the board", () => {
		store.upsert(OWNER, [entry("good", { body: "keep me" }), entry("other")]);
		const file = path.join(dir, "task-board.json");
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		raw.owners[OWNER].entries.push({ id: "poison", title: "t", state: "open", rank: "V".repeat(65) });
		fs.writeFileSync(file, JSON.stringify(raw));

		const reborn = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined);
		expect(reborn.entry(OWNER, "good")?.body).toBe("keep me");
		expect(reborn.entry(OWNER, "other")).toBeDefined();
		expect(reborn.entry(OWNER, "poison")).toBeUndefined();
	});

	it("an oversized rank refuses at the write path, and endRank rebalances instead of overflowing", () => {
		expect(store.upsert(OWNER, [entry("bad", { rank: "V".repeat(65) })])).toEqual({
			applied: false,
			refused: "bad_rank",
		});

		// A full-width tail of MAX digits is the one shape whose end-mint OVERFLOWS: midpoint consumes
		// every digit and appends one more. A 63-digit tail still mints inside the bound and would
		// never reach the rebalance this asserts.
		const overflowing = "z".repeat(64);
		store.upsert(OWNER, [entry("tail", { rank: overflowing })]);
		const minted = store.endRank(OWNER, undefined);
		expect(minted.length).toBeLessThanOrEqual(64);
		// The rebalance ran: the existing sibling was renumbered, not left at its old rank.
		const tail = store.entry(OWNER, "tail")!.rank;
		expect(tail).not.toBe(overflowing);
		expect(tail < minted).toBe(true);
	});

	it("the projection sorts by id whatever the insertion order, so the plane hash is stable", () => {
		store.upsert(OWNER, [entry("z"), entry("a"), entry("m")]);
		const other = new BoardStore(new DurableStore(dir, "task-board-2"), new PlaneRegistry(), undefined);
		other.upsert(OWNER, [entry("m"), entry("z"), entry("a")]);
		expect(other.projection(OWNER).entries.map((e) => e.id)).toEqual(
			store.projection(OWNER).entries.map((e) => e.id),
		);
	});
});
