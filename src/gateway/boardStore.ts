import crypto from "node:crypto";
import { z } from "zod";
import { isValidRank, rankBetween, rebalanceRanks } from "../shared/board-rank.js";
import type { BoardAttachment, BoardEntry } from "../shared/console-protocol.js";
import { type DurableStore, DurableStoreInstalledError } from "../shared/durable-store.js";
import { type PlanePersistedState, type PlaneRegistry, stableHash } from "../shared/plane-registry.js";
import { BoardEntrySchema } from "../shared/schemas.js";

////////////////////////////////
//  Interfaces & Types

/** Every way a board write can be told it will NEVER apply. This vocabulary is load-bearing: it is
 * the one signal that retires a queued console action, which means it permanently discards the
 * owner's edit. `session_missing` is detectable only at the console edge, but it is a refusal in
 * exactly the same sense, so it lives here rather than as a loose string there. */
export type BoardRefusal =
	| "entry_missing"
	| "parent_missing"
	| "cycle"
	| "held"
	| "would_orphan"
	| "board_full"
	| "bad_rank"
	| "session_missing";

export type BoardResult = { applied: true } | { applied: false; refused: BoardRefusal };

/** What becomes of a session's unfinished entries when it ends. */
export type BoardDisposition = "release" | "cancel";

/** Who is writing. A VALUE every mutating call must supply, never an absence a caller can fall
 * into: omitting a session id used to mean "no scope check", so a route that forgot one wrote
 * unconditionally. The `sessionAuthority.ts` rule, applied to the board. */
export type BoardActor = { kind: "owner" } | { kind: "session"; sessionId: string };

/**
 * Where attachment bytes go when an entry stops naming them. Behind an interface because the store
 * is otherwise free of the filesystem, and the two reclaim sites are the only ones there are:
 * `setAttachments`'s membership diff, and the trash sweep's permanent delete.
 *
 * NOT called from `restore`'s per-entry drop, which is corruption recovery: reclaiming there would
 * turn this store's one tolerant path into its one irrecoverable one. NOT called from `remove`
 * either, whose only caller is the delete half of a cross-Gateway move; leaking a directory per move
 * is the deliberate trade until a move learns to carry its bytes.
 */
export interface BoardAttachmentSink {
	/** Bytes the entry no longer names. */
	released(ownerId: string, entryId: string, blobIds: readonly string[]): void;
	/** Everything the entry held, because the entry itself is gone for good. */
	releasedAll(ownerId: string, entryId: string): void;
}

/** The owner's own authority, for the console (their device) and the sweeps. Named rather than
 * spelled out at each site, so grepping it lists every place owner authority is claimed. */
export const OWNER_ACTOR: BoardActor = { kind: "owner" };

/**
 * May this actor touch this entry? The owner anything; a session only what it holds, and never
 * anything in the trash - that is the owner's own set-aside, and a session's list has already
 * stopped showing it.
 *
 * The SAME rule answers the entry being written and any parent it is attached to. Nesting was
 * briefly looser, allowing a session to hang work off a BACKLOG entry: that left the entry
 * advertised as unclaimed while `claim`'s subtree rule refused every other session, with nothing in
 * any list explaining why. A session breaking a backlog item down claims it first.
 */
export function mayWrite(entry: BoardEntry, actor: BoardActor): BoardRefusal | undefined {
	if (actor.kind === "owner") return undefined;
	if (entry.trashedAt !== undefined) return "entry_missing";
	return entry.sessionId === actor.sessionId ? undefined : "held";
}

/** Whether a session's own default list would return this entry. The ONE owner of that rule: the
 * route filters with it and the notice classifier decides visibility with it, so a change to what a
 * session can see cannot leave the two disagreeing about what it is told. */
export function visibleTo(entry: BoardEntry | undefined, sessionId: string): boolean {
	if (!entry || entry.trashedAt !== undefined) return false;
	return entry.sessionId === undefined || entry.sessionId === sessionId;
}

/** The wire marker the console retires an action on. Declared once, beside the vocabulary it
 * prefixes; a residue test keeps it that way, because any other throw whose message happens to
 * start with it would silently discard an owner's edit. */
export const BOARD_REFUSED_PREFIX = "refused: ";

/** The one way to raise a refusal from a throwing path. */
export function refusalError(refused: BoardRefusal): Error {
	return new Error(`${BOARD_REFUSED_PREFIX}${refused}`);
}

export interface BoardProjection {
	entries: BoardEntry[];
	truncated: boolean;
}

