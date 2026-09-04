import { describe, expect, it } from "vitest";
import { applyCascade } from "../shared/board-cascade.js";
import type { BoardEntry } from "../shared/console-protocol.js";

const entry = (id: string, over: Partial<BoardEntry> = {}): BoardEntry => ({
	id,
	title: `t-${id}`,
	state: "open",
	rank: "m",
	...over,
});

const run = (entries: BoardEntry[], _written: string[]) => {
	const map = new Map(entries.map((item) => [item.id, item]));
	return { map, changes: [] };
};

describe("board cascade", () => {
	it("holds the parent open while a child is unfinished", () => {
		const { map } = run([entry("p"), entry("c1", { parent: "p" }), entry("c2", { parent: "p" })], ["c1"]);
		map.get("c1")!.state = "done";
		applyCascade(map, ["c1"]);
		expect(map.get("p")?.state).toBe("open");
	});

	it("finishes a parent when its last child finishes", () => {
		const { map } = run(
			[entry("p"), entry("c1", { parent: "p", state: "done" }), entry("c2", { parent: "p" })],
			["c1"],
		);
		map.get("c2")!.state = "done";
		const changes = applyCascade(map, ["c2"]);
		expect(map.get("p")?.state).toBe("done");
		expect(changes).toContainEqual({
			id: "p",
			title: "t-p",
			from: "open",
			to: "done",
			reason: "children_finished",
		});
	});

	it("reads mixed terminal children as done", () => {
		const { map } = run(
			[entry("p"), entry("c1", { parent: "p", state: "cancelled" }), entry("c2", { parent: "p", state: "done" })],
			["c2"],
		);
		applyCascade(map, ["c2"]);
		expect(map.get("p")?.state).toBe("done");
	});

	it("cancels a parent when all children are cancelled", () => {
		const { map } = run(
			[entry("p"), entry("c1", { parent: "p", state: "cancelled" }), entry("c2", { parent: "p" })],
			["c1"],
		);
		map.get("c2")!.state = "cancelled";
		applyCascade(map, ["c2"]);
		expect(map.get("p")?.state).toBe("cancelled");
	});

	it("does not finish a parent with unfinished children", () => {
		const { map } = run(
			[entry("p"), entry("c1", { parent: "p", state: "done" }), entry("c2", { parent: "p", state: "paused" })],
			["c1"],
		);
		expect(map.get("p")?.state).toBe("open");
	});

	it("propagates done through a chain", () => {
		const { map } = run([entry("p"), entry("c", { parent: "p" }), entry("g", { parent: "c" })], ["p"]);
		map.get("p")!.state = "done";
		applyCascade(map, ["p"]);
		expect([...map.values()].map((e) => e.state)).toEqual(["done", "done", "done"]);
	});

	it("propagates cancelled through a chain", () => {
		const { map } = run([entry("p"), entry("c", { parent: "p" })], ["p"]);
		map.get("p")!.state = "cancelled";
		applyCascade(map, ["p"]);
		expect(map.get("c")?.state).toBe("cancelled");
	});

	it("keeps an already-cancelled child cancelled", () => {
		const { map } = run(
			[entry("p"), entry("c1", { parent: "p", state: "cancelled" }), entry("c2", { parent: "p" })],
			["p"],
		);
		map.get("p")!.state = "done";
		applyCascade(map, ["p"]);
		expect(map.get("c1")?.state).toBe("cancelled");
	});

	it("leaves an already-done child done when cancelling a parent", () => {
		const { map } = run(
			[entry("p"), entry("c1", { parent: "p", state: "done" }), entry("c2", { parent: "p" })],
			["p"],
		);
		map.get("p")!.state = "cancelled";
		applyCascade(map, ["p"]);
		expect(map.get("c1")?.state).toBe("done");
		expect(map.get("c2")?.state).toBe("cancelled");
	});

	it("does not change a leaf", () => {
		const { map, changes } = run([entry("solo")], ["solo"]);
		expect(map.get("solo")?.state).toBe("open");
		expect(changes).toEqual([]);
	});

	it("reopens every finished ancestor", () => {
		const { map } = run(
			[
				entry("p", { state: "done" }),
				entry("c", { parent: "p", state: "done" }),
				entry("g", { parent: "c", state: "in_progress" }),
			],
			["g"],
		);
		applyCascade(map, ["g"]);
		expect([...map.values()].map((e) => e.state)).toEqual(["open", "open", "in_progress"]);
	});

	it("reopens a cancelled ancestor", () => {
		const { map } = run([entry("p", { state: "cancelled" }), entry("c", { parent: "p", state: "open" })], ["c"]);
		applyCascade(map, ["c"]);
		expect(map.get("p")?.state).toBe("open");
	});

	it("leaves other finished children alone on reopen", () => {
		const { map } = run(
			[
				entry("p", { state: "done" }),
				entry("c1", { parent: "p", state: "open" }),
				entry("c2", { parent: "p", state: "done" }),
			],
			["c1"],
		);
		applyCascade(map, ["c1"]);
		expect(map.get("p")?.state).toBe("open");
		expect(map.get("c2")?.state).toBe("done");
	});

	it("finishes a parent when the last unfinished child is trashed", () => {
		const { map } = run(
			[entry("p"), entry("c1", { parent: "p", state: "done" }), entry("c2", { parent: "p", trashedAt: 1 })],
			["c2"],
		);
		const changes = applyCascade(map, [], ["p"]);
		expect(map.get("p")?.state).toBe("done");
		expect(changes).toContainEqual({
			id: "p",
			title: "t-p",
			from: "open",
			to: "done",
			reason: "children_finished",
		});
	});

	it("finishes a parent when the last unfinished child is moved away", () => {
		const { map } = run(
			[entry("p"), entry("other"), entry("c1", { parent: "p", state: "done" }), entry("c2", { parent: "other" })],
			["c2"],
		);
		const changes = applyCascade(map, ["c2"], ["p"]);
		expect(map.get("p")?.state).toBe("done");
		expect(changes).toContainEqual(expect.objectContaining({ id: "p", to: "done" }));
	});

	it("reopens a done parent when unfinished work is created under it", () => {
		const { map } = run([entry("p", { state: "done" }), entry("fresh", { parent: "p" })], ["fresh"]);
		const changes = applyCascade(map, ["fresh"]);
		expect(map.get("p")?.state).toBe("open");
		expect(changes).toContainEqual(expect.objectContaining({ id: "p", to: "open", reason: "child_reopened" }));
	});

	it("reopens a done parent when unfinished work is moved under it", () => {
		const { map } = run([entry("p", { state: "done" }), entry("loose", { parent: "p" })], ["loose"]);
		const changes = applyCascade(map, ["loose"]);
		expect(map.get("p")?.state).toBe("open");
		expect(changes).toContainEqual(expect.objectContaining({ id: "p", to: "open" }));
	});

	it("leaves a done parent done when finished work is moved under it", () => {
		const { map } = run([entry("p", { state: "done" }), entry("loose", { parent: "p", state: "done" })], ["loose"]);
		expect(applyCascade(map, ["loose"])).toEqual([]);
		expect(map.get("p")?.state).toBe("done");
	});

	it("ignores trashed children", () => {
		const { map } = run([entry("p"), entry("c", { parent: "p", trashedAt: 1 })], ["c"]);
		expect(applyCascade(map, ["c"])).toEqual([]);
	});

	it("does not alter entries without a live parent", () => {
		const { map, changes } = run([entry("c", { parent: "missing", state: "done" })], ["c"]);
		expect(map.get("c")?.state).toBe("done");
		expect(changes).toEqual([]);
	});

	it("does not switch one terminal parent to another", () => {
		const { map } = run([entry("p", { state: "cancelled" }), entry("c", { parent: "p", state: "done" })], ["c"]);
		expect(map.get("p")?.state).toBe("cancelled");
	});

	it("names cascaded changes", () => {
		const { map } = run([entry("p"), entry("c", { parent: "p", state: "done" })], ["c"]);
		const changes = applyCascade(map, ["c"]);
		expect(changes[0]).toMatchObject({ id: "p", title: "t-p", reason: "children_finished" });
	});

	it("returns no change for an unchanged write", () => {
		const { map } = run([entry("p"), entry("c", { parent: "p" })], ["c"]);
		expect(applyCascade(map, ["c"])).toEqual([]);
	});

	it("bounds corrupted traversal", () => {
		const { map } = run([entry("a", { parent: "b" }), entry("b", { parent: "a" })], ["a"]);
		expect(applyCascade(map, ["a"]).length).toBeLessThanOrEqual(8);
	});

	it("handles orphaned parents", () => {
		const map = new Map([["p", entry("p", { state: "done" })]]);
		expect(applyCascade(map, [], ["p"])).toEqual([]);
	});
});
