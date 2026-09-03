import { z } from "zod";
import type { AwarenessObservation } from "../shared/awareness-types.js";
import {
	type BoardActor,
	type BoardDisposition,
	type BoardRefusal,
	type BoardResult,
	mayWrite,
	OWNER_ACTOR,
} from "../shared/board-authority.js";
import { applyCascade } from "../shared/board-cascade.js";
import { observationsFor } from "../shared/board-observations.js";
import { isValidRank, rankBetween, rebalanceRanks } from "../shared/board-rank.js";
import {
	BOARD_TRASH_TTL_MS,
	MAX_ENTRIES_PER_OWNER,
	MAX_PROJECTION_BYTES,
	orphanedParents,
	promoteOrphans,
	prunableSubtrees,
	taskBoardPlaneName,
} from "../shared/board-structure.js";
import type { BoardAttachment, BoardEntry } from "../shared/console-protocol.js";
import { type DurableStore, DurableStoreInstalledError } from "../shared/durable-store.js";
import { fenced } from "../shared/migration-fence.js";
import { type PlanePersistedState, type PlaneRegistry, stableHash } from "../shared/plane-registry.js";
import { BoardEntrySchema } from "../shared/schemas.js";

export type { BoardActor, BoardDisposition, BoardRefusal, BoardResult } from "../shared/board-authority.js";
export { BOARD_REFUSED_PREFIX, mayWrite, OWNER_ACTOR, refusalError, visibleTo } from "../shared/board-authority.js";

/** Attachment reclamation sink. */
export interface BoardAttachmentSink {
	released(ownerId: string, entryId: string, blobIds: readonly string[]): void;
	releasedAll(ownerId: string, entryId: string): void;
}

export interface BoardProjection {
	entries: BoardEntry[];
	truncated: boolean;
}

const OwnerBoardSchema = z.object({
	revision: z.number().int().nonnegative(),
	entries: z.array(BoardEntrySchema),
});

const BoardFileShellSchema = z.object({
	owners: z.record(z.string(), z.object({ revision: z.number().int().nonnegative(), entries: z.array(z.unknown()) })),
});

type OwnerBoard = { revision: number; entries: Map<string, BoardEntry> };

/** Coalesced plane-bump window. */
const BUMP_WINDOW_MS = 300;

/** Durable owner task board. */
export class BoardStore {
	private owners = new Map<string, OwnerBoard>();
	private readonly durable: DurableStore;
	private readonly planeRegistry: PlaneRegistry;
	private readonly restoredPlanes: Record<string, PlanePersistedState> | undefined;
	private readonly onObservations: ((observations: readonly AwarenessObservation<BoardEntry>[]) => void) | undefined;
	private readonly attachmentSink: BoardAttachmentSink | undefined;

	constructor(
		durable: DurableStore,
		planeRegistry: PlaneRegistry,
		restoredPlanes: Record<string, PlanePersistedState> | undefined,
		onObservations?: (observations: readonly AwarenessObservation<BoardEntry>[]) => void,
		attachmentSink?: BoardAttachmentSink,
	) {
		this.durable = durable;
		this.planeRegistry = planeRegistry;
		this.restoredPlanes = restoredPlanes;
		this.onObservations = onObservations;
		this.attachmentSink = attachmentSink;
		this.restore(durable.load());
	}