/** What a session is told about a write to board work it holds, or is about to. Everything except an
 * edit carries the TITLE: the id stops resolving once the entry leaves that session's list, and an
 * arrival names work the session may never have seen. An edit does not, since a re-read resolves it. */
export type BoardNotice = { sessionId: string; entryId: string } & (
	| { kind: "changed" }
	// One wording for both an assignment and something coming back out of the trash: a reassign made
	// WHILE trashed leaves the pre-state already naming the new session, so the two are not
	// distinguishable from pre/post alone, and "is yours" is true either way.
	| { kind: "arrived"; title: string }
	| { kind: "backlog"; title: string }
	| { kind: "gone"; title: string; how: "trashed" | "removed" | "reassigned" }
);

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
 * codexAgentIdForOperation pattern), so an HTTP retry upserts the SAME entry instead of doubling.
 *
 * The SENDER is in the preimage because the id alone decides the replay: `createAtEnd` answers
 * "already there" on a matching id without a scope check, which is only sound while an id can come
 * from one caller. `operationId` is an ordinary wire field, so two senders presenting the same one
 * would otherwise converge on one entry and the second be told it created another's. */
export function boardEntryIdForOperation(from: string, operationId: string): string {
	const digest = crypto.createHash("sha256").update(`BOARD_ENTRY_V2\n${from}\n${operationId}`).digest("hex");
	return `bd_${digest.slice(0, 32)}`;
}

/** Whether this session may write the entry, which is also what it means to hold it. */
function holds(entry: BoardEntry | undefined, sessionId: string): boolean {
	return entry !== undefined && mayWrite(entry, { kind: "session", sessionId }) === undefined;
}

/**
 * Promote every entry whose parent is gone, and answer how many. The ONE owner of "no entry points
 * at a parent that is not there", which every consumer relies on: the route's list ships entries flat
 * and receivers rebuild the tree from parent pointers, so a dangling one silently regroups a row.
 *
 * Called after each of the two paths that can delete a parent out from under a survivor - the trash
 * sweep and a tolerant restore. The write paths REFUSE instead (`parent_missing`, `would_orphan`),
 * because a caller that can still fix its own batch should be told rather than quietly corrected.
 */
/**
 * Which entries can be set aside without breaking the tree: those `eligible` accepts whose every live
 * child is also going. A parent whose child survives is KEPT, so no pass can leave a survivor pointing
 * at an entry that is no longer in any list.
 *
 * Eligibility alone is not enough, and that is the whole point: a done parent can easily own a child
 * that is unfinished, or finished but held by another session, and either one has to keep its parent.
 * Bad data with a parent cycle resolves to not-prunable rather than hanging.
 */
function prunableSubtrees(entries: Map<string, BoardEntry>, eligible: (entry: BoardEntry) => boolean): Set<string> {
	const kids = new Map<string, BoardEntry[]>();
	for (const e of entries.values()) {
		if (e.parent === undefined || e.trashedAt !== undefined) continue;
		const list = kids.get(e.parent);
		if (list) list.push(e);
		else kids.set(e.parent, [e]);
	}
	const memo = new Map<string, boolean>();
	const visiting = new Set<string>();
	const canPrune = (e: BoardEntry): boolean => {
		const seen = memo.get(e.id);
		if (seen !== undefined) return seen;
		if (visiting.has(e.id)) return false;
		visiting.add(e.id);
		const result = eligible(e) && (kids.get(e.id) ?? []).every(canPrune);
		visiting.delete(e.id);
		memo.set(e.id, result);
		return result;
	};
	const out = new Set<string>();
	for (const e of entries.values()) {
		if (e.trashedAt === undefined && canPrune(e)) out.add(e.id);
	}
	return out;
}

function promoteOrphans(entries: Map<string, BoardEntry>): number {
	let promoted = 0;
	for (const e of entries.values()) {
		if (e.parent && !entries.has(e.parent)) {
			delete e.parent;
			promoted++;
		}
	}
	return promoted;
}

/**
 * Classified per entry from pre/post against `mayWrite` and `visibleTo`, never from which method ran,
 * so a method gaining a caller cannot change what is announced.
 *
 * BOTH holders are addressees. Reading only the pre-state would leave a session silent about work it
 * just gained, and would let a take-away sit in its bank uncorrected when the owner immediately
 * undoes one: the arrival overwrites that bank entry, which is the whole reason the bank keys on id.
 */
