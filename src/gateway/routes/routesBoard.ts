import { type BoardActor, mayWrite, visibleTo } from "../../shared/board-authority.js";
import {
	type BoardReply,
	boardEntryIdForOperation,
	MAX_ENTRIES_PER_OWNER,
	MAX_PROJECTION_BYTES,
	prunableSubtrees,
	subtreeIds,
} from "../../shared/board-structure.js";
import { capFifo } from "../../shared/cap-fifo.js";
import type { BoardEntry } from "../../shared/console-protocol.js";
import type { DurableOpStore } from "../console/durableOpStore.js";
import type { BoardView, BoardWriteAnswer, ClearBoardOp, createBoardClient } from "../router/boardClient.js";
import { type AgentBoardEntry, BoardRouteRequestSchema, jsonResponse, MAX_BOARD_REPLIES } from "../routeSchemas.js";
import type { SessionAuthority } from "../sessionAuthority.js";
import type { CallerScope } from "./callerGuards.js";

const replayKeyOf = (action: string, operationId: string) => `${action}:${operationId}`;

/** Attachments expose filenames, never bearer blob ids. */
function projectForAgent(entry: BoardEntry): AgentBoardEntry {
	if (!entry.attachments) return entry;
	const attachments = entry.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size }));
	return { ...entry, attachments };
}

function liveSubtree(view: BoardView, rootId: string): BoardEntry[] {
	return subtreeIds(view.entries, rootId)
		.map((id) => view.entry(id))
		.filter((entry): entry is BoardEntry => entry !== undefined && entry.trashedAt === undefined);
}

function cutToBudget(entries: BoardEntry[]): { entries: BoardEntry[]; truncated: boolean } {
	let bytes = 0;
	for (let i = 0; i < entries.length; i++) {
		bytes += JSON.stringify(entries[i]).length + 1;
		if (bytes > MAX_PROJECTION_BYTES) return { entries: entries.slice(0, i), truncated: true };
	}
	return { entries, truncated: false };
}

export interface BoardRoutesDeps {
	auth?: SessionAuthority;
	boardClient?: ReturnType<typeof createBoardClient>;
	boardReplays?: DurableOpStore<BoardReply>;
	boardOperationReplies: Map<string, Record<string, unknown>>;
	refuseImpersonation: (req: Request, claimed: string, scope: CallerScope) => Response | null;
}

