import crypto from "node:crypto";
import { z } from "zod";
import { isValidRank, rankBetween, rebalanceRanks } from "../shared/board-rank.js";
import type { BoardEntry } from "../shared/console-protocol.js";
import { type DurableStore, DurableStoreInstalledError } from "../shared/durable-store.js";
import { type PlanePersistedState, type PlaneRegistry, stableHash } from "../shared/plane-registry.js";
import { BoardEntrySchema } from "../shared/schemas.js";

////////////////////////////////
//  Interfaces & Types

export type BoardRefusal =
	| "entry_missing"
	| "parent_missing"
	| "cycle"
	| "held"
	| "would_orphan"
	| "board_full"
	| "bad_rank";

export type BoardResult = { applied: true } | { applied: false; refused: BoardRefusal };

export interface BoardProjection {
	entries: BoardEntry[];
	truncated: boolean;
}

////////////////////////////////
//  Schemas

const OwnerBoardSchema = z.object({
	revision: z.number().int().nonnegative(),
	entries: z.array(BoardEntrySchema),
});

// Restore parses the shell strictly but each ENTRY individually (see restore()), so one bad entry
// cannot take the file with it.
const BoardFileShellSchema = z.object({
	owners: z.record(z.string(), z.object({ revision: z.number().int().nonnegative(), entries: z.array(z.unknown()) })),
});

type OwnerBoard = { revision: number; entries: Map<string, BoardEntry> };

////////////////////////////////
//  Constants

/** Trash retention. Deliberately its OWN constant: SESSION_RESUME_TTL_MS is the same number for an
 * unrelated reason, and the two must never move together. */
export const BOARD_TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Byte budget for one owner's plane projection / board_read reply. The sealed poll frame is
 * hard-capped at 8 MB and an oversized reply fails the WHOLE poll, mail included, so the board
 * degrades (truncated flag) long before it can get near that. */
const MAX_PROJECTION_BYTES = 1_000_000;

/** Per-owner entry cap, same order of magnitude as the other per-owner caps (readAnchors,
 * device-mailbox). A full board refuses new entries rather than evicting old ones. */
const MAX_ENTRIES_PER_OWNER = 5000;

/** The coalescing window for plane bumps: long enough to fold an agent's burst of writes into one
 * snapshot ship, short enough that the owner still sees a breakdown tick live. */
const BUMP_WINDOW_MS = 300;

export function taskBoardPlaneName(ownerId: string): string {
	return `task-board:${ownerId}`;
}

/** The MCP create's entry id, derived from its private per-invocation operation id (the
 * codexAgentIdForOperation pattern), so an HTTP retry upserts the SAME entry instead of doubling. */
export function boardEntryIdForOperation(operationId: string): string {
	const digest = crypto.createHash("sha256").update(`BOARD_ENTRY_V1\n${operationId}`).digest("hex");
	return `bd_${digest.slice(0, 32)}`;
}

////////////////////////////////
//  Class

/**
 * The owner's task board: every entry, assigned or not, on this Gateway. Flat entries with parent
 * pointers; consoles and sessions rebuild the tree.
 *
 * Writes persist synchronously through a checked write into this store's OWN durable file - a
 * trash op the owner watched succeed must survive a crash. The revision is internal only, so no
 * client ever presents or sees one. Refusals are the enumerated list a caller may retire a queued
 * action on; everything else (disk trouble included) is a retryable error.
 */
export class BoardStore {
	private owners = new Map<string, OwnerBoard>();
	private readonly durable: DurableStore;
	private readonly planeRegistry: PlaneRegistry;
	private readonly restoredPlanes: Record<string, PlanePersistedState> | undefined;

	constructor(
		durable: DurableStore,
		planeRegistry: PlaneRegistry,
		restoredPlanes: Record<string, PlanePersistedState> | undefined,
	) {
		this.durable = durable;
		this.planeRegistry = planeRegistry;
		this.restoredPlanes = restoredPlanes;
		this.restore(durable.load());
	}

