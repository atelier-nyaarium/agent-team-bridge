// Sole board crypto and key mapper. The Router holds the board and never sees its text, and only
// this gateway's own sessions have a local key.

import { BOARD_REFUSALS, type BoardRefusal } from "../../shared/board-authority.js";
import type { CascadeChange } from "../../shared/board-cascade.js";
import { isValidRank, placeAtEnd } from "../../shared/board-rank.js";
import type { BoardAttachment, BoardEntry } from "../../shared/console-protocol.js";
import { type BoardTextKind, boardTextAadKind } from "../../shared/content-envelope.js";
import {
	type BoardOp,
	BoardReadResultSchema,
	type BoardStoredEntry,
	BoardWriteResultSchema,
} from "../../shared/schemasBoardState.js";
import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import type { ContentKeyStore } from "../federation/contentKeyStore.js";

/** Clear operations before sealing. */
export type ClearBoardOp =
	| {
			kind: "upsert";
			id: string;
			rank: string;
			title: string;
			state?: BoardEntry["state"];
			parent?: string;
			sessionKey?: string;
			body?: string;
			attachments?: BoardAttachment[];
	  }
	| { kind: "remove"; id: string }
	| { kind: "set_state"; id: string; state: BoardEntry["state"] }
	| { kind: "set_parent"; id: string; parent: string | undefined; rank: string }
	| { kind: "set_rank"; id: string; rank: string }
	| { kind: "set_attachments"; id: string; attachments: BoardAttachment[] }
	| { kind: "set_session"; id: string; sessionKey: string | undefined }
	| { kind: "trash"; id: string }
	| { kind: "restore"; id: string };

export interface BoardView {
	revision: number;
	entries: BoardEntry[];
	entry(id: string): BoardEntry | undefined;
	/** Whether all sealed text opened. */
	textIntact(id: string): boolean;
	/** Live siblings for placement. */
	siblings(parent: string | undefined, exclude?: string): BoardEntry[];
	/** End rank and required rewrites. */
	placeAtEnd(parent: string | undefined, exclude?: string): { rank: string; rebalanced: ClearBoardOp[] };
}

/** Refusals retire writes. Unavailability does not. */
export type BoardMutation = (view: BoardView) => ClearBoardOp[] | BoardRefusal | "unchanged" | { unavailable: string };

export type BoardReadAnswer =
	| { kind: "ok"; revision: number; entries: BoardEntry[] }
	| { kind: "unavailable"; error: string };

export type BoardWriteAnswer =
	| { kind: "applied"; revision: number; entries: BoardEntry[]; cascaded: CascadeChange[] }
	| { kind: "refused"; refused: BoardRefusal }
	| { kind: "unchanged" }
	| { kind: "unavailable"; error: string };

export interface BoardClientDeps {
	call: (action: string, params: Record<string, unknown>) => Promise<{ error?: string; result?: unknown }>;
	domainId: string;
	gatewayId: string;
	ownerSignPub: () => string | null;
	keys: Pick<ContentKeyStore, "seal" | "open">;
	/** Maximum CAS rounds. */
	attempts?: number;
}

/** Placeholder for unopened text. */
const UNOPENED = "[unavailable]";

const REFUSALS = new Set<string>(BOARD_REFUSALS);

/** An unknown refusal is a version skew, not a missing entry, and must not read as one. */
const asRefusal = (value: unknown): BoardRefusal =>
	typeof value === "string" && REFUSALS.has(value) ? (value as BoardRefusal) : "durability_failure";

