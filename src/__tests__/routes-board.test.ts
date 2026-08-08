import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import { createRoutes, type RoutesDeps } from "../gateway/routes.js";
import { boardRequestBody } from "../mcp/board/boardTools.js";
import { DurableStore } from "../shared/durable-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { makeCtx } from "./helpers/routes.js";

describe("routes", () => {
	describe("/task-board", () => {
		function makeBoardCtx(): { ctx: RoutesDeps; board: BoardStore } {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-route-"));
			const board = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined);
			const ctx = makeCtx({ boardStore: board, ownerId: () => "owner-1" });
			return { ctx, board };
		}

		async function call(taskBoard: ReturnType<typeof createRoutes>["taskBoard"], body: Record<string, unknown>) {
			const res = taskBoard(new Request("http://localhost/task-board", { method: "POST" }), body);
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		}

		it("create derives the entry id from the operation id, so a retried POST replays one entry", async () => {
			const { ctx } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const first = await call(taskBoard, {
				from: "recipe-app",
				action: "create",
				operationId: "op-abc",
				title: "Fix the drift check",
				assignTo: "self",
			});
			const second = await call(taskBoard, {
				from: "recipe-app",
				action: "create",
				operationId: "op-abc",
				title: "Fix the drift check",
				assignTo: "self",
			});
			expect(first.body).toMatchObject({ applied: true });
			expect(second.body.id).toBe(first.body.id);
			const list = await call(taskBoard, { from: "recipe-app", action: "list", scope: "session" });
			expect(list.body.entries).toHaveLength(1);
		});

		it("every tool's request body is one the route accepts", async () => {
			// The tools build their bodies and the route validates them strictly, but nothing else
			// holds the two together - a field renamed on either side would only show on a device.
			const { ctx } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const created = await call(taskBoard, {
				from: "recipe-app",
				...boardRequestBody("create", { title: "Ship the board", assignTo: "self", body: "detail" }),
			});
			expect(created.body).toMatchObject({ applied: true });
			const id = created.body.id as string;

			for (const body of [
				boardRequestBody("list", { scope: "unclaimed" }),
				boardRequestBody("attachments", { id }),
				boardRequestBody("update", { id, state: "in_progress", title: "Renamed", body: null }),
				boardRequestBody("release", { id }),
				boardRequestBody("claim", { id }),
				boardRequestBody("clear"),
			]) {
				const res = await call(taskBoard, { from: "recipe-app", ...body });
				expect(res.status, `${body.action} was rejected: ${JSON.stringify(res.body)}`).toBe(200);
				expect(res.body.error).toBeUndefined();
			}
		});

		it("a fetch mints no operation id, so it is never recorded for replay", () => {
			// The route replays a recorded reply BEFORE it consults the store, so an operation id here
			// would hand back blobIds for pictures the owner has since swapped. Nothing in the route
			// scopes replay to writes; this one Set is the whole protection.
			expect(boardRequestBody("attachments", { id: "bd_x" }).operationId).toBeUndefined();
			expect(boardRequestBody("list").operationId).toBeUndefined();
			expect(boardRequestBody("update", { id: "bd_x" }).operationId).toBeDefined();
		});

		it("the agent's list carries attachment names and never the ids that fetch them", async () => {
			// A blobId is a bearer token and the list is the only place an agent could otherwise get
			// one. Stripping happens ROUTE-side, so an older plugin cannot leak them during a deploy.
			const { ctx, board } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const created = await call(taskBoard, {
				from: "recipe-app",
				...boardRequestBody("create", { title: "With a picture", assignTo: "self" }),
			});
			const id = created.body.id as string;
			const blobId = `sha256-${"a".repeat(64)}`;
			board.setAttachments(
				"owner-1",
				id,
				[{ blobId, blobGateway: "gw-1", filename: "shot.png", mime: "image/png", size: 3 }],
				OWNER_ACTOR,
			);

			const listed = await call(taskBoard, { from: "recipe-app", ...boardRequestBody("list") });
			const entry = (listed.body.entries as Array<Record<string, unknown>>).find((e) => e.id === id);
			expect(entry?.attachments).toEqual([{ filename: "shot.png", mime: "image/png", size: 3 }]);
			expect(JSON.stringify(listed.body)).not.toContain(blobId);

			// The plumbing lives on its own action, which the tool handler calls and the model never sees.
			const fetched = await call(taskBoard, { from: "recipe-app", ...boardRequestBody("attachments", { id }) });
			expect(fetched.body.attachments).toMatchObject([{ blobId, blobGateway: "gw-1" }]);
		});

		it("a retried backlog create replays instead of refusing the caller its own entry", async () => {
			// The id derives from the operation id, so the second POST finds the entry already there.
			// A backlog create leaves it UNASSIGNED, which a scope check would refuse - telling the
			// caller a create that landed will never apply, whose only recovery is a duplicate.
			const { ctx } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const body = { from: "recipe-app", ...boardRequestBody("create", { title: "later", assignTo: "backlog" }) };
			const first = await call(taskBoard, body);
			const retry = await call(taskBoard, body);
			expect(first.body).toMatchObject({ applied: true });
			expect(retry.body).toMatchObject({ applied: true, id: first.body.id });
			const list = await call(taskBoard, { from: "recipe-app", action: "list", scope: "unclaimed" });
			expect(list.body.entries).toHaveLength(1);
		});

		it("a retried update replays its recorded reply instead of re-applying an absolute set", async () => {
			// These writes are absolute, so re-running one after a newer write regresses the field.
			const { ctx, board } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const created = await call(taskBoard, {
				from: "recipe-app",
				...boardRequestBody("create", { title: "t", assignTo: "self" }),
			});
			const id = created.body.id as string;
			const update = { from: "recipe-app", ...boardRequestBody("update", { id, state: "paused" }) };
			expect((await call(taskBoard, update)).body).toMatchObject({ applied: true });

			// The reply was lost; meanwhile the owner moved it on from their console. The retry must
			// not revert that.
			board.setState("owner-1", id, "done", OWNER_ACTOR);
			expect((await call(taskBoard, update)).body).toMatchObject({ applied: true });
			expect(board.entry("owner-1", id)?.state).toBe("done");
		});

		it("an update naming no changed field still refuses an entry this session cannot see", async () => {
			// Otherwise applied:true for a held entry and entry_missing for an unknown one is an
			// oracle telling a session which ids exist - the one thing list is built never to leak.
			const { ctx, board } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			board.upsert("owner-1", [{ id: "theirs", title: "t", state: "open", rank: "m", sessionId: "other" }], {
				kind: "owner",
			});
			for (const args of [{ id: "theirs" }, { id: "theirs", parent: null }]) {
				const res = await call(taskBoard, { from: "recipe-app", ...boardRequestBody("update", args) });
				expect(res.body).toEqual({ applied: false, refused: "held" });
			}
		});

		it("a session cannot reparent onto another session's entry through the route", async () => {
			const { ctx, board } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const mine = await call(taskBoard, {
				from: "recipe-app",
				...boardRequestBody("create", { title: "mine", assignTo: "self" }),
			});
			board.upsert("owner-1", [{ id: "theirs", title: "t", state: "open", rank: "m", sessionId: "other" }], {
				kind: "owner",
			});
			const moved = await call(taskBoard, {
				from: "recipe-app",
				...boardRequestBody("update", { id: mine.body.id as string, parent: "theirs" }),
			});
			expect(moved.body).toEqual({ applied: false, refused: "held" });
		});

		it("a create replayed after an edit reverts nothing", async () => {
			const { ctx } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const create = {
				from: "recipe-app",
				action: "create",
				operationId: "op-r",
				title: "orig",
				assignTo: "self",
			};
			const id = (await call(taskBoard, create)).body.id as string;
			await call(taskBoard, { from: "recipe-app", action: "update", id, state: "done", title: "edited" });

			await call(taskBoard, create);
			const after = (
				(await call(taskBoard, { from: "recipe-app", action: "list", scope: "session" })).body.entries as {
					title: string;
					state: string;
				}[]
			)[0];
			expect(after).toMatchObject({ title: "edited", state: "done" });
		});

		it("never returns another session's entries at any scope, and a claim of held work refuses", async () => {
			const { ctx } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			await call(taskBoard, {
				from: "other-app",
				action: "create",
				operationId: "o1",
				title: "theirs",
				assignTo: "self",
			});
			await call(taskBoard, {
				from: "other-app",
				action: "create",
				operationId: "o2",
				title: "backlog item",
				assignTo: "backlog",
			});
			const theirs = (await call(taskBoard, { from: "other-app", action: "list", scope: "session" })).body
				.entries as { id: string }[];

			for (const scope of ["unclaimed", "session", "all"]) {
				const seen = (await call(taskBoard, { from: "recipe-app", action: "list", scope })).body.entries as {
					title: string;
				}[];
				expect(seen.map((e) => e.title)).not.toContain("theirs");
			}

			const claim = await call(taskBoard, { from: "recipe-app", action: "claim", id: theirs[0].id });
			expect(claim.status).toBe(200);
			expect(claim.body).toEqual({ applied: false, refused: "held" });
		});

		it("claiming from the backlog moves it into the session scope, and release returns it", async () => {
			const { ctx } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const created = await call(taskBoard, {
				from: "recipe-app",
				action: "create",
				operationId: "o3",
				title: "a thought",
				assignTo: "backlog",
			});
			const id = created.body.id as string;

			expect((await call(taskBoard, { from: "recipe-app", action: "claim", id })).body).toEqual({
				applied: true,
			});
			const mine = (await call(taskBoard, { from: "recipe-app", action: "list", scope: "session" })).body
				.entries as {
				id: string;
			}[];
			expect(mine.map((e) => e.id)).toContain(id);

			expect((await call(taskBoard, { from: "recipe-app", action: "release", id })).body).toEqual({
				applied: true,
			});
			// A lost-reply retry of the release stays a no-op success, never a refusal.
			expect((await call(taskBoard, { from: "recipe-app", action: "release", id })).body).toEqual({
				applied: true,
			});
		});

		it("update touches only the caller's own entries and clear trashes only its finished ones", async () => {
			const { ctx } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			await call(taskBoard, {
				from: "other-app",
				action: "create",
				operationId: "o4",
				title: "theirs",
				assignTo: "self",
			});
			const theirsId = (
				(await call(taskBoard, { from: "other-app", action: "list", scope: "session" })).body.entries as {
					id: string;
				}[]
			)[0].id;
			const mineId = (
				await call(taskBoard, {
					from: "recipe-app",
					action: "create",
					operationId: "o5",
					title: "mine",
					assignTo: "self",
				})
			).body.id as string;

			expect(
				(await call(taskBoard, { from: "recipe-app", action: "update", id: theirsId, state: "done" })).body,
			).toEqual({
				applied: false,
				refused: "held",
			});
			expect(
				(
					await call(taskBoard, {
						from: "recipe-app",
						action: "update",
						id: mineId,
						state: "done",
						body: "long form",
					})
				).body,
			).toEqual({ applied: true });

			const cleared = await call(taskBoard, { from: "recipe-app", action: "clear" });
			expect(cleared.body).toEqual({ applied: true, cleared: 1 });
			const after = (await call(taskBoard, { from: "recipe-app", action: "list", scope: "session" })).body
				.entries as [];
			expect(after).toHaveLength(0);
			const theirsAfter = (await call(taskBoard, { from: "other-app", action: "list", scope: "session" })).body
				.entries as [];
			expect(theirsAfter).toHaveLength(1);
		});

		it("503s with no board wired and 400s a create missing its required fields", async () => {
			const bare = createRoutes(makeCtx({ ownerId: () => "owner-1" }));
			expect((await call(bare.taskBoard, { from: "recipe-app", action: "list" })).status).toBe(503);

			const { ctx } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			expect((await call(taskBoard, { from: "recipe-app", action: "create", title: "no op id" })).status).toBe(
				400,
			);
		});
	});
});