function noticesFor(
	prev: OwnerBoard,
	next: OwnerBoard,
	touched: ReadonlySet<string>,
	writer: BoardActor,
): BoardNotice[] {
	const notices: BoardNotice[] = [];
	for (const entryId of touched) {
		const pre = prev.entries.get(entryId);
		const post = next.entries.get(entryId);
		const parties = new Set([pre?.sessionId, post?.sessionId].filter((s) => s !== undefined));
		for (const sessionId of parties) {
			// mayWrite guarantees a session holds what it writes, so every route write is a self-echo and
			// the board's highest-volume writer would otherwise announce its own work to itself.
			if (writer.kind === "session" && writer.sessionId === sessionId) continue;
			const held = holds(pre, sessionId);
			const holdsNow = holds(post, sessionId);
			if (!held && !holdsNow) continue;
			const title = (holdsNow ? post?.title : pre?.title) ?? "";
			if (!held) {
				notices.push({ sessionId, entryId, kind: "arrived", title });
			} else if (!holdsNow) {
				if (post === undefined) notices.push({ sessionId, entryId, kind: "gone", title, how: "removed" });
				else if (visibleTo(post, sessionId)) notices.push({ sessionId, entryId, kind: "backlog", title });
				else if (post.trashedAt !== undefined)
					notices.push({ sessionId, entryId, kind: "gone", title, how: "trashed" });
				else notices.push({ sessionId, entryId, kind: "gone", title, how: "reassigned" });
			} else if (stableHash(pre) !== stableHash(post)) {
				// A commit spanning many entries reaches here for each; a value-identical one is not news.
				notices.push({ sessionId, entryId, kind: "changed" });
			}
		}
	}
	return notices;
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
	private readonly onNotices: ((notices: readonly BoardNotice[]) => void) | undefined;
	private readonly attachmentSink: BoardAttachmentSink | undefined;

	constructor(
		durable: DurableStore,
		planeRegistry: PlaneRegistry,
		restoredPlanes: Record<string, PlanePersistedState> | undefined,
		onNotices?: (notices: readonly BoardNotice[]) => void,
		attachmentSink?: BoardAttachmentSink,
	) {
		this.durable = durable;
		this.planeRegistry = planeRegistry;
		this.restoredPlanes = restoredPlanes;
		this.onNotices = onNotices;
		this.attachmentSink = attachmentSink;
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
			// A survivor whose parent was dropped would otherwise be unreachable from every live root
			// and refuse upserts forever.
			const promoted = promoteOrphans(entries);
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
	 * parent must exist among the surviving entries or the batch itself, and must be writable by
	 * this actor - an existing entry it does not hold cannot be adopted as a parent. */
	upsert(ownerId: string, entries: readonly BoardEntry[], actor: BoardActor): BoardResult {
		return this.mutate(ownerId, actor, (board, touch) => {
			const incoming = new Set(entries.map((e) => e.id));
			let added = 0;
			let changed = false;
			for (const e of entries) if (!board.entries.has(e.id)) added++;
			if (board.entries.size + added > MAX_ENTRIES_PER_OWNER) return "board_full";
			for (const e of entries) {
				if (!isValidRank(e.rank)) return "bad_rank";
				if (e.parent && !board.entries.has(e.parent) && !incoming.has(e.parent)) return "parent_missing";
				// Replacing an entry, or parenting onto one, is a write to it.
				const current = board.entries.get(e.id);
				if (current) {
					const denied = mayWrite(current, actor);
					if (denied) return denied;
				}
				const existingParent = e.parent && !incoming.has(e.parent) ? board.entries.get(e.parent) : undefined;
				if (existingParent) {
					const denied = mayWrite(existingParent, actor);
					if (denied) return denied;
				}
			}
			for (const e of entries) {
				const current = board.entries.get(e.id);
				// Attachments are NOT part of an upsert, whatever the incoming entry carries.
				// `setAttachments` is their sole committer, and that is what guarantees every stored
				// member's bytes are durable under the entry. A cross-Gateway move upserts a subtree
				// verbatim, so honouring the field here would land members nothing ever ingested: the
				// owner's next attachment write on that entry would then find no bytes, and since a
				// missing-bytes op is retryable rather than refused, the action would retry forever
				// and close the whole Gateway lane behind it.
				// Dropped FIRST and restored second. Spreading the stored value over the incoming one
				// only overwrites a list that already exists, so an entry with none - the destination of
				// a move, which is the case this exists for - kept whatever the incoming entry carried.
				const merged = { ...e };
				delete merged.attachments;
				if (current?.attachments) merged.attachments = current.attachments;
				// Key-order-insensitive compare: the in-place setters can reorder a stored entry's
				// keys, and a value-identical re-send must still gate as unchanged.
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
		});
	}

	setState(ownerId: string, id: string, state: BoardEntry["state"], actor: BoardActor): BoardResult {
		return this.mutateEntry(ownerId, id, actor, (e) => {
			if (e.state === state) return "unchanged";
			e.state = state;
		});
	}

	setTitle(ownerId: string, id: string, title: string, actor: BoardActor): BoardResult {
		return this.mutateEntry(ownerId, id, actor, (e) => {
			if (e.title === title) return "unchanged";
			e.title = title;
		});
	}

	/** Absent body clears it - the op always sets, never leaves unchanged. */
	setBody(ownerId: string, id: string, body: string | undefined, actor: BoardActor): BoardResult {
		return this.mutateEntry(ownerId, id, actor, (e) => {
			if (e.body === body) return "unchanged";
			if (body === undefined) delete e.body;
			else e.body = body;
		});
	}

	/**
	 * The SOLE committer of an entry's attachments. Absolute like every other setter, so attaching
	 * and removing are one op: whatever list arrives is the list stored.
	 *
	 * Sorted by blobId before it lands. `stableStringify` maps arrays POSITIONALLY, and that one hash
	 * is the plane identity, `upsert`'s did-it-change gate and `noticesFor`'s changed test all at
	 * once, so an unordered rebuild would ship the whole board, report a false "applied", and push a
	 * spurious awareness notice, together, every time.
	 *
	 * Reclaim is the membership DIFF, never a count comparison: a same-count swap has to release the
	 * picture that left. The caller has already made every incoming member's bytes durable.
	 */
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
		// After the commit, so bytes are never dropped for a write that refused or did not change.
		if (result.applied && released.length > 0) this.attachmentSink?.released(ownerId, id, released);
		return result;
	}

	/** One placement intent: parent and rank land together. Absent parent means root. The PARENT is
	 * scope-checked as well as the entry: without that, a session could graft its subtree under an
	 * entry belonging to another session. */
	setParent(ownerId: string, id: string, parent: string | undefined, rank: string, actor: BoardActor): BoardResult {
		return this.mutate(ownerId, actor, (board, touch) => {
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
			// A reorder within the same parent is rank-only, which no other session can act on.
			if (entry.parent !== parent) touch(id);
			if (parent === undefined) delete entry.parent;
			else entry.parent = parent;
			entry.rank = rank;
			return this.wouldCycle(board, id) ? "cycle" : undefined;
		});
	}

	/** Trash or restore an entry AND its subtree - a flag, never a removal. The stamp is this
	 * gateway's clock, since the sweep runs against it. */
	setTrashed(ownerId: string, id: string, trashed: boolean, now = Date.now()): BoardResult {
		return this.mutate(ownerId, OWNER_ACTOR, (board, touch) => {
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
		});
	}

	/** Assign or unassign an entry and its subtree. Owner-authority: any entry, any session - the
	 * session-scoped paths are claim/release below, which never override another session. */
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

	/** A session takes an unassigned entry and its subtree. Succeeds when every member is unassigned
	 * or already this session's (a lost-reply retry is a no-op); refuses when ANOTHER session holds
	 * the entry or any member - claiming an ancestor must never seize a sibling session's work. */
	claim(ownerId: string, id: string, sessionId: string): BoardResult {
		return this.mutate(ownerId, { kind: "session", sessionId }, (board, touch) => {
			const target = board.entries.get(id);
			if (!target) return "entry_missing";
			// The trash is the owner's alone. A session holds ids from before it was trashed, and
			// without this it could take and rewrite something no list will ever show it again.
			if (target.trashedAt !== undefined) return "entry_missing";
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
				touch(memberId);
			}
			return changed ? undefined : "unchanged";
		});
	}

	/** A session hands back what it holds within the entry's subtree - only ITS members unassign, so
	 * releasing a shared ancestor never dumps a sibling session's work to the backlog. Already-released
	 * applies as a no-op; an entry held by another session refuses. */
	release(ownerId: string, id: string, sessionId: string): BoardResult {
		return this.mutate(ownerId, { kind: "session", sessionId }, (board, touch) => {
			const entry = board.entries.get(id);
			if (!entry) return "entry_missing";
			if (entry.sessionId !== undefined && entry.sessionId !== sessionId) return "held";
			let changed = false;
			for (const memberId of this.subtree(board, id)) {
				const e = board.entries.get(memberId);
				if (!e || e.sessionId !== sessionId) continue;
				delete e.sessionId;
				changed = true;
				touch(memberId);
			}
			return changed ? undefined : "unchanged";
		});
	}

	/** Trash a session's finished entries (taskBoardClear), pruning whole finished subtrees and keeping
	 * every parent that still owns a survivor. Returns how many.
	 *
	 * The survivor may be unfinished, or finished and held by ANOTHER session, and either keeps its
	 * parent: a kept parent is the only thing that stops the child ending up under an entry no list
	 * returns. Its own turn comes once that child is finished or moved. */
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

	/** Create an entry at the end of its parent's live siblings. Placement is an INTENT the write
	 * carries, never a rank the caller holds: minting can rebalance the sibling group, so a caller
	 * that minted first and wrote second could have that rebalance commit even when the write is
	 * then refused. Here both land in one mutate or neither does. */
	createAtEnd(ownerId: string, entry: Omit<BoardEntry, "rank">, actor: BoardActor): BoardResult {
		return this.mutate(ownerId, actor, (board, touch) => {
			// The replay answer comes FIRST and is not scope-checked. The id derives from the caller's
			// own private operation id, so an id that already exists IS this caller's earlier create -
			// and a backlog create leaves the entry unassigned, which a scope check would then refuse,
			// telling a caller its landed create will never apply.
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
		});
	}

	/** Move an entry to the end of a new parent's live siblings, minting inside the same write for
	 * the reason [createAtEnd] gives. */
	setParentAtEnd(ownerId: string, id: string, parent: string | undefined, actor: BoardActor): BoardResult {
		return this.mutate(ownerId, actor, (board, touch) => {
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
			// After the reparent, so the new group's siblings are the ones measured. Its rebalance
			// rewrites sibling ranks, which nothing can act on, so only the moved entry is announced.
			entry.rank = this.placeAtEnd(board, parent, id);
			touch(id);
			return this.wouldCycle(board, id) ? "cycle" : undefined;
		});
	}

	/** The rank for a fresh member at the end of `parent`'s live siblings, REBALANCING that group in
	 * place when the mint would breach the rank bound - an oversized rank stored once would poison
	 * the file against the wire schema on every later read. Mutates the board it is handed, so it is
	 * only ever called from inside a mutate closure. */
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
		// rebalanceRanks asserts its own output, so this is a last line against a future regression
		// re-poisoning the file - the exact failure this method exists to prevent.
		if (!fresh.every(isValidRank) || !isValidRank(tail)) throw new Error("rank rebalance produced invalid ranks");
		for (let i = 0; i < siblings.length; i++) {
			const e = board.entries.get(siblings[i].id);
			if (e) e.rank = fresh[i];
		}
		return tail;
	}

	/** TRUE removal, the delete half of a cross-Gateway move only. Literal ids: a survivor whose
	 * parent is being removed refuses the batch, so a caller must ship the whole subtree. */
	remove(ownerId: string, ids: readonly string[]): BoardResult {
		return this.mutate(ownerId, OWNER_ACTOR, (board, touch) => {
			const removing = new Set(ids);
			for (const e of board.entries.values()) {
				if (!removing.has(e.id) && e.parent && removing.has(e.parent)) return "would_orphan";
			}
			for (const id of ids) {
				if (board.entries.delete(id)) touch(id);
			}
			return undefined;
		});
	}

	/** A session ended. Done and cancelled entries are trashed (30 recoverable days); what happens to
	 * the REST is the caller's `disposition` - released back to the backlog, or cancelled first and so
	 * trashed by the same pass. Required at every call site rather than defaulted, so a caller cannot
	 * fall into a disposition it did not choose.
	 *
	 * The whole end-of-life is this one pass, which is what makes it atomic with the forget that
	 * triggers it. It is also SET-VALUED here - every entry the store holds for that session, not a
	 * list a client enumerated from a snapshot it may not have refreshed. */
	sessionEnded(sessionKey: string, disposition: BoardDisposition, now = Date.now()): number {
		let count = 0;
		for (const ownerId of [...this.owners.keys()]) {
			// Announces nothing: a notice would name a session the send edge is about to find gone.
			this.mutate(ownerId, OWNER_ACTOR, (board) => {
				let touched = false;
				// The disposition first, so the prune below sees the states this pass actually leaves.
				for (const e of board.entries.values()) {
					if (e.sessionId !== sessionKey) continue;
					// Already trashed means the owner set it aside before this. The forget prompt did
					// not count it, so the disposition does not restate it; it still loses its session.
					const finished = e.state === "done" || e.state === "cancelled";
					if (disposition === "cancel" && !finished && e.trashedAt === undefined) e.state = "cancelled";
					touched = true;
					count++;
				}
				// Same rule as clearDone: a finished entry is set aside only when its whole subtree goes
				// with it, so a child left behind by another session keeps its parent.
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
				// After the prune, or an entry would no longer look like the session's own to it.
				for (const e of board.entries.values()) {
					if (ending.has(e.id)) delete e.sessionId;
				}
				return touched ? undefined : "unchanged";
			});
		}
		return count;
	}

	/** Drop entries trashed longer than the retention window. This is the ONE permanent delete that
	 * cannot refuse - the window is up and the entry goes - so it reconciles instead: a survivor whose
	 * parent went with it is promoted rather than left pointing at nothing. `remove`, the other
	 * permanent delete, refuses `would_orphan` because its caller can still ship the whole subtree. */
	sweepTrash(now = Date.now()): void {
		for (const ownerId of [...this.owners.keys()]) {
			let swept: string[] = [];
			// Announces nothing either: the take-away already happened at the trash, 30 days earlier.
			const result = this.mutate(ownerId, OWNER_ACTOR, (board) => {
				const dead: string[] = [];
				for (const e of board.entries.values()) {
					if (e.trashedAt !== undefined && now - e.trashedAt > BOARD_TRASH_TTL_MS) dead.push(e.id);
				}
				if (dead.length === 0) return "unchanged";
				// EVERY dead entry, not just those whose stored list named bytes. A partial adopt commits
				// files the metadata never mentions, and this is the last moment anything can reach them:
				// the membership diff reads a stored list, and the entry is about to stop existing.
				swept = dead;
				for (const id of dead) board.entries.delete(id);
				promoteOrphans(board.entries);
				return undefined;
			});
			// The entry is gone for good, so its whole directory goes with it. After the commit: bytes
			// outliving a failed write are reclaimable, bytes dropped for one that never landed are not.
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
	 * "unchanged" applies without committing, so a no-op never bumps the plane or hits the disk.
	 *
	 * Touched ids are LOCAL to this invocation. Four exits never commit (unchanged, a refusal, a
	 * `placeAtEnd` throw, a commit rollback), and a store-level buffer would ship what they left behind
	 * on the owner's next successful write. A closure marks ids rather than snapshots, since `current`
	 * is the untouched pre-state and cannot drift from what committed. */
	private mutate(
		ownerId: string,
		writer: BoardActor,
		fn: (board: OwnerBoard, touch: (entryId: string) => void) => BoardRefusal | "unchanged" | undefined,
	): BoardResult {
		const current = this.owners.get(ownerId) ?? { revision: 0, entries: new Map() };
		const copy: OwnerBoard = {
			revision: current.revision,
			entries: new Map([...current.entries].map(([id, e]) => [id, { ...e }])),
		};
		const touched = new Set<string>();
		const outcome = fn(copy, (entryId) => touched.add(entryId));
		if (outcome === "unchanged") return { applied: true };
		if (outcome) return { applied: false, refused: outcome };
		const notices = noticesFor(current, copy, touched, writer);
		this.commit(ownerId, copy);
		if (notices.length > 0) this.announce(notices);
		return { applied: true };
	}

	/** The write already committed, so a throwing sink is logged rather than propagated. */
	private announce(notices: readonly BoardNotice[]): void {
		try {
			console.error(
				`[task-board] ${notices.length} notice(s): ${notices.map((n) => `${n.kind}/${n.entryId}`).join(" ")}`,
			);
			this.onNotices?.(notices);
		} catch (err) {
			console.error("[task-board] notice sink failed:", err);
		}
	}

	private mutateEntry(
		ownerId: string,
		id: string,
		actor: BoardActor,
		fn: (entry: BoardEntry) => "unchanged" | undefined,
	): BoardResult {
		return this.mutate(ownerId, actor, (board, touch) => {
			const entry = board.entries.get(id);
			if (!entry) return "entry_missing";
			const denied = mayWrite(entry, actor);
			if (denied) return denied;
			const outcome = fn(entry);
			if (!outcome) touch(id);
			return outcome;
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
