import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { createRoutes, createRoutesCarryOver, type RoutesDeps } from "../gateway/routes.js";
import { boardRequestBody } from "../mcp/board/boardTools.js";
import { isBoardReply } from "../shared/board-structure.js";
import { DurableStore } from "../shared/durable-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { SessionStore } from "../shared/session-store.js";
import { makeCtx } from "./helpers/routes.js";

describe("routes", () => {
	describe("/task-board", () => {
		function makeBoardCtx(): { ctx: RoutesDeps; board: BoardStore } {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-route-"));
			const board = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined);
			// Rebuilds share the durable board instance.
			const ctx = makeCtx({ boardStore: board, ownerId: () => "owner-1", carryOver: createRoutesCarryOver() });
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

		it("a rebuilt route table still replays a settled mutation instead of re-applying it", async () => {
			// Rebuilds preserve the caller's reply record.
			const { ctx, board } = makeBoardCtx();
			const created = await call(createRoutes(ctx).taskBoard, {
				from: "recipe-app",
				action: "create",
				operationId: "op-create",
				title: "Original",
				assignTo: "self",
			});
			const id = created.body.id as string;
			const rename = {
				from: "recipe-app",
				action: "update" as const,
				operationId: "op-rename",
				id,
				title: "Renamed once",
			};
			await call(createRoutes(ctx).taskBoard, rename);
			// Replay must not overwrite a newer owner edit.
			board.setTitle("owner-1", id, "Owner's later edit", OWNER_ACTOR);
			await call(createRoutes(ctx).taskBoard, rename);

			const list = await call(createRoutes(ctx).taskBoard, { from: "recipe-app", action: "list", scope: "all" });
			const entry = (list.body.entries as Array<Record<string, unknown>>).find((e) => e.id === id);
			expect(entry?.title).toBe("Owner's later edit");
		});

		it("every tool's request body is one the route accepts", async () => {
			// Keep tool and route schemas aligned.
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
			// Replay keys cover writes that return attachment ids.
			expect(boardRequestBody("attachments", { id: "bd_x" }).operationId).toBeUndefined();
			expect(boardRequestBody("list").operationId).toBeUndefined();
			expect(boardRequestBody("update", { id: "bd_x" }).operationId).toBeDefined();
		});

		it("the agent's list carries attachment names and never the ids that fetch them", async () => {
			// Strip blob ids at the route boundary. They are bearer tokens.
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

			const fetched = await call(taskBoard, { from: "recipe-app", ...boardRequestBody("attachments", { id }) });
			expect(fetched.body.attachments).toMatchObject([{ blobId, blobGateway: "gw-1" }]);
		});

		it("a retried backlog create replays instead of refusing the caller its own entry", async () => {
			// Derive the entry id from the operation id for retry idempotence.
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
			// Absolute writes must not regress newer state.
			const { ctx, board } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const created = await call(taskBoard, {
				from: "recipe-app",
				...boardRequestBody("create", { title: "t", assignTo: "self" }),
			});
			const id = created.body.id as string;
			const update = { from: "recipe-app", ...boardRequestBody("update", { id, state: "paused" }) };
			expect((await call(taskBoard, update)).body).toMatchObject({ applied: true });

			board.setState("owner-1", id, "done", OWNER_ACTOR);
			expect((await call(taskBoard, update)).body).toMatchObject({ applied: true });
			expect(board.entry("owner-1", id)?.state).toBe("done");
		});

		it("an update naming no changed field still refuses an entry this session cannot see", async () => {
			// Unknown and unauthorized ids share one response.
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

		it("a durable replay survives a restart, so a retried update cannot regress a newer edit", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-replay-"));
			const board = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined);
			const replayDurable = new DurableStore(dir, "board-idempotency");
			const boot = () =>
				createRoutes(
					makeCtx({
						boardStore: board,
						ownerId: () => "owner-1",
						carryOver: createRoutesCarryOver(),
						boardReplays: DurableOpStore.withValidator(replayDurable, isBoardReply),
					}),
				);

			const before = boot();
			const id = (
				await call(before.taskBoard, {
					from: "recipe-app",
					action: "create",
					operationId: "op-c",
					title: "orig",
					assignTo: "self",
				})
			).body.id as string;
			const update = { from: "recipe-app", action: "update", id, operationId: "op-u", state: "done" };
			await call(before.taskBoard, update);

			await call(before.taskBoard, { from: "recipe-app", action: "update", id, state: "in_progress" });
			await call(boot().taskBoard, update);

			const after = (
				(await call(boot().taskBoard, { from: "recipe-app", action: "list", scope: "session" })).body
					.entries as {
					state: string;
				}[]
			)[0];
			expect(after.state).toBe("in_progress");
		});

		it("one operation id reused across two actions replays neither into the other", async () => {
			// Include the action in replay keys.
			const { ctx } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const created = await call(taskBoard, {
				from: "recipe-app",
				action: "create",
				operationId: "dup",
				title: "shared id",
				assignTo: "backlog",
			});
			const id = created.body.id as string;

			const claimed = await call(taskBoard, { from: "recipe-app", action: "claim", operationId: "dup", id });

			expect(claimed.body).toMatchObject({ applied: true });
			expect(claimed.body.id).toBeUndefined();
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

		/** Board context with one bound session. */
		function makeGuardedCtx(): { ctx: RoutesDeps; token: string; boundTeam: string } {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-guard-"));
			const board = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined);
			const sessionStore = new SessionStore();
			const record = sessionStore.mint({ spawn: "recipe-app" });
			const token = sessionStore.ensureBindToken(record);
			sessionStore.activateBinding(record);
			const ctx = makeCtx({
				boardStore: board,
				sessionStore,
				ownerId: () => "owner-1",
				carryOver: createRoutesCarryOver(),
			});
			return { ctx, token, boundTeam: sessionStore.teamOf(record) };
		}

		function callAs(
			taskBoard: ReturnType<typeof createRoutes>["taskBoard"],
			body: Record<string, unknown>,
			token?: string,
		) {
			const req = new Request("http://localhost/task-board", {
				method: "POST",
				headers: token ? { "x-session-token": token } : {},
			});
			const res = taskBoard(req, body);
			return res.json().then((b) => ({ status: res.status, body: b as Record<string, unknown> }));
		}

		it("refuses a caller that proves nothing, whatever name it invents", async () => {
			const { ctx, boundTeam } = makeGuardedCtx();
			const { taskBoard } = createRoutes(ctx);
			const invented = await callAs(taskBoard, { from: "not-a-real-session", action: "list", scope: "all" });
			expect(invented.status).toBe(403);
			expect(invented.body.entries).toBeUndefined();
			expect((await callAs(taskBoard, { from: boundTeam, action: "list", scope: "all" })).status).toBe(403);
		});

		it("refuses before it says whether a name exists, so a scan learns nothing either way", async () => {
			const { ctx, boundTeam } = makeGuardedCtx();
			const { taskBoard } = createRoutes(ctx);
			const real = await callAs(taskBoard, { from: boundTeam, action: "list", scope: "all" });
			const invented = await callAs(taskBoard, { from: "not-a-real-session", action: "list", scope: "all" });
			// Unknown and unbound targets must not reveal board existence.
			expect(invented.status).toBe(real.status);
			expect(invented.body.error).toBe(real.body.error);
		});

		it("admits a caller holding one of this gateway's bound tokens", async () => {
			const { ctx, token, boundTeam } = makeGuardedCtx();
			const { taskBoard } = createRoutes(ctx);
			const listed = await callAs(taskBoard, { from: boundTeam, action: "list", scope: "all" }, token);
			expect(listed.status).toBe(200);
			expect(listed.body.entries).toEqual([]);
		});

		it("stays open where nothing is bound at all, the hand-launched deployment", async () => {
			// A gateway without a bound session has no credential to check.
			const { ctx } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			expect((await callAs(taskBoard, { from: "recipe-app", action: "list", scope: "all" })).status).toBe(200);
		});
	});
});