	/** Restore entries independently. */
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
			// Promote orphaned survivors.
			const promoted = promoteOrphans(entries);
			if (dropped > 0 || promoted > 0) {
				console.error(
					`[task-board] owner ${ownerId}: dropped ${dropped} invalid entries, promoted ${promoted}`,
				);
			}
			this.owners.set(ownerId, { revision: board.revision, entries });
		}
	}

	/** Register the owner plane. */
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

	/** Return the bounded wire projection. */
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

	ownerIds(): string[] {
		return [...this.owners.keys()];
	}

	/** Return the complete board. */
	allEntries(ownerId: string): BoardEntry[] {
		return [...(this.owners.get(ownerId)?.entries.values() ?? [])];
	}

	/** Insert or replace entries. */
	upsert(ownerId: string, entries: readonly BoardEntry[], actor: BoardActor): BoardResult {
		return this.mutate(
			ownerId,
			actor,
			(board, touch) => {
				const incoming = new Set(entries.map((e) => e.id));
				let added = 0;
				let changed = false;
				for (const e of entries) if (!board.entries.has(e.id)) added++;
				if (board.entries.size + added > MAX_ENTRIES_PER_OWNER) return "board_full";
				for (const e of entries) {
					if (!isValidRank(e.rank)) return "bad_rank";
					if (e.parent && !board.entries.has(e.parent) && !incoming.has(e.parent)) return "parent_missing";
					const current = board.entries.get(e.id);
					if (current) {
						const denied = mayWrite(current, actor);
						if (denied) return denied;
					}
					const existingParent =
						e.parent && !incoming.has(e.parent) ? board.entries.get(e.parent) : undefined;
					if (existingParent) {
						const denied = mayWrite(existingParent, actor);
						if (denied) return denied;
					}
				}
				for (const e of entries) {
					const current = board.entries.get(e.id);
					// Attachments commit through setAttachments.
					const merged = { ...e };
					delete merged.attachments;
					if (current?.attachments) merged.attachments = current.attachments;
					if (!current || stableHash(current) !== stableHash(merged)) {
						changed = true;
						touch(e.id);
					}
					board.entries.set(e.id, merged);
				}
				for (const e of entries) {
					if (this.wouldCycle(board, e.id)) return "cycle";
				}
				return changed ? undefined : "unchanged";
			},
			true,
		);
	}

	setState(ownerId: string, id: string, state: BoardEntry["state"], actor: BoardActor): BoardResult {
		return this.mutateEntry(
			ownerId,
			id,
			actor,
			(e) => {
				if (e.state === state) return "unchanged";
				e.state = state;
			},
			true,
		);
	}

	setTitle(ownerId: string, id: string, title: string, actor: BoardActor): BoardResult {
		return this.mutateEntry(ownerId, id, actor, (e) => {
			if (e.title === title) return "unchanged";
			e.title = title;
		});
	}

	setBody(ownerId: string, id: string, body: string | undefined, actor: BoardActor): BoardResult {
		return this.mutateEntry(ownerId, id, actor, (e) => {
			if (e.body === body) return "unchanged";
			if (body === undefined) delete e.body;
			else e.body = body;
		});
	}

	/** Sole attachment committer. */
	setAttachments(
		ownerId: string,
		id: string,
		attachments: readonly BoardAttachment[],
		actor: BoardActor,
	): BoardResult {
		const next = [...attachments].sort((a, b) => (a.blobId < b.blobId ? -1 : a.blobId > b.blobId ? 1 : 0));
		let released: string[] = [];
		const result = this.mutateEntry(ownerId, id, actor, (e) => {
			const before = e.attachments ?? [];
			if (stableHash(before) === stableHash(next)) return "unchanged";
			const incoming = new Set(next.map((a) => a.blobId));
			released = before.filter((a) => !incoming.has(a.blobId)).map((a) => a.blobId);
			if (next.length === 0) delete e.attachments;
			else e.attachments = next;
		});
		// Reclaim after commit.
		if (result.applied && released.length > 0) this.attachmentSink?.released(ownerId, id, released);
		return result;
	}

	/** Set parent and rank together. */
	setParent(ownerId: string, id: string, parent: string | undefined, rank: string, actor: BoardActor): BoardResult {
		return this.mutate(
			ownerId,
			actor,
			(board, touch) => {
				const entry = board.entries.get(id);
				if (!entry) return "entry_missing";
				const denied = mayWrite(entry, actor);
				if (denied) return denied;
				if (!isValidRank(rank)) return "bad_rank";
				if (parent !== undefined && !board.entries.has(parent)) return "parent_missing";
				if (parent !== undefined) {
					const deniedParent = mayWrite(board.entries.get(parent) as BoardEntry, actor);
					if (deniedParent) return deniedParent;
				}
				if (entry.parent === parent && entry.rank === rank) return "unchanged";
				if (entry.parent !== parent) touch(id);
				if (parent === undefined) delete entry.parent;
				else entry.parent = parent;
				entry.rank = rank;
				return this.wouldCycle(board, id) ? "cycle" : undefined;
			},
			true,
		);
	}

	/** Trash or restore a subtree. */
	setTrashed(ownerId: string, id: string, trashed: boolean, now = Date.now()): BoardResult {
		return this.mutate(
			ownerId,
			OWNER_ACTOR,
			(board, touch) => {
				if (!board.entries.has(id)) return "entry_missing";
				let changed = false;
				for (const memberId of this.subtree(board, id)) {
					const e = board.entries.get(memberId);
					if (!e) continue;
					if (trashed && e.trashedAt === undefined) {
						e.trashedAt = now;
						changed = true;
						touch(memberId);
					} else if (!trashed && e.trashedAt !== undefined) {
						delete e.trashedAt;
						changed = true;
						touch(memberId);
					}
				}
				return changed ? undefined : "unchanged";
			},
			true,
		);
	}

	/** Assign or unassign a subtree. */
	setSession(ownerId: string, id: string, sessionId: string | undefined): BoardResult {
		return this.mutate(ownerId, OWNER_ACTOR, (board, touch) => {
			if (!board.entries.has(id)) return "entry_missing";
			let changed = false;
			for (const memberId of this.subtree(board, id)) {
				const e = board.entries.get(memberId);
				if (!e || e.sessionId === sessionId) continue;
				if (sessionId === undefined) delete e.sessionId;
				else e.sessionId = sessionId;
				changed = true;
				touch(memberId);
			}
			return changed ? undefined : "unchanged";
		});
	}

	/** Claim an unassigned subtree. */
	claim(ownerId: string, id: string, sessionId: string): BoardResult {
		return this.mutate(ownerId, { kind: "session", sessionId }, (board, touch) => {
			const target = board.entries.get(id);
			if (!target) return "entry_missing";
			// Sessions cannot claim trash.
			if (target.trashedAt !== undefined) return "entry_missing";
			let changed = false;
			const members = this.subtree(board, id);
			for (const memberId of members) {
				if (board.entries.get(memberId)?.trashedAt !== undefined) return "entry_missing";
				const holder = board.entries.get(memberId)?.sessionId;
				if (holder !== undefined && holder !== sessionId) return "held";
			}
			for (const memberId of members) {
				const e = board.entries.get(memberId);
				if (!e || e.sessionId === sessionId) continue;
				e.sessionId = sessionId;
				changed = true;
				touch(memberId);
			}
			return changed ? undefined : "unchanged";
		});
	}

	/** Release a session's subtree. */
	release(ownerId: string, id: string, sessionId: string): BoardResult {
		return this.mutate(ownerId, { kind: "session", sessionId }, (board, touch) => {
			const entry = board.entries.get(id);
			if (!entry) return "entry_missing";
			if (entry.sessionId !== undefined && entry.sessionId !== sessionId) return "held";
			let changed = false;
			for (const memberId of this.subtree(board, id)) {
				const e = board.entries.get(memberId);
				if (e?.trashedAt !== undefined) return "entry_missing";
				if (!e || e.sessionId !== sessionId) continue;
				delete e.sessionId;
				changed = true;
				touch(memberId);
			}
			return changed ? undefined : "unchanged";
		});
	}

	/** Trash finished session entries. */
	clearDone(ownerId: string, sessionId: string, now = Date.now()): number {
		let cleared = 0;
		this.mutate(ownerId, { kind: "session", sessionId }, (board, touch) => {
			const prunable = prunableSubtrees(
				board.entries,
				(e) => e.sessionId === sessionId && (e.state === "done" || e.state === "cancelled"),
			);
			for (const id of prunable) {
				const e = board.entries.get(id);
				if (!e) continue;
				e.trashedAt = now;
				touch(id);
				cleared++;
			}
			return cleared > 0 ? undefined : "unchanged";
		});
		return cleared;
	}

	/** Create an entry at a sibling group's end. */
	createAtEnd(ownerId: string, entry: Omit<BoardEntry, "rank">, actor: BoardActor): BoardResult {
		return this.mutate(
			ownerId,
			actor,
			(board, touch) => {
				if (board.entries.has(entry.id)) return "unchanged";
				if (board.entries.size + 1 > MAX_ENTRIES_PER_OWNER) return "board_full";
				if (entry.parent !== undefined) {
					const parent = board.entries.get(entry.parent);
					if (!parent) return "parent_missing";
					const denied = mayWrite(parent, actor);
					if (denied) return denied;
				}
				board.entries.set(entry.id, { ...entry, rank: this.placeAtEnd(board, entry.parent) });
				touch(entry.id);
				return this.wouldCycle(board, entry.id) ? "cycle" : undefined;
			},
			true,
		);
	}

	/** Move an entry to a sibling group's end. */
	setParentAtEnd(ownerId: string, id: string, parent: string | undefined, actor: BoardActor): BoardResult {
		return this.mutate(
			ownerId,
			actor,
			(board, touch) => {
				const entry = board.entries.get(id);
				if (!entry) return "entry_missing";
				const denied = mayWrite(entry, actor);
				if (denied) return denied;
				if (parent !== undefined) {
					const target = board.entries.get(parent);
					if (!target) return "parent_missing";
					const deniedParent = mayWrite(target, actor);
					if (deniedParent) return deniedParent;
				}
				if (entry.parent === parent) return "unchanged";
				if (parent === undefined) delete entry.parent;
				else entry.parent = parent;
				entry.rank = this.placeAtEnd(board, parent, id);
				touch(id);
				return this.wouldCycle(board, id) ? "cycle" : undefined;
			},
			true,
		);
	}

	/** Mint a bounded sibling rank. */
	private placeAtEnd(board: OwnerBoard, parent: string | undefined, exclude?: string): string {
		const siblings = [...board.entries.values()].filter(
			(e) => e.parent === parent && e.trashedAt === undefined && e.id !== exclude,
		);
		let last: string | undefined;
		for (const e of siblings) if (last === undefined || e.rank > last) last = e.rank;
		const minted = rankBetween(last, undefined);
		if (isValidRank(minted)) return minted;
		siblings.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
		const fresh = rebalanceRanks(siblings.length);
		const tail = rankBetween(fresh[fresh.length - 1], undefined);
		if (!fresh.every(isValidRank) || !isValidRank(tail)) throw new Error("rank rebalance produced invalid ranks");
		for (let i = 0; i < siblings.length; i++) {
			const e = board.entries.get(siblings[i].id);
			if (e) e.rank = fresh[i];
		}
		return tail;
	}

	/** Remove entries without reclaiming attachments. */
	remove(ownerId: string, ids: readonly string[]): BoardResult {
		return this.mutate(
			ownerId,
			OWNER_ACTOR,
			(board, touch) => {
				const removing = new Set(ids);
				for (const e of board.entries.values()) {
					if (!removing.has(e.id) && e.parent && removing.has(e.parent)) return "would_orphan";
				}
				for (const id of ids) {
					if (board.entries.delete(id)) touch(id);
				}
				return undefined;
			},
			true,
		);
	}

	/** Apply session end disposition. */
	sessionEnded(sessionKey: string, disposition: BoardDisposition, now = Date.now()): number {
		let count = 0;
		for (const ownerId of [...this.owners.keys()]) {
			this.mutate(ownerId, OWNER_ACTOR, (board) => {
				let touched = false;
				for (const e of board.entries.values()) {
					if (e.sessionId !== sessionKey) continue;
					const finished = e.state === "done" || e.state === "cancelled";
					if (disposition === "cancel" && !finished && e.trashedAt === undefined) e.state = "cancelled";
					touched = true;
					count++;
				}
				const ending = new Set(
					[...board.entries.values()].filter((e) => e.sessionId === sessionKey).map((e) => e.id),
				);
				for (const id of prunableSubtrees(
					board.entries,
					(e) => ending.has(e.id) && (e.state === "done" || e.state === "cancelled"),
				)) {
					const e = board.entries.get(id);
					if (e) e.trashedAt = now;
				}
				for (const e of board.entries.values()) {
					if (ending.has(e.id)) delete e.sessionId;
				}
				return touched ? undefined : "unchanged";
			});
		}
		return count;
	}

	/** Permanently delete expired trash. */
	sweepTrash(now = Date.now()): void {
		for (const ownerId of [...this.owners.keys()]) {
			let swept: string[] = [];
			const result = this.mutate(ownerId, OWNER_ACTOR, (board) => {
				const dead: string[] = [];
				for (const e of board.entries.values()) {
					if (e.trashedAt !== undefined && now - e.trashedAt > BOARD_TRASH_TTL_MS) dead.push(e.id);
				}
				if (dead.length === 0) return "unchanged";
				swept = dead;
				for (const id of dead) board.entries.delete(id);
				promoteOrphans(board.entries);
				return undefined;
			});
			if (result.applied) {
				for (const id of swept) {
					try {
						this.attachmentSink?.releasedAll(ownerId, id);
					} catch (err) {
						console.error(`[task-board] could not reclaim attachments for ${id}:`, err);
					}
				}
			}
		}
	}

	/** Return a subtree's ids. */
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

	/** Mutate an isolated working copy. */
	private mutate(
		ownerId: string,
		writer: BoardActor,
		fn: (board: OwnerBoard, touch: (entryId: string) => void) => BoardRefusal | "unchanged" | undefined,
		cascade = false,
	): BoardResult {
		if (fenced()) return { applied: false, migrating: true };
		const current = this.owners.get(ownerId) ?? { revision: 0, entries: new Map() };
		const copy: OwnerBoard = {
			revision: current.revision,
			entries: new Map([...current.entries].map(([id, e]) => [id, { ...e }])),
		};
		const touched = new Set<string>();
		const outcome = fn(copy, (entryId) => touched.add(entryId));
		if (outcome === "unchanged") return { applied: true };
		if (outcome) return { applied: false, refused: outcome };
		const cascaded = cascade
			? applyCascade(copy.entries, [...touched], orphanedParents(current, copy, touched))
			: [];
		for (const change of cascaded) touched.add(change.id);
		const observations = observationsFor(current, copy, touched, writer);
		this.commit(ownerId, copy);
		if (observations.length > 0) this.announce(observations);
		return cascaded.length > 0 ? { applied: true, cascaded } : { applied: true };
	}

	/** Log post-commit sink failures. */
	private announce(observations: readonly AwarenessObservation<BoardEntry>[]): void {
		try {
			console.error(
				`[task-board] ${observations.length} awareness observation(s): ${observations.map((o) => o.identity).join(" ")}`,
			);
			this.onObservations?.(observations);
		} catch (err) {
			console.error("[task-board] notice sink failed:", err);
		}
	}

	private mutateEntry(
		ownerId: string,
		id: string,
		actor: BoardActor,
		fn: (entry: BoardEntry) => "unchanged" | undefined,
		cascade = false,
	): BoardResult {
		return this.mutate(
			ownerId,
			actor,
			(board, touch) => {
				const entry = board.entries.get(id);
				if (!entry) return "entry_missing";
				const denied = mayWrite(entry, actor);
				if (denied) return denied;
				const outcome = fn(entry);
				if (!outcome) touch(id);
				return outcome;
			},
			cascade,
		);
	}

	/** Install and persist the board. */
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
