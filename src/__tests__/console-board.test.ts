import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import { type ConsoleRoutes, createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import type { ConversationRegistry, TeamRegistry } from "../gateway/websocket.js";
import { BlobStore, blobIdFor } from "../shared/blob-store.js";
import { BoardAttachmentStore } from "../shared/board-attachment-store.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { SessionStore } from "../shared/session-store.js";
import { fakeDurable, frame, jsonRes, OWNER } from "./helpers/console.js";

describe("createConsoleDispatcher", () => {
	describe("durable send/respond idempotency (restart-proof): board ops", () => {
		it("a board retry across a restart replays the recorded reply instead of regressing a newer write", async () => {
			const opsDurable = fakeDurable();
			const boardStore = new BoardStore(fakeDurable(), new PlaneRegistry(), undefined);
			const deps = {
				registry: new Map() as TeamRegistry,
				conversationRegistry: new Map() as ConversationRegistry,
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes: {
					send: async () => jsonRes({}),
					respond: () => jsonRes({}),
					teams: () => jsonRes([]),
					discover: async () => jsonRes([]),
				} as ConsoleRoutes,
				boardStore,
			};
			const h1 = createConsoleDispatcher({ ...deps, durableOpStore: new DurableOpStore(opsDurable) });
			await h1.handleFrame(
				frame({ kind: "board_upsert", entries: [{ id: "e1", title: "t", state: "open", rank: "m" }] }, "op-up"),
			);
			const setDone = frame({ kind: "board_set_state", id: "e1", state: "done" }, "op-done");
			expect((await h1.handleFrame(setDone)).ok).toBe(true);

			// The agent moves the entry on AFTER the console's reply was lost...
			boardStore.setState(OWNER, "e1", "in_progress", OWNER_ACTOR);

			// ...and the console's retry lands on a RESTARTED gateway: fresh dispatcher, fresh
			// DurableOpStore over the same durable snapshot. The recorded reply replays; the newer
			// write survives.
			const h2 = createConsoleDispatcher({ ...deps, durableOpStore: new DurableOpStore(opsDurable) });
			expect((await h2.handleFrame(setDone)).ok).toBe(true);
			expect(boardStore.entry(OWNER, "e1")?.state).toBe("in_progress");
		});

		it("a member whose bytes exist nowhere is dropped, so the write lands instead of retrying forever", async () => {
			// The class this feature kept rebuilding: an absolute op re-states survivors, so a member
			// whose bytes no machine has could never be satisfied. As a plain error it retries forever
			// and eventually closes the whole Gateway lane; as a refusal it would discard the owner's
			// good attach alongside the dead one. Dropping keeps the op always satisfiable.
			// A real-shaped id: the durable store gates every path segment, so a toy "e1" is refused.
			const entryId = "e".repeat(32);
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-attach-"));
			const boardStore = new BoardStore(fakeDurable(), new PlaneRegistry(), undefined);
			const blobStore = new BlobStore(path.join(dir, "blobs"));
			const boardAttachments = new BoardAttachmentStore(path.join(dir, "board-attachments"));
			const handler = createConsoleDispatcher({
				registry: new Map() as TeamRegistry,
				conversationRegistry: new Map() as ConversationRegistry,
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes: {
					send: async () => jsonRes({}),
					respond: () => jsonRes({}),
					teams: () => jsonRes([]),
					discover: async () => jsonRes([]),
				} as ConsoleRoutes,
				boardStore,
				blobStore,
				boardAttachments,
			});
			await handler.handleFrame(
				frame(
					{ kind: "board_upsert", entries: [{ id: entryId, title: "t", state: "open", rank: "m" }] },
					"op-up",
				),
			);

			// The real digest: the store seal-verifies, so an invented id never completes and the
			// cache lookup would miss for the wrong reason.
			const bytes = Buffer.from("hello");
			const live = blobIdFor(bytes);
			const ghost = `sha256-${"b".repeat(64)}`;
			blobStore.write(live, 0, bytes, true);
			const att = (blobId: string, filename: string) => ({
				blobId,
				blobGateway: "test-host",
				filename,
				mime: "image/png",
				size: bytes.length,
			});

			// The owner's real shape: keep a ghost the Gateway cannot resolve, add a good new picture.
			const reply = await handler.handleFrame(
				frame(
					{
						kind: "board_set_attachments",
						id: entryId,
						attachments: [att(ghost, "gone.png"), att(live, "shot.png")],
						supplied: [live],
					},
					"op-att",
				),
			);

			expect(reply.ok).toBe(true);
			expect((reply.result as { dropped?: string[] }).dropped).toEqual(["gone.png"]);
			// The good attach LANDED, and the stored list names only what the Gateway actually holds.
			expect(boardStore.entry(OWNER, entryId)?.attachments?.map((a) => a.blobId)).toEqual([live]);
			expect(boardAttachments.has(OWNER, entryId, live)).toBe(true);
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it("a member the sender says it is still uploading stays retryable rather than being dropped", async () => {
			// The one case that must NOT drop: the upload legitimately races this write, and dropping
			// would silently lose a picture the owner just attached.
			const entryId = "f".repeat(32);
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-attach-race-"));
			const boardStore = new BoardStore(fakeDurable(), new PlaneRegistry(), undefined);
			const handler = createConsoleDispatcher({
				registry: new Map() as TeamRegistry,
				conversationRegistry: new Map() as ConversationRegistry,
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes: {
					send: async () => jsonRes({}),
					respond: () => jsonRes({}),
					teams: () => jsonRes([]),
					discover: async () => jsonRes([]),
				} as ConsoleRoutes,
				boardStore,
				blobStore: new BlobStore(path.join(dir, "blobs")),
				boardAttachments: new BoardAttachmentStore(path.join(dir, "board-attachments")),
			});
			await handler.handleFrame(
				frame(
					{ kind: "board_upsert", entries: [{ id: entryId, title: "t", state: "open", rank: "m" }] },
					"op-up",
				),
			);

			const arriving = `sha256-${"c".repeat(64)}`;
			const reply = await handler.handleFrame(
				frame(
					{
						kind: "board_set_attachments",
						id: entryId,
						attachments: [
							{
								blobId: arriving,
								blobGateway: "test-host",
								filename: "big.bin",
								mime: "application/octet-stream",
								size: 9,
							},
						],
						supplied: [arriving],
					},
					"op-att",
				),
			);

			expect(reply.ok).toBe(false);
			expect(boardStore.entry(OWNER, entryId)?.attachments).toBeUndefined();
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it("an assign naming the session by its full address stores the bare key every other board reader uses", async () => {
			const boardStore = new BoardStore(fakeDurable(), new PlaneRegistry(), undefined);
			const sessionStore = new SessionStore();
			sessionStore.adoptById("a1b2c3", { spawn: "recipe-app", sessionLabel: "Dinner" });
			const handler = createConsoleDispatcher({
				registry: new Map() as TeamRegistry,
				conversationRegistry: new Map() as ConversationRegistry,
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes: {
					send: async () => jsonRes({}),
					respond: () => jsonRes({}),
					teams: () => jsonRes([]),
					discover: async () => jsonRes([]),
				} as ConsoleRoutes,
				durableOpStore: new DurableOpStore(fakeDurable()),
				boardStore,
				sessionStore,
			});
			await handler.handleFrame(
				frame({ kind: "board_upsert", entries: [{ id: "e1", title: "t", state: "open", rank: "m" }] }, "op-up"),
			);

			// The console holds a chat's Team.name, which is the qualified address. Every board reader
			// on this side keys by the bare local field, so the stored value has to be that one.
			const assign = frame(
				{ kind: "board_set_session", id: "e1", sessionId: "test-domain.test-host.recipe-app.a1b2c3" },
				"op-assign",
			);
			expect((await handler.handleFrame(assign)).ok).toBe(true);
			expect(boardStore.entry(OWNER, "e1")?.sessionId).toBe("recipe-app.a1b2c3");

			// And the session-end hook, which speaks that same bare key, can therefore find it.
			boardStore.sessionEnded("recipe-app.a1b2c3", "release");
			expect(boardStore.entry(OWNER, "e1")?.sessionId).toBeUndefined();
		});

		it("an assign naming a session on ANOTHER Gateway is refused rather than folded onto a local one", async () => {
			const boardStore = new BoardStore(fakeDurable(), new PlaneRegistry(), undefined);
			const sessionStore = new SessionStore();
			sessionStore.adoptById("a1b2c3", { spawn: "recipe-app", sessionLabel: "Dinner" });
			const handler = createConsoleDispatcher({
				registry: new Map() as TeamRegistry,
				conversationRegistry: new Map() as ConversationRegistry,
				mailboxStore: new DeviceMailboxStore(),
				localGatewayId: "test-host",
				localDomainId: "test-domain",
				routes: {
					send: async () => jsonRes({}),
					respond: () => jsonRes({}),
					teams: () => jsonRes([]),
					discover: async () => jsonRes([]),
				} as ConsoleRoutes,
				durableOpStore: new DurableOpStore(fakeDurable()),
				boardStore,
				sessionStore,
			});
			await handler.handleFrame(
				frame({ kind: "board_upsert", entries: [{ id: "e1", title: "t", state: "open", rank: "m" }] }, "op-up"),
			);
			const reply = await handler.handleFrame(
				frame(
					{ kind: "board_set_session", id: "e1", sessionId: "test-domain.other-host.recipe-app.a1b2c3" },
					"op-foreign",
				),
			);
			expect(reply.ok).toBe(false);
			expect(reply.error).toContain("refused:");
			expect(boardStore.entry(OWNER, "e1")?.sessionId).toBeUndefined();
		});
	});
});
