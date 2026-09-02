import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoardActor, BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import { BOARD_TRASH_TTL_MS } from "../shared/board-structure.js";
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

const upsert = (entries: BoardEntry[]) => store.upsert(OWNER, entries, OWNER_ACTOR);
const setState = (id: string, state: BoardEntry["state"]) => store.setState(OWNER, id, state, OWNER_ACTOR);
const setBody = (id: string, body: string | undefined) => store.setBody(OWNER, id, body, OWNER_ACTOR);
const setParent = (id: string, parent: string | undefined, rank: string) =>
	store.setParent(OWNER, id, parent, rank, OWNER_ACTOR);

describe("claim contention", () => {
	beforeEach(() => {
		upsert([entry("a"), entry("a1", { parent: "a" })]);
	});

	it("a claim takes the subtree, and a lost-reply repeat is a no-op instead of a theft", () => {
		expect(store.claim(OWNER, "a", "sess-1")).toEqual({ applied: true });
		expect(store.entry(OWNER, "a1")?.sessionId).toBe("sess-1");
		expect(store.claim(OWNER, "a", "sess-1")).toEqual({ applied: true });
		expect(store.claim(OWNER, "a", "sess-2")).toEqual({ applied: false, refused: "held" });
	});

	it("release refuses a non-holder and returns the subtree to the backlog for the holder", () => {
		store.claim(OWNER, "a", "sess-1");
		expect(store.release(OWNER, "a", "sess-2")).toEqual({ applied: false, refused: "held" });
		expect(store.release(OWNER, "a", "sess-1")).toEqual({ applied: true });
		expect(store.entry(OWNER, "a")?.sessionId).toBeUndefined();
		expect(store.entry(OWNER, "a1")?.sessionId).toBeUndefined();
	});

	it("claiming an ancestor never seizes a member another session holds", () => {
		upsert([entry("a2", { parent: "a", sessionId: "sess-2" })]);
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

describe("write scope", () => {
	const MINE: BoardActor = { kind: "session", sessionId: "sess-1" };

	beforeEach(() => {
		upsert([entry("mine", { sessionId: "sess-1" }), entry("theirs", { sessionId: "sess-2" }), entry("loose")]);
	});

	it("a session writes what it holds and nothing else", () => {
		expect(store.setTitle(OWNER, "mine", "renamed", MINE)).toEqual({ applied: true });
		expect(store.setTitle(OWNER, "theirs", "renamed", MINE)).toEqual({ applied: false, refused: "held" });
		expect(store.setState(OWNER, "loose", "done", MINE)).toEqual({ applied: false, refused: "held" });
		expect(store.entry(OWNER, "theirs")?.title).toBe("t-theirs");
	});

	it("a session cannot graft its subtree under another session's entry", () => {
		// Scope-check the destination, not only the subject.
		expect(store.setParentAtEnd(OWNER, "mine", "theirs", MINE)).toEqual({ applied: false, refused: "held" });
		expect(store.entry(OWNER, "mine")?.parent).toBeUndefined();
	});

	it("a session cannot create a child under another session's entry", () => {
		const created = store.createAtEnd(OWNER, { id: "new", title: "t", state: "open", parent: "theirs" }, MINE);
		expect(created).toEqual({ applied: false, refused: "held" });
		expect(store.entry(OWNER, "new")).toBeUndefined();
	});

	it("a session reaches the backlog through claim, which is the whole point of the backlog", () => {
		expect(store.createAtEnd(OWNER, { id: "note", title: "for later", state: "open" }, MINE)).toEqual({
			applied: true,
		});
		expect(store.setState(OWNER, "note", "done", MINE)).toEqual({ applied: false, refused: "held" });
		expect(store.claim(OWNER, "note", "sess-1")).toEqual({ applied: true });
		expect(store.setState(OWNER, "note", "done", MINE)).toEqual({ applied: true });
	});

	it("the trash is the owner's alone: a session can neither claim nor edit what is in it", () => {
		// Trashed entries cannot be claimed from stale session state.
		store.setTrashed(OWNER, "mine", true, 1000);
		expect(store.claim(OWNER, "mine", "sess-1")).toEqual({ applied: false, refused: "entry_missing" });
		expect(store.setTitle(OWNER, "mine", "rewritten", MINE)).toEqual({
			applied: false,
			refused: "entry_missing",
		});
		expect(store.entry(OWNER, "mine")?.title).toBe("t-mine");
	});

	it("nesting follows the same rule as writing, so a backlog entry cannot be locked out from under a claim", () => {
		// A claimed child requires a claimed parent.
		const created = store.createAtEnd(OWNER, { id: "sub", title: "s", state: "open", parent: "loose" }, MINE);
		expect(created).toEqual({ applied: false, refused: "held" });
		expect(store.claim(OWNER, "loose", "sess-2")).toEqual({ applied: true });
	});

	it("the owner is scoped out of nothing", () => {
		expect(store.setTitle(OWNER, "theirs", "renamed", OWNER_ACTOR)).toEqual({ applied: true });
		expect(store.setParentAtEnd(OWNER, "mine", "theirs", OWNER_ACTOR)).toEqual({ applied: true });
	});
});

describe("tree rules", () => {
	it("a parent change that would loop refuses and leaves the board untouched", () => {
		upsert([entry("a"), entry("b", { parent: "a" }), entry("c", { parent: "b" })]);
		expect(setParent("a", "c", "m")).toEqual({ applied: false, refused: "cycle" });
		expect(store.entry(OWNER, "a")?.parent).toBeUndefined();
	});

	it("an upsert may nest under a parent arriving in the same batch, but not under a ghost", () => {
		expect(upsert([entry("p"), entry("k", { parent: "p" })])).toEqual({ applied: true });
		expect(upsert([entry("x", { parent: "ghost" })])).toEqual({
			applied: false,
			refused: "parent_missing",
		});
	});

	it("remove refuses a batch that would orphan a survivor, so a move must ship its whole subtree", () => {
		upsert([entry("a"), entry("a1", { parent: "a" })]);
		expect(store.remove(OWNER, ["a"])).toEqual({ applied: false, refused: "would_orphan" });
		expect(store.remove(OWNER, ["a", "a1"])).toEqual({ applied: true });
		expect(store.entry(OWNER, "a")).toBeUndefined();
	});
});

describe("trash and sweeps", () => {
	it("trash flags the subtree, restore brings it back where it was", () => {
		upsert([entry("a"), entry("a1", { parent: "a", state: "done" })]);
		store.setTrashed(OWNER, "a", true, 1000);
		expect(store.entry(OWNER, "a1")?.trashedAt).toBe(1000);
		expect(store.entry(OWNER, "a1")?.state).toBe("done");
		store.setTrashed(OWNER, "a", false);
		expect(store.entry(OWNER, "a")?.trashedAt).toBeUndefined();
		expect(store.entry(OWNER, "a1")?.parent).toBe("a");
	});

	it("a session ending trashes its finished work and returns the rest to the backlog", () => {
		upsert([
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
		upsert([
			entry("open1", { sessionId: "s", state: "open" }),
			entry("busy", { sessionId: "s", state: "in_progress" }),
			entry("done1", { sessionId: "s", state: "done" }),
		]);
		store.sessionEnded("s", "cancel", 5000);
		// Cancellation and trash are one durable transition.
		for (const id of ["open1", "busy"]) {
			expect(store.entry(OWNER, id)).toMatchObject({ state: "cancelled", trashedAt: 5000 });
		}
		expect(store.entry(OWNER, "done1")).toMatchObject({ state: "done", trashedAt: 5000 });
		expect(store.entry(OWNER, "busy")?.sessionId).toBeUndefined();
	});

	it("cancel leaves an already-trashed entry's state alone, matching what the prompt counted", () => {
		upsert([entry("binned", { sessionId: "s", state: "in_progress" })]);
		store.setTrashed(OWNER, "binned", true);
		store.sessionEnded("s", "cancel", 5000);
		expect(store.entry(OWNER, "binned")?.state).toBe("in_progress");
		expect(store.entry(OWNER, "binned")?.sessionId).toBeUndefined();
	});

	it("clear leaves a finished entry that still has live children, so no pointer dangles", () => {
		// Trashing a parent also removes its children from listings.
		upsert([
			entry("p", { sessionId: "s", state: "done" }),
			entry("kid", { parent: "p", sessionId: "s", state: "open" }),
			entry("solo", { sessionId: "s", state: "done" }),
		]);
		expect(store.clearDone(OWNER, "s", 5000)).toBe(1);
		expect(store.entry(OWNER, "solo")?.trashedAt).toBe(5000);
		expect(store.entry(OWNER, "p")?.trashedAt).toBeUndefined();

		setState("kid", "done");
		expect(store.clearDone(OWNER, "s", 6000)).toBe(2);
		expect(store.entry(OWNER, "p")?.trashedAt).toBe(6000);
	});

	it("the disposition covers every entry the STORE holds, not a set a client enumerated", () => {
		upsert([entry("seen", { sessionId: "s" }), entry("unpolled", { sessionId: "s" })]);
		expect(store.sessionEnded("s", "cancel", 5000)).toBe(2);
		expect(store.entry(OWNER, "unpolled")?.state).toBe("cancelled");
	});

	it("the trash sweep deletes only past the window and promotes a swept parent's survivor to root", () => {
		upsert([entry("old"), entry("kid", { parent: "old" }), entry("fresh")]);
		store.setTrashed(OWNER, "old", true, 1000);
		store.setTrashed(OWNER, "kid", false);
		const sweepAt = 1000 + BOARD_TRASH_TTL_MS + 1;
		store.setTrashed(OWNER, "fresh", true, sweepAt - 1);
		store.sweepTrash(sweepAt);
		expect(store.entry(OWNER, "old")).toBeUndefined();
		expect(store.entry(OWNER, "kid")?.parent).toBeUndefined();
		expect(store.entry(OWNER, "fresh")).toBeDefined();
	});

	it("clearDone keeps a done parent whose child is another session's, so the tree stays whole", () => {
		// Finished children still prevent parent trashing.
		upsert([
			entry("p", { sessionId: "s1", state: "done" }),
			entry("c", { parent: "p", sessionId: "s2", state: "done" }),
		]);
		expect(store.clearDone(OWNER, "s1", 1000)).toBe(0);
		expect(store.entry(OWNER, "p")?.trashedAt).toBeUndefined();
		expect(store.entry(OWNER, "c")?.parent).toBe("p");
	});

	it("clearDone prunes a wholly finished subtree, parent and children together", () => {
		upsert([
			entry("p", { sessionId: "s1", state: "done" }),
			entry("c", { parent: "p", sessionId: "s1", state: "cancelled" }),
			entry("g", { parent: "c", sessionId: "s1", state: "done" }),
		]);
		expect(store.clearDone(OWNER, "s1", 1000)).toBe(3);
		for (const id of ["p", "c", "g"]) expect(store.entry(OWNER, id)?.trashedAt).toBe(1000);
	});

	it("sessionEnded keeps a parent whose child belongs to a session that is not ending", () => {
		upsert([
			entry("p", { sessionId: "s1", state: "done" }),
			entry("c", { parent: "p", sessionId: "s2", state: "open" }),
		]);
		store.sessionEnded("s1", "cancel", 1000);
		expect(store.entry(OWNER, "p")?.trashedAt).toBeUndefined();
		expect(store.entry(OWNER, "p")?.sessionId).toBeUndefined();
		expect(store.entry(OWNER, "c")?.parent).toBe("p");
	});

	it("clearDone trashes exactly the session's finished entries", () => {
		upsert([
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
		upsert([entry("a", { body: "long form" }), entry("b", { parent: "a" })]);
		store.claim(OWNER, "a", "sess-1");
		const reborn = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined);
		expect(reborn.projection(OWNER)).toEqual(store.projection(OWNER));
	});

	it("a refusal leaves the file untouched", () => {
		upsert([entry("a")]);
		const before = fs.readFileSync(path.join(dir, "task-board.json"), "utf8");
		setParent("a", "ghost", "m");
		expect(fs.readFileSync(path.join(dir, "task-board.json"), "utf8")).toBe(before);
	});

	it("a same-value op neither rewrites the file nor bumps the revision", () => {
		upsert([entry("a", { body: "text" })]);
		const file = path.join(dir, "task-board.json");
		const before = fs.readFileSync(file, "utf8");
		expect(setState("a", "open")).toEqual({ applied: true });
		expect(setBody("a", "text")).toEqual({ applied: true });
		expect(upsert([entry("a", { body: "text" })])).toEqual({ applied: true });
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});

	it("one invalid entry on disk drops alone instead of emptying the board", () => {
		upsert([entry("good", { body: "keep me" }), entry("other")]);
		const file = path.join(dir, "task-board.json");
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		raw.owners[OWNER].entries.push({ id: "poison", title: "t", state: "open", rank: "V".repeat(65) });
		fs.writeFileSync(file, JSON.stringify(raw));

		const reborn = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined);
		expect(reborn.entry(OWNER, "good")?.body).toBe("keep me");
		expect(reborn.entry(OWNER, "other")).toBeDefined();
		expect(reborn.entry(OWNER, "poison")).toBeUndefined();
	});

	it("an oversized rank refuses at the write path, and a create rebalances instead of overflowing", () => {
		expect(upsert([entry("bad", { rank: "V".repeat(65) })])).toEqual({
			applied: false,
			refused: "bad_rank",
		});

		// A full-width tail forces rank rebalance.
		const overflowing = "z".repeat(64);
		upsert([entry("tail", { rank: overflowing })]);
		expect(store.createAtEnd(OWNER, { id: "fresh", title: "t", state: "open" }, OWNER_ACTOR)).toEqual({
			applied: true,
		});
		const tail = store.entry(OWNER, "tail")!.rank;
		const minted = store.entry(OWNER, "fresh")!.rank;
		expect(minted.length).toBeLessThanOrEqual(64);
		expect(tail).not.toBe(overflowing);
		expect(tail < minted).toBe(true);
	});

	it("a refused create leaves no rebalance behind it", () => {
		// Refusal must not commit a rank rewrite.
		upsert([entry("tail", { rank: `${"z".repeat(64)}` })]);
		expect(
			store.createAtEnd(OWNER, { id: "fresh", title: "t", state: "open", parent: "ghost" }, OWNER_ACTOR),
		).toEqual({ applied: false, refused: "parent_missing" });
		expect(store.entry(OWNER, "tail")!.rank).toBe("z".repeat(64));
	});

	it("the projection sorts by id whatever the insertion order, so the plane hash is stable", () => {
		upsert([entry("z"), entry("a"), entry("m")]);
		const other = new BoardStore(new DurableStore(dir, "task-board-2"), new PlaneRegistry(), undefined);
		other.upsert(OWNER, [entry("m"), entry("z"), entry("a")], OWNER_ACTOR);
		expect(other.projection(OWNER).entries.map((e) => e.id)).toEqual(
			store.projection(OWNER).entries.map((e) => e.id),
		);
	});
});
