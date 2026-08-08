import { describe, expect, it } from "vitest";
import { boardRequestBody, cascadeProse } from "../mcp/board/boardTools.js";
import { GATED_CAPABILITY_IDS } from "../mcp/capabilities.js";

describe("task board tool requests", () => {
	it("never names a session, so a tool cannot write as another one", () => {
		// `from` decides whose entries the gateway will let the call touch. postBoard supplies this
		// process's own identity; a body carrying one would be a way around that.
		const bodies = [
			boardRequestBody("list", { scope: "all" }),
			boardRequestBody("claim", { id: "bd_1" }),
			boardRequestBody("release", { id: "bd_1" }),
			boardRequestBody("create", { title: "Ship it", assignTo: "self" }),
			boardRequestBody("update", { id: "bd_1", state: "done" }),
			boardRequestBody("clear"),
		];
		for (const body of bodies) expect(body).not.toHaveProperty("from");
	});

	it("every mutating action carries a fresh operation id, and reads carry none", () => {
		// The id is what makes an HTTP retry a replay: create derives its entry id from it, the rest
		// rely on the route's record of it. A repeated CALL is a new write and must not collide.
		for (const action of ["claim", "release", "create", "update", "clear"] as const) {
			const first = boardRequestBody(action, { id: "bd_1", title: "a", assignTo: "backlog" });
			const second = boardRequestBody(action, { id: "bd_1", title: "a", assignTo: "backlog" });
			expect(first.operationId, `${action} minted none`).toEqual(expect.any(String));
			expect(first.operationId, `${action} reused one`).not.toBe(second.operationId);
		}
		expect(boardRequestBody("list", { scope: "all" })).not.toHaveProperty("operationId");
	});

	it("omits an absent optional rather than sending undefined, which the strict route would refuse", () => {
		expect(boardRequestBody("create", { title: "a", assignTo: "self" })).toEqual({
			action: "create",
			operationId: expect.any(String),
			title: "a",
			assignTo: "self",
		});
	});

	it("distinguishes an absent parent from a null one", () => {
		// Absent means leave the placement alone; null means move to top level. Collapsing them would
		// make every field-only update re-rank the entry.
		expect(boardRequestBody("update", { id: "bd_1", title: "t" })).not.toHaveProperty("parent");
		expect(boardRequestBody("update", { id: "bd_1", parent: null })).toMatchObject({ parent: null });
	});

	it("the taskboard capability is gated, so the tools cannot register unannounced", () => {
		expect(GATED_CAPABILITY_IDS).toContain("taskboard");
	});
});

describe("what the board moved on its own", () => {
	it("names each entry and why, and says the write is already done", () => {
		const text = cascadeProse([
			{ id: "bd_1", title: "Phase 1", from: "open", to: "done", reason: "children_finished" },
			{ id: "bd_2", title: "Write it up", from: "open", to: "done", reason: "parent_finished" },
		]);
		expect(text).toContain('"Phase 1" is now done, because everything under it is finished.');
		expect(text).toContain('"Write it up" is now done, because the entry above it was finished.');
		expect(text).toContain("needs no follow-up write");
	});

	it("counts in words, so one entry does not read as a list", () => {
		const one = cascadeProse([{ title: "Solo", to: "done", reason: "children_finished" }]);
		expect(one).toContain("one other entry");
		expect(
			cascadeProse([
				{ title: "a", to: "done" },
				{ title: "b", to: "done" },
			]),
		).toContain("2 other entries");
	});

	it("still names an entry whose reason this plugin does not know", () => {
		// The gateway updates on its own trigger and may ship a reason added after this build. Dropping
		// the row would hide a state change; dropping the clause alone loses nothing that matters.
		const text = cascadeProse([{ title: "Later", to: "cancelled", reason: "something_new" }]);
		expect(text).toContain('"Later" is now cancelled.');
	});

	it("says nothing at all when there is nothing to say", () => {
		// An older gateway sends no field, and a same-version one sends none when nothing moved. Both
		// have to leave the plain answer untouched rather than append an empty heading.
		for (const raw of [undefined, null, [], "cascaded", [{ id: "bd_1" }]]) {
			expect(cascadeProse(raw)).toBe("");
		}
	});
});
