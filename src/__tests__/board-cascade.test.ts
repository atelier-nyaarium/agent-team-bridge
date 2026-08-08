import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import type { BoardEntry } from "../shared/console-protocol.js";
import { DurableStore } from "../shared/durable-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";

const OWNER = "owner-1";

function entry(id: string, over: Partial<BoardEntry> = {}): BoardEntry {
	return { id, title: `t-${id}`, state: "open", rank: "m", ...over };
}

let dir: string;
let store: BoardStore;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-cascade-"));
	store = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const upsert = (entries: BoardEntry[]) => store.upsert(OWNER, entries, OWNER_ACTOR);
const setState = (id: string, state: BoardEntry["state"]) => store.setState(OWNER, id, state, OWNER_ACTOR);
const stateOf = (id: string) => store.entry(OWNER, id)?.state;

/** The board as `id:state` pairs, so a case asserts the whole outcome rather than one entry. */
const states = (...ids: string[]) => ids.map((id) => `${id}:${stateOf(id)}`);

describe("finishing the last child finishes the parent", () => {
	beforeEach(() => {
		upsert([entry("p"), entry("c1", { parent: "p" }), entry("c2", { parent: "p" })]);
	});

	it("holds the parent open while any child is unfinished, then completes it", () => {
		setState("c1", "done");
		expect(states("p", "c1", "c2")).toEqual(["p:open", "c1:done", "c2:open"]);

		setState("c2", "done");
		expect(states("p", "c1", "c2")).toEqual(["p:done", "c1:done", "c2:done"]);
	});

	it("reads a mix of done and cancelled as done, since some of it was really finished", () => {
		setState("c1", "cancelled");
		setState("c2", "done");
		expect(stateOf("p")).toBe("done");
	});

	it("cancels the parent only when every child was cancelled", () => {
		setState("c1", "cancelled");
		setState("c2", "cancelled");
		expect(stateOf("p")).toBe("cancelled");
	});

	it("does not count in_progress or paused as finished", () => {
		setState("c1", "done");
		setState("c2", "paused");
		expect(stateOf("p")).toBe("open");
	});

	it("names what it moved, so the caller can say so", () => {
		setState("c1", "done");
		const result = setState("c2", "done");
		expect(result).toEqual({
			applied: true,
			cascaded: [{ id: "p", title: "t-p", from: "open", to: "done", reason: "children_finished" }],
		});
	});

	it("says nothing when the write moved only the entry it named", () => {
		expect(setState("c1", "done")).toEqual({ applied: true });
	});
});

describe("finishing a parent finishes what hangs off it", () => {
	it("carries done all the way down the chain", () => {
		upsert([entry("p"), entry("c", { parent: "p" }), entry("g", { parent: "c" })]);
		setState("p", "done");
		expect(states("p", "c", "g")).toEqual(["p:done", "c:done", "g:done"]);
	});

	it("carries cancelled down the same way", () => {
		upsert([entry("p"), entry("c", { parent: "p" })]);
		setState("p", "cancelled");
		expect(stateOf("c")).toBe("cancelled");
	});

	it("leaves an already-cancelled child cancelled, because cancelling was deliberate", () => {
		upsert([entry("p"), entry("c1", { parent: "p", state: "cancelled" }), entry("c2", { parent: "p" })]);
		setState("p", "done");
		expect(states("p", "c1", "c2")).toEqual(["p:done", "c1:cancelled", "c2:done"]);
	});

	it("cancelling a parent leaves work that was already done, since it really was done", () => {
		upsert([entry("p"), entry("c1", { parent: "p", state: "done" }), entry("c2", { parent: "p" })]);
		setState("p", "cancelled");
		expect(states("p", "c1", "c2")).toEqual(["p:cancelled", "c1:done", "c2:cancelled"]);
	});

	it("keeps that parent cancelled when the board is walked again later", () => {
		// Its children now read as "all terminal, one done", which is the shape that makes an UNfinished
		// parent done. It must not promote a parent the owner deliberately cancelled.
		upsert([entry("p"), entry("c1", { parent: "p", state: "done" }), entry("c2", { parent: "p" })]);
		setState("p", "cancelled");
		store.setTrashed(OWNER, "c2", true);
		expect(stateOf("p")).toBe("cancelled");
	});

	it("does not complete a leaf that simply has no children", () => {
		upsert([entry("solo")]);
		expect(stateOf("solo")).toBe("open");
	});
});

describe("reopening", () => {
	it("reopens every finished ancestor when a descendant goes back to unfinished", () => {
		upsert([
			entry("p", { state: "done" }),
			entry("c", { parent: "p", state: "done" }),
			entry("g", { parent: "c", state: "done" }),
		]);
		setState("g", "in_progress");
		expect(states("p", "c", "g")).toEqual(["p:open", "c:open", "g:in_progress"]);
	});

	it("reopens a cancelled ancestor too", () => {
		upsert([entry("p", { state: "cancelled" }), entry("c", { parent: "p", state: "cancelled" })]);
		setState("c", "open");
		expect(stateOf("p")).toBe("open");
	});

	it("leaves the reopened parent's other finished children alone", () => {
		upsert([
			entry("p", { state: "done" }),
			entry("c1", { parent: "p", state: "done" }),
			entry("c2", { parent: "p", state: "done" }),
		]);
		setState("c1", "open");
		expect(states("p", "c1", "c2")).toEqual(["p:open", "c1:open", "c2:done"]);
	});
});

describe("a child that stops counting", () => {
	it("completes the parent when the last unfinished child is trashed", () => {
		upsert([entry("p"), entry("c1", { parent: "p", state: "done" }), entry("c2", { parent: "p" })]);
		store.setTrashed(OWNER, "c2", true);
		expect(stateOf("p")).toBe("done");
	});

	it("completes the parent when the last unfinished child is moved away", () => {
		upsert([entry("p"), entry("other"), entry("c1", { parent: "p", state: "done" }), entry("c2", { parent: "p" })]);
		store.setParentAtEnd(OWNER, "c2", "other", OWNER_ACTOR);
		expect(states("p", "other")).toEqual(["p:done", "other:open"]);
	});

	it("leaves a parent alone once every child is trashed, since it is a leaf again", () => {
		upsert([entry("p"), entry("c", { parent: "p" })]);
		store.setTrashed(OWNER, "c", true);
		expect(stateOf("p")).toBe("open");
	});
});

describe("gaining a child", () => {
	it("reopens a done parent when unfinished work is created under it", () => {
		upsert([entry("p", { state: "done" })]);
		store.createAtEnd(OWNER, entry("fresh", { parent: "p" }), OWNER_ACTOR);
		expect(states("p", "fresh")).toEqual(["p:open", "fresh:open"]);
	});

	it("reopens a done parent when unfinished work is moved under it", () => {
		upsert([entry("p", { state: "done" }), entry("loose")]);
		store.setParentAtEnd(OWNER, "loose", "p", OWNER_ACTOR);
		expect(stateOf("p")).toBe("open");
	});

	it("leaves a done parent done when the work moved under it is already finished", () => {
		upsert([entry("p", { state: "done" }), entry("loose", { state: "done" })]);
		store.setParentAtEnd(OWNER, "loose", "p", OWNER_ACTOR);
		expect(stateOf("p")).toBe("done");
	});
});