export function createBoardRoutes({
	auth,
	boardClient,
	boardReplays,
	boardOperationReplies,
	refuseImpersonation,
}: BoardRoutesDeps) {
	const recallBoardReply = (from: string, action: string, operationId: string): BoardReply | undefined => {
		const durable = boardReplays?.get(from, replayKeyOf(action, operationId));
		if (durable?.state === "complete") return durable.result;
		return boardOperationReplies.get(`${from}:${replayKeyOf(action, operationId)}`) as BoardReply | undefined;
	};
	const rememberBoardReply = (from: string, action: string, operationId: string, reply: BoardReply): void => {
		if (boardReplays) {
			boardReplays.markComplete(from, replayKeyOf(action, operationId), reply);
			return;
		}
		boardOperationReplies.set(`${from}:${replayKeyOf(action, operationId)}`, reply);
		capFifo(boardOperationReplies, MAX_BOARD_REPLIES);
	};

	async function taskBoard(req: Request, body: Record<string, unknown>): Promise<Response> {
		const parsed = BoardRouteRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const r = parsed.data;
		const refused = refuseImpersonation(req, r.from, "owner-data");
		if (refused) return refused;
		const recorded = r.operationId ? recallBoardReply(r.from, r.action, r.operationId) : undefined;
		// Replay absolute writes before reading or mutating board state.
		if (recorded) return jsonResponse(recorded);
		if (!boardClient) return jsonResponse({ error: "task board is not enabled on this gateway" }, 503);
		const client = boardClient;
		const sessionKey = auth ? auth.localTeamKey(r.from) : r.from;
		if (!sessionKey) return jsonResponse({ error: `invalid session name "${r.from}"` }, 400);
		const actor: BoardActor = { kind: "session", sessionId: sessionKey };

		const done = (bodyOut: BoardReply): Response => {
			if (r.operationId) rememberBoardReply(r.from, r.action, r.operationId, bodyOut);
			return jsonResponse(bodyOut);
		};

		const answer = (result: BoardWriteAnswer, extra?: Record<string, unknown>): Response => {
			// Transport failures stay retryable and are never recorded.
			if (result.kind === "unavailable") return jsonResponse({ error: result.error }, 503);
			if (result.kind === "refused") return done({ applied: false, refused: result.refused });
			const cascaded = result.kind === "applied" ? result.cascaded : [];
			return done({ applied: true, ...extra, ...(cascaded.length > 0 ? { cascaded } : {}) });
		};

		switch (r.action) {
			case "list": {
				const scope = r.scope ?? "all";
				const board = await client.read();
				if (board.kind !== "ok") return jsonResponse({ error: board.error }, 503);
				const visible = board.entries
					.filter((e) => {
						if (!visibleTo(e, sessionKey)) return false;
						if (scope === "unclaimed") return e.sessionId === undefined;
						if (scope === "session") return e.sessionId === sessionKey;
						return true;
					})
					.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
				const cut = cutToBudget(visible);
				return jsonResponse({
					entries: cut.entries.map(projectForAgent),
					...(cut.truncated ? { truncated: true } : {}),
				});
			}
			case "attachments": {
				if (!r.id) return jsonResponse({ error: "attachments requires an id" }, 400);
				const board = await client.read();
				if (board.kind !== "ok") return jsonResponse({ error: board.error }, 503);
				const entry = board.entries.find((e) => e.id === r.id);
				if (!entry || !visibleTo(entry, sessionKey)) return jsonResponse({ error: "no such entry" }, 404);
				// Attachment reads stay fresh and never enter replay storage.
				return jsonResponse({ attachments: entry.attachments ?? [] });
			}
			case "claim": {
				if (!r.id) return jsonResponse({ error: "claim requires an id" }, 400);
				const id = r.id;
				return answer(
					await client.mutate(
						sessionKey,
						(view) => {
							const target = view.entry(id);
							if (!target || target.trashedAt !== undefined) return "entry_missing";
							const members = liveSubtree(view, id);
							for (const member of members) {
								if (member.sessionId !== undefined && member.sessionId !== sessionKey) return "held";
							}
							const ops = members
								.filter((member) => member.sessionId !== sessionKey)
								.map((member) => ({ kind: "set_session" as const, id: member.id, sessionKey }));
							return ops.length > 0 ? ops : "unchanged";
						},
						r.operationId ? `${r.action}:${r.operationId}` : undefined,
					),
				);
			}
			case "release": {
				if (!r.id) return jsonResponse({ error: "release requires an id" }, 400);
				const id = r.id;
				return answer(
					await client.mutate(
						sessionKey,
						(view) => {
							const target = view.entry(id);
							if (!target) return "entry_missing";
							if (target.sessionId !== undefined && target.sessionId !== sessionKey) return "held";
							const members = liveSubtree(view, id);
							const ops = members
								.filter((member) => member.sessionId === sessionKey)
								.map((member) => ({
									kind: "set_session" as const,
									id: member.id,
									sessionKey: undefined,
								}));
							return ops.length > 0 ? ops : "unchanged";
						},
						r.operationId ? `${r.action}:${r.operationId}` : undefined,
					),
				);
			}
			case "create": {
				if (!r.operationId || !r.title || !r.assignTo) {
					return jsonResponse({ error: "create requires operationId, title, and assignTo" }, 400);
				}
				const id = boardEntryIdForOperation(sessionKey, r.operationId);
				const create = r;
				return answer(
					await client.mutate(
						sessionKey,
						(view) => {
							if (view.entry(id)) return "unchanged";
							if (view.entries.length >= MAX_ENTRIES_PER_OWNER) return "board_full";
							const parent = create.parent ?? undefined;
							if (parent !== undefined) {
								const target = view.entry(parent);
								if (!target) return "parent_missing";
								const denied = mayWrite(target, actor);
								if (denied) return denied;
							}
							const placed = view.placeAtEnd(parent);
							return [
								...placed.rebalanced,
								{
									kind: "upsert" as const,
									id,
									rank: placed.rank,
									title: create.title as string,
									state: "open" as const,
									...(typeof create.body === "string" ? { body: create.body } : {}),
									...(parent === undefined ? {} : { parent }),
									...(create.assignTo === "self" ? { sessionKey } : {}),
								},
							];
						},
						r.operationId ? `${r.action}:${r.operationId}` : undefined,
					),
					{ id },
				);
			}
			case "update": {
				if (!r.id) return jsonResponse({ error: "update requires an id" }, 400);
				const id = r.id;
				const update = r;
				return answer(
					await client.mutate(
						sessionKey,
						(view) => {
							const entry = view.entry(id);
							if (!entry) return "entry_missing";
							const denied = mayWrite(entry, actor);
							if (denied) return denied;
							const ops: ClearBoardOp[] = [];
							if (update.title !== undefined || update.body !== undefined) {
								// Refuse edits when text cannot be decrypted.
								if (!view.textIntact(id))
									return { unavailable: "no content key for this entry's text" };
								const body = update.body === undefined ? entry.body : (update.body ?? undefined);
								ops.push({
									kind: "upsert",
									id,
									rank: entry.rank,
									state: entry.state,
									title: update.title ?? entry.title,
									...(body === undefined ? {} : { body }),
								});
							}
							if (update.state !== undefined) ops.push({ kind: "set_state", id, state: update.state });
							if (update.parent !== undefined) {
								const parent = update.parent === null ? undefined : update.parent;
								if (parent !== entry.parent) {
									// Unchanged parents must not perturb sibling ranks.
									if (parent !== undefined) {
										const target = view.entry(parent);
										if (!target) return "parent_missing";
										const parentDenied = mayWrite(target, actor);
										if (parentDenied) return parentDenied;
									}
									const placed = view.placeAtEnd(parent, id);
									ops.push(...placed.rebalanced, {
										kind: "set_parent",
										id,
										parent,
										rank: placed.rank,
									});
								}
							}
							return ops.length > 0 ? ops : "unchanged";
						},
						r.operationId ? `${r.action}:${r.operationId}` : undefined,
					),
				);
			}
			case "clear": {
				let cleared = 0;
				const result = await client.mutate(
					sessionKey,
					(view) => {
						const entries = new Map(view.entries.map((e) => [e.id, e]));
						const prunable = prunableSubtrees(
							entries,
							(e) => e.sessionId === sessionKey && (e.state === "done" || e.state === "cancelled"),
						);
						cleared = prunable.size;
						return prunable.size > 0
							? [...prunable].map((id) => ({ kind: "trash" as const, id }))
							: "unchanged";
					},
					r.operationId ? `${r.action}:${r.operationId}` : undefined,
				);
				if (result.kind === "unavailable") return jsonResponse({ error: result.error }, 503);
				if (result.kind === "refused") return done({ applied: false, refused: result.refused });
				return done({ applied: true, cleared: result.kind === "applied" ? cleared : 0 });
			}
		}
	}

	return { taskBoard };
}