export function createBoardClient(deps: BoardClientDeps) {
	const attempts = deps.attempts ?? 4;

	const sealText = (text: string, kind: BoardTextKind, entryId: string): ContentEnvelope | null => {
		const ownerSignPub = deps.ownerSignPub();
		if (!ownerSignPub) return null;
		const sealed = deps.keys.seal(Buffer.from(text, "utf8"), {
			domainId: deps.domainId,
			ownerSignPub,
			kind: boardTextAadKind(kind, entryId),
		});
		return sealed.kind === "ok" ? sealed.envelope : null;
	};

	const openText = (envelope: ContentEnvelope | undefined, kind: BoardTextKind, entryId: string): string | null => {
		const ownerSignPub = deps.ownerSignPub();
		if (!envelope || !ownerSignPub) return null;
		const opened = deps.keys.open(envelope, {
			domainId: deps.domainId,
			ownerSignPub,
			epoch: envelope.epoch,
			kind: boardTextAadKind(kind, entryId),
		});
		return opened.kind === "ok" ? opened.plaintext.toString("utf8") : null;
	};

	/** Maps a local key to a Router triple. */
	const triple = (sessionKey: string) => ({
		domainId: deps.domainId,
		gatewayId: deps.gatewayId,
		sessionId: sessionKey,
	});
	/** Maps own sessions locally and others opaquely. */
	const localKey = (session: { domainId: string; gatewayId: string; sessionId: string } | undefined) => {
		if (!session) return undefined;
		if (session.domainId === deps.domainId && session.gatewayId === deps.gatewayId) return session.sessionId;
		return `${session.domainId}/${session.gatewayId}/${session.sessionId}`;
	};

	/** Tracks unreadable text so edits cannot write placeholders. */
	function openWhole(stored: BoardStoredEntry): { entry: BoardEntry; intact: boolean } {
		let intact = true;
		const names = stored.sealed.names ?? {};
		const id = stored.clear.id;
		const attachments = (stored.clear.attachments ?? []).map((a) => {
			const filename = openText(names[a.blobId], "board.name", `${id}\n${a.blobId}`);
			if (filename === null) intact = false;
			return { ...a, filename: filename ?? UNOPENED };
		});
		const body = openText(stored.sealed.body, "board.body", id);
		if (stored.sealed.body && body === null) intact = false;
		const title = openText(stored.sealed.title, "board.title", id);
		if (title === null) intact = false;
		return { entry: entryOf(stored, title ?? UNOPENED, body, attachments), intact };
	}

	function openEntry(stored: BoardStoredEntry): BoardEntry {
		return openWhole(stored).entry;
	}

	function entryOf(
		stored: BoardStoredEntry,
		title: string,
		body: string | null,
		attachments: BoardAttachment[],
	): BoardEntry {
		return {
			id: stored.clear.id,
			title,
			state: stored.clear.state,
			rank: stored.clear.rank,
			...(stored.clear.parent ? { parent: stored.clear.parent } : {}),
			...(localKey(stored.clear.session) ? { sessionId: localKey(stored.clear.session) } : {}),
			...(stored.clear.session ? { session: stored.clear.session } : {}),
			...(stored.clear.trashedAt === undefined ? {} : { trashedAt: stored.clear.trashedAt }),
			...(body === null ? {} : { body }),
			...(attachments.length > 0 ? { attachments } : {}),
		};
	}

	/** Null when sealing fails. */
	function sealOp(op: ClearBoardOp): BoardOp | null {
		if (op.kind === "upsert") {
			const title = sealText(op.title, "board.title", op.id);
			if (!title) return null;
			const body = op.body === undefined ? undefined : sealText(op.body, "board.body", op.id);
			if (op.body !== undefined && !body) return null;
			const names: Record<string, ContentEnvelope> = {};
			for (const a of op.attachments ?? []) {
				const name = sealText(a.filename, "board.name", `${op.id}\n${a.blobId}`);
				if (!name) return null;
				names[a.blobId] = name;
			}
			return {
				kind: "upsert",
				id: op.id,
				rank: op.rank,
				title,
				...(op.state ? { state: op.state } : { state: "open" as const }),
				...(op.parent ? { parent: op.parent } : {}),
				...(op.sessionKey ? { session: triple(op.sessionKey) } : {}),
				...(body ? { body } : {}),
				...(op.attachments ? { attachments: op.attachments.map(clearAttachment) } : {}),
				...(Object.keys(names).length > 0 ? { names } : {}),
			};
		}
		if (op.kind === "set_attachments") {
			// The Router keeps the stored names, keyed by blobId, so a new blobId lands unnamed.
			return { kind: "set_attachments", id: op.id, attachments: op.attachments.map(clearAttachment) };
		}
		if (op.kind === "set_session")
			return { kind: "set_session", id: op.id, ...(op.sessionKey ? { session: triple(op.sessionKey) } : {}) };
		if (op.kind === "set_parent")
			return { kind: "set_parent", id: op.id, rank: op.rank, ...(op.parent ? { parent: op.parent } : {}) };
		return op;
	}

	function viewOf(revision: number, entries: BoardEntry[], damaged: Set<string>): BoardView {
		const byId = new Map(entries.map((e) => [e.id, e]));
		const siblings = (parent: string | undefined, exclude?: string) =>
			entries.filter((e) => e.parent === parent && e.trashedAt === undefined && e.id !== exclude);
		return {
			revision,
			entries,
			entry: (id) => byId.get(id),
			textIntact: (id) => !damaged.has(id),
			siblings,
			placeAtEnd: (parent, exclude) => {
				const placed = placeAtEnd(siblings(parent, exclude));
				return {
					rank: placed.rank,
					rebalanced: placed.rebalanced.map((r) => ({ kind: "set_rank" as const, id: r.id, rank: r.rank })),
				};
			},
		};
	}

	/** Opens entries and records damaged text. */
	function fold(stored: BoardStoredEntry[]): { entries: BoardEntry[]; damaged: Set<string> } {
		const entries: BoardEntry[] = [];
		const damaged = new Set<string>();
		for (const record of stored) {
			const opened = openWhole(record);
			entries.push(opened.entry);
			if (!opened.intact) damaged.add(opened.entry.id);
		}
		return { entries, damaged };
	}

	/** Reads the board and damaged entries. */
	async function readFolded(): Promise<
		| { kind: "ok"; revision: number; entries: BoardEntry[]; damaged: Set<string> }
		| { kind: "unavailable"; error: string }
	> {
		const answer = await deps.call("board_read", {});
		if (answer.error) return { kind: "unavailable", error: answer.error };
		const parsed = BoardReadResultSchema.safeParse(answer.result);
		if (!parsed.success) return { kind: "unavailable", error: "malformed board_read answer" };
		return { kind: "ok", revision: parsed.data.revision, ...fold(parsed.data.entries) };
	}

	async function read(): Promise<BoardReadAnswer> {
		const answer = await readFolded();
		if (answer.kind !== "ok") return answer;
		return { kind: "ok", revision: answer.revision, entries: answer.entries };
	}

	async function mutate(sessionKey: string, mutation: BoardMutation, opId?: string): Promise<BoardWriteAnswer> {
		const first = await readFolded();
		if (first.kind !== "ok") return first;
		let revision = first.revision;
		let entries = first.entries;
		let damaged = first.damaged;
		for (let attempt = 0; attempt < attempts; attempt++) {
			const built = mutation(viewOf(revision, entries, damaged));
			if (built === "unchanged") return { kind: "unchanged" };
			if (typeof built === "object" && !Array.isArray(built))
				return { kind: "unavailable", error: built.unavailable };
			if (!Array.isArray(built)) return { kind: "refused", refused: built };
			if (built.length === 0) return { kind: "unchanged" };
			for (const op of built)
				if ("rank" in op && op.rank !== undefined && !isValidRank(op.rank))
					return { kind: "refused", refused: "bad_rank" };
			const ops: BoardOp[] = [];
			for (const op of built) {
				const sealed = sealOp(op);
				if (!sealed) return { kind: "unavailable", error: "no content key for this Domain" };
				ops.push(sealed);
			}
			const answer = await deps.call("board_op", {
				sessionId: sessionKey,
				...(opId ? { opId } : {}),
				write: { ops, expectedRevision: revision },
			});
			if (answer.error) return { kind: "unavailable", error: answer.error };
			const parsed = BoardWriteResultSchema.safeParse(answer.result);
			if (!parsed.success) return { kind: "unavailable", error: "malformed board_op answer" };
			const result = parsed.data;
			const folded = fold(result.entries);
			if (result.outcome === "applied") {
				const titles = new Map(folded.entries.map((e) => [e.id, e.title]));
				return {
					kind: "applied",
					revision: result.revision,
					entries: folded.entries,
					// Cascades omit clear titles at the Router.
					cascaded: result.cascaded.map((c) => ({
						...(c as CascadeChange),
						title: titles.get(c.id) ?? UNOPENED,
					})),
				};
			}
			if (result.outcome === "refused") return { kind: "refused", refused: asRefusal(result.refusal) };
			// Rebuild conflicts from the returned board.
			revision = result.revision;
			entries = folded.entries;
			damaged = folded.damaged;
		}
		return { kind: "unavailable", error: "board is busy" };
	}

	return { read, mutate, openEntry };
}

const clearAttachment = ({ blobId, size, mime, blobGateway }: BoardAttachment) => ({
	blobId,
	size,
	mime,
	blobGateway,
});