	/** Per-entry tolerant restore: one invalid entry drops ALONE, loudly, instead of silently
	 * emptying every owner's board and letting the next write overwrite the good file. */
	private restore(raw: unknown): void {
		const shell = BoardFileShellSchema.safeParse(raw);
		if (!shell.success) {
			if (raw !== null)
				console.error("[task-board] durable file unreadable; starting empty:", shell.error.message);
			return;
		}
		for (const [ownerId, board] of Object.entries(shell.data.owners)) {
			const entries = new Map<string, BoardEntry>();
			let dropped = 0;
			for (const rawEntry of board.entries) {
				const entry = BoardEntrySchema.safeParse(rawEntry);
				if (entry.success) entries.set(entry.data.id, entry.data);
				else dropped++;
			}
			// A survivor whose parent was dropped promotes to root, or it would be unreachable from
			// every live root and refuse upserts forever.
			let promoted = 0;
			for (const e of entries.values()) {
				if (e.parent && !entries.has(e.parent)) {
					delete e.parent;
					promoted++;
				}
			}
			if (dropped > 0 || promoted > 0) {
				console.error(
					`[task-board] owner ${ownerId}: dropped ${dropped} invalid entries, promoted ${promoted}`,
				);
			}
			this.owners.set(ownerId, { revision: board.revision, entries });
		}
	}

	/** Register this owner's plane if absent - lazy, idempotent, same shape as ReadAnchors. */
	ensureRegistered(ownerId: string): void {
		const name = taskBoardPlaneName(ownerId);
		if (this.planeRegistry.hasPlane(name)) return;
		this.planeRegistry.registerPlane(
			{
				name,
				snapshot: () => this.projection(ownerId),
				identityOf: (snapshot) => stableHash(snapshot),
			},
			this.restoredPlanes?.[name],
		);
	}

