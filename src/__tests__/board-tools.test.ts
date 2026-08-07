import { describe, expect, it } from "vitest";
import { boardRequestBody } from "../mcp/board/boardTools.js";
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
