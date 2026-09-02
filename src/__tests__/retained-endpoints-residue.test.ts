import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BoardView } from "../gateway/router/boardClient.js";
import { createRoutes, createRoutesCarryOver, type RoutesDeps } from "../gateway/routes.js";
import { boardRequestBody } from "../mcp/board/boardTools.js";
import type { BoardEntry } from "../shared/console-protocol.js";
import {
	BoardAttachmentSchema,
	BoardEntrySchema,
	CapabilityBundleSchema,
	ConsoleListTeamsResultSchema,
	TeamInfoSchema,
} from "../shared/schemas.js";
import { SessionStore } from "../shared/session-store.js";
import { makeCtx } from "./helpers/routes.js";

function json(response: Response): Promise<unknown> {
	return response.json();
}

function request(token?: string): Request {
	return new Request("http://localhost/task-board", {
		method: "POST",
		headers: token ? { "x-session-token": token } : {},
	});
}

function boardClient(entries: BoardEntry[]): RoutesDeps["boardClient"] {
	return {
		read: async () => ({ kind: "ok", revision: entries.length, entries }),
		mutate: async (sessionId, mutation) => {
			const view = {
				revision: entries.length,
				entries,
				entry: (id: string) => entries.find((entry) => entry.id === id),
				textIntact: () => true,
				siblings: () => [],
				placeAtEnd: () => ({ rank: "m", rebalanced: [] }),
			} as BoardView;
			const ops = mutation(view);
			if (!Array.isArray(ops)) return { kind: "unchanged" };
			for (const op of ops) {
				if (op.kind !== "upsert") continue;
				entries.push({
					id: op.id,
					title: op.title,
					state: op.state ?? "open",
					rank: op.rank,
					...(op.body === undefined ? {} : { body: op.body }),
					...(op.parent === undefined ? {} : { parent: op.parent }),
					...(op.sessionKey === undefined
						? {}
						: {
								sessionId: op.sessionKey,
								session: { domainId: "alice", gatewayId: "test-host", sessionId: op.sessionKey },
							}),
				});
			}
			return { kind: "applied", revision: entries.length, entries, cascaded: [] };
		},
	} as RoutesDeps["boardClient"];
}

describe("retained gateway endpoint residue", () => {
	it("serves capability data matching the consumer schema", async () => {
		const { capabilities } = createRoutes(makeCtx());
		const answer = await json(await capabilities());

		expect(CapabilityBundleSchema.safeParse(answer).success).toBe(true);
	});

	it("serves both discovery shapes matching their consumer schemas", async () => {
		const { discover } = createRoutes(makeCtx());
		const bare = await json(await discover(new URL("http://localhost/discover")));
		const covered = await json(await discover(new URL("http://localhost/discover?coverage=1")));

		expect(Array.isArray(bare)).toBe(true);
		expect((bare as unknown[]).every((row) => TeamInfoSchema.safeParse(row).success)).toBe(true);
		expect(ConsoleListTeamsResultSchema.safeParse(covered).success).toBe(true);
	});

	it("keeps board list entries schema-safe and attachment bearer fields separate", async () => {
		const entries: BoardEntry[] = [];
		const ctx = makeCtx({ boardClient: boardClient(entries) });
		const { taskBoard } = createRoutes(ctx);
		const created = (await json(
			await taskBoard(request(), {
				from: "recipe-app",
				...boardRequestBody("create", { title: "With a file", assignTo: "backlog" }),
			}),
		)) as { id: string };
		entries[0].attachments = [
			{
				blobId: `sha256-${"a".repeat(64)}`,
				blobGateway: "test-host",
				filename: "shot.png",
				mime: "image/png",
				size: 3,
			},
		];

		const listed = await json(await taskBoard(request(), { from: "recipe-app", ...boardRequestBody("list") }));
		const attachments = await json(
			await taskBoard(request(), { from: "recipe-app", ...boardRequestBody("attachments", { id: created.id }) }),
		);

		const parsedList = z
			.object({ entries: z.array(BoardEntrySchema.omit({ attachments: true })) })
			.safeParse(listed);
		const parsedAttachments = BoardAttachmentSchema.array().safeParse(
			(attachments as { attachments: unknown[] }).attachments,
		);
		expect(parsedList.success, parsedList.success ? "" : parsedList.error.message).toBe(true);
		expect(parsedAttachments.success).toBe(true);
		expect(JSON.stringify(listed)).not.toContain("blobId");
		expect(JSON.stringify(listed)).not.toContain("blobGateway");
		expect(attachments).toEqual({ attachments: entries[0].attachments });
	});

	it("attributes a valid write to the token session and refuses a forged session", async () => {
		const entries: BoardEntry[] = [];
		const sessionStore = new SessionStore();
		const recordA = sessionStore.mint({ spawn: "recipe-app" });
		const recordB = sessionStore.mint({ spawn: "other-app" });
		const tokenA = sessionStore.ensureBindToken(recordA);
		const tokenB = sessionStore.ensureBindToken(recordB);
		sessionStore.activateBinding(recordA);
		sessionStore.activateBinding(recordB);
		const ctx = makeCtx({
			boardClient: boardClient(entries),
			sessionStore,
			carryOver: createRoutesCarryOver(),
		});
		const { taskBoard } = createRoutes(ctx);
		const sessionA = sessionStore.teamOf(recordA);
		const sessionB = sessionStore.teamOf(recordB);
		const create = boardRequestBody("create", { title: "Owned by A", assignTo: "self" });

		const owned = await json(await taskBoard(request(tokenA), { from: sessionA, ...create }));
		const forged = await json(await taskBoard(request(tokenA), { from: sessionB, ...create }));
		const asA = await json(await taskBoard(request(tokenA), { from: sessionA, ...boardRequestBody("list") }));
		const asB = await json(await taskBoard(request(tokenB), { from: sessionB, ...boardRequestBody("list") }));

		expect(owned).toMatchObject({ applied: true });
		expect((asA as { entries: BoardEntry[] }).entries).toHaveLength(1);
		expect((asA as { entries: BoardEntry[] }).entries[0].sessionId).toBe(sessionA);
		expect(forged).toMatchObject({ error: "sender is not this caller's session" });
		expect((asB as { entries: BoardEntry[] }).entries).toEqual([]);
	});
});