	/** The wire projection: every entry sorted by id (the total order - rank ties would let Map
	 * insertion order into the hash), cut at the byte budget rather than failing the poll. */
	projection(ownerId: string): BoardProjection {
		const board = this.owners.get(ownerId);
		if (!board) return { entries: [], truncated: false };
		const sorted = [...board.entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		let bytes = 0;
		for (let i = 0; i < sorted.length; i++) {
			bytes += JSON.stringify(sorted[i]).length + 1;
			if (bytes > MAX_PROJECTION_BYTES) return { entries: sorted.slice(0, i), truncated: true };
		}
		return { entries: sorted, truncated: false };
	}

	entry(ownerId: string, id: string): BoardEntry | undefined {
		return this.owners.get(ownerId)?.entries.get(id);
	}

	/** Insert-or-replace whole entries (creation, and the write half of a cross-Gateway move). A
	 * parent must exist among the surviving entries or the batch itself. */
	upsert(ownerId: string, entries: readonly BoardEntry[]): BoardResult {
		return this.mutate(ownerId, (board) => {
			const incoming = new Set(entries.map((e) => e.id));
			let added = 0;
			let changed = false;
			for (const e of entries) if (!board.entries.has(e.id)) added++;
			if (board.entries.size + added > MAX_ENTRIES_PER_OWNER) return "board_full";
			for (const e of entries) {
				if (!isValidRank(e.rank)) return "bad_rank";
				if (e.parent && !board.entries.has(e.parent) && !incoming.has(e.parent)) return "parent_missing";
			}
			for (const e of entries) {
				const current = board.entries.get(e.id);
				// Key-order-insensitive compare: the in-place setters can reorder a stored entry's
				// keys, and a value-identical re-send must still gate as unchanged.
				if (!current || stableHash(current) !== stableHash(e)) changed = true;
				board.entries.set(e.id, { ...e });
			}
			for (const e of entries) {
				if (this.wouldCycle(board, e.id)) return "cycle";
			}
			return changed ? undefined : "unchanged";
		});
	}

	setState(ownerId: string, id: string, state: BoardEntry["state"]): BoardResult {
		return this.mutateEntry(ownerId, id, (e) => {
			if (e.state === state) return "unchanged";
			e.state = state;
		});
	}

	setTitle(ownerId: string, id: string, title: string): BoardResult {
		return this.mutateEntry(ownerId, id, (e) => {
			if (e.title === title) return "unchanged";
			e.title = title;
		});
	}

	/** Absent body clears it - the op always sets, never leaves unchanged. */
	setBody(ownerId: string, id: string, body: string | undefined): BoardResult {
		return this.mutateEntry(ownerId, id, (e) => {
			if (e.body === body) return "unchanged";
			if (body === undefined) delete e.body;
			else e.body = body;
		});
	}

	/** One placement intent: parent and rank land together. Absent parent means root. */
	setParent(ownerId: string, id: string, parent: string | undefined, rank: string): BoardResult {
		return this.mutate(ownerId, (board) => {
			const entry = board.entries.get(id);
			if (!entry) return "entry_missing";
			if (!isValidRank(rank)) return "bad_rank";
			if (parent !== undefined && !board.entries.has(parent)) return "parent_missing";
			if (entry.parent === parent && entry.rank === rank) return "unchanged";
			if (parent === undefined) delete entry.parent;
			else entry.parent = parent;
			entry.rank = rank;
			return this.wouldCycle(board, id) ? "cycle" : undefined;
		});
	}

	/** Trash or restore an entry AND its subtree - a flag, never a removal. The stamp is this
	 * gateway's clock, since the sweep runs against it. */
	setTrashed(ownerId: string, id: string, trashed: boolean, now = Date.now()): BoardResult {
		return this.mutate(ownerId, (board) => {
			if (!board.entries.has(id)) return "entry_missing";
			let changed = false;
			for (const memberId of this.subtree(board, id)) {
				const e = board.entries.get(memberId);
				if (!e) continue;
				if (trashed && e.trashedAt === undefined) {
					e.trashedAt = now;
					changed = true;
				} else if (!trashed && e.trashedAt !== undefined) {
					delete e.trashedAt;
					changed = true;
				}
			}
			return changed ? undefined : "unchanged";
		});
	}

	/** Assign or unassign an entry and its subtree. Owner-authority: any entry, any session - the
	 * session-scoped paths are claim/release below, which never override another session. */
	setSession(ownerId: string, id: string, sessionId: string | undefined): BoardResult {
		return this.mutate(ownerId, (board) => {
			if (!board.entries.has(id)) return "entry_missing";
			let changed = false;
			for (const memberId of this.subtree(board, id)) {
				const e = board.entries.get(memberId);
				if (!e || e.sessionId === sessionId) continue;
				if (sessionId === undefined) delete e.sessionId;
				else e.sessionId = sessionId;
				changed = true;
			}
			return changed ? undefined : "unchanged";
		});
	}

	/** A session takes an unassigned entry and its subtree. Succeeds when every member is unassigned
	 * or already this session's (a lost-reply retry is a no-op); refuses when ANOTHER session holds
	 * the entry or any member - claiming an ancestor must never seize a sibling session's work. */
	claim(ownerId: string, id: string, sessionId: string): BoardResult {
		return this.mutate(ownerId, (board) => {
			if (!board.entries.has(id)) return "entry_missing";
			let changed = false;
			const members = this.subtree(board, id);
			for (const memberId of members) {
				const holder = board.entries.get(memberId)?.sessionId;
				if (holder !== undefined && holder !== sessionId) return "held";
			}
			for (const memberId of members) {
				const e = board.entries.get(memberId);
				if (!e || e.sessionId === sessionId) continue;
				e.sessionId = sessionId;
				changed = true;
			}
			return changed ? undefined : "unchanged";
		});
	}

	/** A session hands back what it holds within the entry's subtree - only ITS members unassign, so
	 * releasing a shared ancestor never dumps a sibling session's work to the pile. Already-released
	 * applies as a no-op; an entry held by another session refuses. */
	release(ownerId: string, id: string, sessionId: string): BoardResult {
		return this.mutate(ownerId, (board) => {
			const entry = board.entries.get(id);
			if (!entry) return "entry_missing";
			if (entry.sessionId !== undefined && entry.sessionId !== sessionId) return "held";
			let changed = false;
			for (const memberId of this.subtree(board, id)) {
				const e = board.entries.get(memberId);
				if (!e || e.sessionId !== sessionId) continue;
				delete e.sessionId;
				changed = true;
			}
			return changed ? undefined : "unchanged";
		});
	}

	/** Trash a session's done and cancelled entries (taskBoardClear). Returns how many. */
	clearDone(ownerId: string, sessionId: string, now = Date.now()): number {
		let cleared = 0;
		this.mutate(ownerId, (board) => {
			for (const e of board.entries.values()) {
				if (e.sessionId !== sessionId || e.trashedAt !== undefined) continue;
				if (e.state !== "done" && e.state !== "cancelled") continue;
				e.trashedAt = now;
				cleared++;
			}
			return cleared > 0 ? undefined : "unchanged";
		});
		return cleared;
	}

	/** The rank a fresh entry takes at the end of `parent`'s live siblings. Walks the FULL entry
	 * set (never the byte-truncated projection), and REBALANCES the sibling group when the mint
	 * would breach the rank bound - an oversized rank stored once would poison the file against
	 * the wire schema on every later read. */
	endRank(ownerId: string, parent: string | undefined): string {
		const board = this.owners.get(ownerId);
		const siblings = board
			? [...board.entries.values()].filter((e) => e.parent === parent && e.trashedAt === undefined)
			: [];
		let last: string | undefined;
		for (const e of siblings) if (last === undefined || e.rank > last) last = e.rank;
		const minted = rankBetween(last, undefined);
		if (isValidRank(minted)) return minted;
		siblings.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
		const fresh = rebalanceRanks(siblings.length);
		const tail = rankBetween(fresh[fresh.length - 1], undefined);
		// rebalanceRanks asserts its own output, so this is a last line against a future regression
		// re-poisoning the file - the exact failure this method exists to prevent.
		if (!fresh.every(isValidRank) || !isValidRank(tail)) throw new Error("rank rebalance produced invalid ranks");
		this.mutate(ownerId, (copy) => {
			for (let i = 0; i < siblings.length; i++) {
				const e = copy.entries.get(siblings[i].id);
				if (e) e.rank = fresh[i];
			}
			return undefined;
		});
		return tail;
	}

	/** TRUE removal, the delete half of a cross-Gateway move only. Literal ids: a survivor whose
	 * parent is being removed refuses the batch, so a caller must ship the whole subtree. */
	remove(ownerId: string, ids: readonly string[]): BoardResult {
		return this.mutate(ownerId, (board) => {
			const removing = new Set(ids);
			for (const e of board.entries.values()) {
				if (!removing.has(e.id) && e.parent && removing.has(e.parent)) return "would_orphan";
			}
			for (const id of ids) board.entries.delete(id);
			return undefined;
		});
	}

	/** A session ended, by sweep or by forget - one behavior: done and cancelled are trashed (30
	 * recoverable days), everything else returns to the pile. The console's forget prompt sends its
	 * choices as ordinary ops BEFORE the forget, so no mode flag exists here. */
	sessionEnded(sessionKey: string, now = Date.now()): void {
		for (const ownerId of [...this.owners.keys()]) {
			this.mutate(ownerId, (board) => {
				let touched = false;
				for (const e of board.entries.values()) {
					if (e.sessionId !== sessionKey) continue;
					if ((e.state === "done" || e.state === "cancelled") && e.trashedAt === undefined) e.trashedAt = now;
					delete e.sessionId;
					touched = true;
				}
				return touched ? undefined : "unchanged";
			});
		}
	}

	/** Drop entries trashed longer than the retention window; a survivor whose parent was swept is
	 * promoted to root rather than orphaned. */
	sweepTrash(now = Date.now()): void {
		for (const ownerId of [...this.owners.keys()]) {
			this.mutate(ownerId, (board) => {
				const dead: string[] = [];
				for (const e of board.entries.values()) {
					if (e.trashedAt !== undefined && now - e.trashedAt > BOARD_TRASH_TTL_MS) dead.push(e.id);
				}
				if (dead.length === 0) return "unchanged";
				for (const id of dead) board.entries.delete(id);
				for (const e of board.entries.values()) {
					if (e.parent && !board.entries.has(e.parent)) delete e.parent;
				}
				return undefined;
			});
		}
	}

	////////////////////////////////
	//  Internals

	/** Every id in the entry's subtree, the entry itself included. */
	private subtree(board: OwnerBoard, rootId: string): string[] {
		const children = new Map<string, string[]>();
		for (const e of board.entries.values()) {
			if (e.parent) {
				const list = children.get(e.parent);
				if (list) list.push(e.id);
				else children.set(e.parent, [e.id]);
			}
		}
		const out: string[] = [];
		const queue = [rootId];
		while (queue.length > 0) {
			const id = queue.pop();
			if (id === undefined) break;
			out.push(id);
			for (const child of children.get(id) ?? []) queue.push(child);
		}
		return out;
	}

	private wouldCycle(board: OwnerBoard, startId: string): boolean {
		const seen = new Set<string>();
		let cur: string | undefined = startId;
		while (cur !== undefined) {
			if (seen.has(cur)) return true;
			seen.add(cur);
			cur = board.entries.get(cur)?.parent;
		}
		return false;
	}

	/** Run one mutation against a WORKING COPY, refuse without side effects, commit through the
	 * checked write on success. Single-threaded by the event loop, so the copy is the isolation.
	 * "unchanged" applies without committing, so a no-op never bumps the plane or hits the disk. */
	private mutate(ownerId: string, fn: (board: OwnerBoard) => BoardRefusal | "unchanged" | undefined): BoardResult {
		const current = this.owners.get(ownerId) ?? { revision: 0, entries: new Map() };
		const copy: OwnerBoard = {
			revision: current.revision,
			entries: new Map([...current.entries].map(([id, e]) => [id, { ...e }])),
		};
		const outcome = fn(copy);
		if (outcome === "unchanged") return { applied: true };
		if (outcome) return { applied: false, refused: outcome };
		this.commit(ownerId, copy);
		return { applied: true };
	}

	private mutateEntry(ownerId: string, id: string, fn: (entry: BoardEntry) => "unchanged" | undefined): BoardResult {
		return this.mutate(ownerId, (board) => {
			const entry = board.entries.get(id);
			if (!entry) return "entry_missing";
			return fn(entry);
		});
	}

	/** Install the new board and write the whole file synchronously. An installed-but-unsynced
	 * write (DurableStoreInstalledError) keeps the state - the bytes reached the final pathname;
	 * any other failure rolls back and rethrows so the caller reports a retryable error, never a
	 * refusal. Every success bumps the owner's plane, coalesced. */
	private commit(ownerId: string, next: OwnerBoard): void {
		const previous = this.owners.get(ownerId);
		next.revision++;
		this.owners.set(ownerId, next);
		try {
			this.durable.saveChecked(this.fileState());
		} catch (error) {
			if (!(error instanceof DurableStoreInstalledError)) {
				if (previous) this.owners.set(ownerId, previous);
				else this.owners.delete(ownerId);
				throw error;
			}
		}
		this.ensureRegistered(ownerId);
		this.planeRegistry.markDirtyCoalesced(taskBoardPlaneName(ownerId), BUMP_WINDOW_MS);
	}

	private fileState(): { owners: Record<string, z.infer<typeof OwnerBoardSchema>> } {
		const owners: Record<string, z.infer<typeof OwnerBoardSchema>> = {};
		for (const [ownerId, board] of this.owners) {
			owners[ownerId] = { revision: board.revision, entries: [...board.entries.values()] };
		}
		return { owners };
	}
}
