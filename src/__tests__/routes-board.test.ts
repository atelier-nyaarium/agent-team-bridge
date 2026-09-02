import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBoardService } from "../federation-server/board/boardService.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { createBoardClient } from "../gateway/router/boardClient.js";
import { createRoutes, createRoutesCarryOver, type RoutesDeps } from "../gateway/routes.js";
import { boardRequestBody } from "../mcp/board/boardTools.js";
import { isBoardReply } from "../shared/board-structure.js";
import type { BoardAttachment } from "../shared/console-protocol.js";
import { boardTextAadKind, type ContentAad, openContent, sealContent } from "../shared/content-envelope.js";
import { generateIdentity } from "../shared/crypto.js";
import { DurableStore } from "../shared/durable-store.js";
import type { BoardStoredEntry } from "../shared/schemasBoardState.js";
import type { ContentEnvelope } from "../shared/schemasContentKey.js";
import { SessionStore } from "../shared/session-store.js";
import { makeCtx } from "./helpers/routes.js";

describe("routes", () => {
	describe("/task-board", () => {
		function makeBoardCtx(): {
			ctx: RoutesDeps;
			board: BoardStoredEntry[];
			ownerWrite: (ops: unknown[]) => void;
			setTitle: (id: string, title: string) => void;
			setState: (id: string, state: "open" | "in_progress" | "paused" | "done" | "cancelled") => void;
			seed: (entry: BoardStoredEntry) => void;
			seedEntry: (id: string, title: string, sessionId?: string, attachment?: BoardAttachment) => void;
			dropReply: () => void;
			calls: string[];
		} {
			const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-route-"));
			const identity = generateIdentity();
			const key = Buffer.alloc(32, 7);
			const owners = new Map([["owner-1", identity.sign.pub]]);
			const registry = new OwnerStoreRegistry({
				dataDir,
				ownerOf: (domainId) => owners.get(domainId) ?? null,
				quotaFor: () =>
					new DomainQuota({
						dir: dataDir,
						limitBytes: 100_000_000,
						statfs: () => ({ available: 100_000_000 }),
					}),
				now: () => 100,
			});
			const service = createBoardService({
				registry,
				inbox: {
					hasSession: () => true,
					appendRouterRow: (input) => ({ outcome: "accepted" as const, opKey: input.opKey }),
				},
				referenceHeld: { has: () => true, hold: () => {}, release: () => {} },
			});
			const board: BoardStoredEntry[] = [];
			const calls: string[] = [];
			let dropNextReply = false;
			let revision = 0;
			const call = async (action: string, params: Record<string, unknown>) => {
				calls.push(action);
				if (action === "board_read") {
					const answer = service.read("owner-1");
					revision = answer.revision;
					board.splice(0, board.length, ...answer.entries);
					return { result: answer };
				}
				const write = params.write as { expectedRevision: number; ops: never[] };
				const answer = service.write(
					"owner-1",
					write,
					{
						kind: "session",
						session: { domainId: "owner-1", gatewayId: "test-host", sessionId: params.sessionId as string },
					},
					params.opId as string | undefined,
				);
				revision = answer.revision;
				board.splice(0, board.length, ...answer.entries);
				if (dropNextReply) {
					dropNextReply = false;
					throw new Error("dropped reply");
				}
				return { result: answer };
			};
			const keys = {
				seal: (
					plaintext: Buffer,
					aad: { domainId: string; ownerSignPub: string; kind: ContentAad["kind"] },
				) => ({
					kind: "ok" as const,
					envelope: sealContent(plaintext, key, { ...aad, epoch: 1 }),
				}),
				open: (
					envelope: ContentEnvelope,
					aad: {
						domainId: string;
						ownerSignPub: string;
						epoch: number;
						kind: ContentAad["kind"];
					},
				) => {
					try {
						return { kind: "ok" as const, plaintext: openContent(envelope, key, aad) };
					} catch {
						return { kind: "bad_tag" as const };
					}
				},
			};
			const boardClient = createBoardClient({
				call,
				domainId: "owner-1",
				gatewayId: "test-host",
				ownerSignPub: () => identity.sign.pub,
				keys,
			});
			const ownerWrite = (ops: unknown[]) => {
				const answer = service.write(
					"owner-1",
					{ expectedRevision: revision, ops: ops as never[] },
					{ kind: "owner" },
				);
				revision = answer.revision;
				board.splice(0, board.length, ...answer.entries);
			};
			const seal = (text: string, kind: ContentAad["kind"]) =>
				sealContent(Buffer.from(text), key, {
					domainId: "owner-1",
					ownerSignPub: identity.sign.pub,
					kind,
					epoch: 1,
				});
			const setTitle = (id: string, title: string) => {
				const entry = board.find((item) => item.clear.id === id)!;
				ownerWrite([
					{
						kind: "upsert",
						id,
						rank: entry.clear.rank,
						state: entry.clear.state,
						title: seal(title, boardTextAadKind("board.title", id)),
						...(entry.clear.session ? { session: entry.clear.session } : {}),
						...(entry.clear.parent ? { parent: entry.clear.parent } : {}),
						...(entry.sealed.body ? { body: entry.sealed.body } : {}),
						...(entry.sealed.names ? { names: entry.sealed.names } : {}),
					},
				]);
			};
			const setState = (id: string, state: "open" | "in_progress" | "paused" | "done" | "cancelled") =>
				ownerWrite([{ kind: "set_state", id, state }]);
			const seed = (entry: BoardStoredEntry) =>
				ownerWrite([
					{
						kind: "upsert",
						id: entry.clear.id,
						rank: entry.clear.rank,
						state: entry.clear.state,
						title: entry.sealed.title,
						...(entry.clear.session ? { session: entry.clear.session } : {}),
						...(entry.clear.parent ? { parent: entry.clear.parent } : {}),
						...(entry.sealed.names ? { names: entry.sealed.names } : {}),
					},
				]);
			const seedEntry = (id: string, title: string, sessionId?: string, attachment?: BoardAttachment) => {
				const sealedTitle = seal(title, boardTextAadKind("board.title", id));
				seed({
					clear: {
						id,
						state: "open",
						rank: "m",
						version: 1,
						...(sessionId ? { session: { domainId: "owner-1", gatewayId: "test-host", sessionId } } : {}),
					},
					sealed: {
						title: sealedTitle,
						...(attachment
							? {
									names: {
										[attachment.blobId]: seal(
											attachment.filename,
											boardTextAadKind("board.name", `${id}\n${attachment.blobId}`),
										),
									},
								}
							: {}),
					},
				});
				if (attachment)
					ownerWrite([
						{
							kind: "set_attachments",
							id,
							attachments: [
								{
									blobId: attachment.blobId,
									size: attachment.size,
									mime: attachment.mime,
									blobGateway: attachment.blobGateway,
								},
							],
						},
					]);
			};
			const ctx = makeCtx({ boardClient, ownerId: () => "owner-1", carryOver: createRoutesCarryOver() });
			return {
				ctx,
				board,
				ownerWrite,
				setTitle,
				setState,
				seed,
				seedEntry,
				dropReply: () => (dropNextReply = true),
				calls,
			};
		}

		async function call(taskBoard: ReturnType<typeof createRoutes>["taskBoard"], body: Record<string, unknown>) {
			const res = await taskBoard(new Request("http://localhost/task-board", { method: "POST" }), body);
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

		it("retries a lost Router reply without reverting a newer edit", async () => {
			const { ctx, dropReply, setTitle } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const created = await call(taskBoard, {
				from: "recipe-app",
				action: "create",
				operationId: "create-op",
				title: "Initial",
				assignTo: "self",
			});
			const id = created.body.id as string;
			const update = { from: "recipe-app", action: "update", operationId: "update-op", id, title: "Old edit" };
			dropReply();
			await expect(call(taskBoard, update)).rejects.toThrow("dropped reply");
			setTitle(id, "New edit");
			expect((await call(taskBoard, update)).body).toMatchObject({ applied: true });
			const listed = await call(taskBoard, { from: "recipe-app", action: "list", scope: "session" });
			expect((listed.body.entries as Array<{ title: string }>)[0]?.title).toBe("New edit");
		});

		it("a rebuilt route table still replays a settled mutation instead of re-applying it", async () => {
			// Rebuilds preserve the caller's reply record.
			const { ctx, setTitle, calls } = makeBoardCtx();
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
			const writes = calls.filter((action) => action === "board_op").length;
			// Replay must not overwrite a newer owner edit.
			setTitle(id, "Owner's later edit");
			await call(createRoutes(ctx).taskBoard, rename);
			expect(calls.filter((action) => action === "board_op").length).toBe(writes);

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
			const { ctx, board, seedEntry } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const created = await call(taskBoard, {
				from: "recipe-app",
				...boardRequestBody("create", { title: "With a picture", assignTo: "self" }),
			});
			const id = created.body.id as string;
			const blobId = `sha256-${"a".repeat(64)}`;
			seedEntry(id, "With a picture", board.find((entry) => entry.clear.id === id)?.clear.session?.sessionId, {
				blobId,
				blobGateway: "gw-1",
				filename: "shot.png",
				mime: "image/png",
				size: 3,
			});

			const listed = await call(taskBoard, { from: "recipe-app", ...boardRequestBody("list") });
			const entry = (listed.body.entries as Array<Record<string, unknown>>).find((e) => e.id === id);
			expect(entry?.attachments).toEqual([{ filename: "shot.png", mime: "image/png", size: 3 }]);
			expect(JSON.stringify(listed.body)).not.toContain(blobId);

			const fetched = await call(taskBoard, { from: "recipe-app", ...boardRequestBody("attachments", { id }) });
			expect(fetched.body.attachments).toMatchObject([{ blobId, blobGateway: "gw-1" }]);

			await call(taskBoard, { from: "recipe-app", ...boardRequestBody("update", { id, title: "Renamed" }) });
			const renamed = await call(taskBoard, { from: "recipe-app", ...boardRequestBody("list") });
			expect(
				(renamed.body.entries as Array<Record<string, unknown>>).find((entry) => entry.id === id),
			).toMatchObject({
				title: "Renamed",
				attachments: [{ filename: "shot.png" }],
			});
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
			const { ctx, setState, board } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const created = await call(taskBoard, {
				from: "recipe-app",
				...boardRequestBody("create", { title: "t", assignTo: "self" }),
			});
			const id = created.body.id as string;
			const update = { from: "recipe-app", ...boardRequestBody("update", { id, state: "paused" }) };
			expect((await call(taskBoard, update)).body).toMatchObject({ applied: true });

			setState(id, "done");
			expect((await call(taskBoard, update)).body).toMatchObject({ applied: true });
			expect(board.find((entry) => entry.clear.id === id)?.clear.state).toBe("done");
		});

		it("an update naming no changed field still refuses an entry this session cannot see", async () => {
			// Unknown and unauthorized ids share one response.
			const { ctx, seedEntry } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			seedEntry("theirs", "t", "other");
			for (const args of [{ id: "theirs" }, { id: "theirs", parent: null }]) {
				const res = await call(taskBoard, { from: "recipe-app", ...boardRequestBody("update", args) });
				expect(res.body).toEqual({ applied: false, refused: "held" });
			}
		});

		it("a session cannot reparent onto another session's entry through the route", async () => {
			const { ctx, seedEntry } = makeBoardCtx();
			const { taskBoard } = createRoutes(ctx);
			const mine = await call(taskBoard, {
				from: "recipe-app",
				...boardRequestBody("create", { title: "mine", assignTo: "self" }),
			});
			seedEntry("theirs", "t", "other");
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
			const replayDurable = DurableOpStore.withValidator(
				new DurableStore(dir, "board-idempotency"),
				isBoardReply,
			);
			const { ctx } = makeBoardCtx();
			const boot = () =>
				createRoutes(
					makeCtx({
						boardClient: ctx.boardClient,
						ownerId: () => "owner-1",
						carryOver: createRoutesCarryOver(),
						boardReplays: replayDurable,
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

		it("503s when the Router answers an error", async () => {
			const ctx = makeCtx({
				boardClient: {
					read: async () => ({ kind: "unavailable", error: "router offline" }),
					mutate: async () => ({ kind: "unavailable", error: "router offline" }),
				} as unknown as RoutesDeps["boardClient"],
				ownerId: () => "owner-1",
			});
			const result = await call(createRoutes(ctx).taskBoard, { from: "recipe-app", action: "list" });
			expect(result.status).toBe(503);
			expect(result.body).toEqual({ error: "router offline" });
			expect(result.body.refused).toBeUndefined();
		});

		/** Board context with one bound session. */
		function makeGuardedCtx(): { ctx: RoutesDeps; token: string; boundTeam: string } {
			const { ctx: boardCtx } = makeBoardCtx();
			const sessionStore = new SessionStore();
			const record = sessionStore.mint({ spawn: "recipe-app" });
			const token = sessionStore.ensureBindToken(record);
			sessionStore.activateBinding(record);
			const ctx = makeCtx({
				boardClient: boardCtx.boardClient,
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
			return taskBoard(req, body).then(async (res) => ({
				status: res.status,
				body: (await res.json()) as Record<string, unknown>,
			}));
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
