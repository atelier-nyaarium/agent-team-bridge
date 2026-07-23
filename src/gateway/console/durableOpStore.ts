import { capFifo } from "../../shared/cap-fifo.js";
import { type ConsoleOpResult, MAX_OPS_PER_CONVERSATION } from "../../shared/console-protocol.js";
import type { DurableStore } from "../../shared/durable-store.js";
import { ConsoleOpResultSchema } from "../../shared/schemas.js";

////////////////////////////////
//  Interfaces & Types

type OpRecord = { state: "in-flight" } | { state: "complete"; result: ConsoleOpResult };

type Entry = { record: OpRecord; expiresAt: number; generation: number };

// The same per-conversation bound the in-memory opCache already uses (shared/console-protocol.ts)
// - a durable op can never outnumber the ops that pass through it.
const DEFAULT_MAX_OPS_PER_CONVERSATION = MAX_OPS_PER_CONVERSATION;

// Mirrors DeviceMailboxStore's own DEFAULT_MAX_DEVICES - the same order of magnitude for "how many
// distinct conversations can exist" bound already established for the console's other per-device
// durable state.
const DEFAULT_MAX_CONVERSATIONS = 500;

// The client's real replay window is reconcilePending() - it re-sends any still-pending row with
// its original opId once per service start, which can be hours or days after the first attempt
// (a phone left off overnight). ReplayGuard's 300s TTL and the in-memory opCache's teardown-tied
// lifetime are both sized for a different, much shorter threat; this store needs to outlive them.
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

////////////////////////////////
//  Class

/**
 * Durable, restart-proof idempotency for `send`/`respond`, consulted only on an in-memory opCache
 * MISS (consoleHandler.ts's opCache stays the per-process single-flight/replay layer - it holds
 * the live promise a concurrent same-process retry coalesces onto, a role this store cannot take
 * over since it persists no promise, only a settled record).
 *
 * Two states per `(conversationId, opId)`:
 * - `in-flight` - written before the op's work is dispatched. A replayed in-flight opId
 *   RE-EXECUTES (the crash-mid-work case - today's own recovery, preserved).
 * - `complete` - written only when the op's side effect SUCCEEDS. A replayed complete opId
 *   returns the stored result instead of re-running.
 *
 * A FAILED op must never reach `complete` - the caller clears the record (or leaves it
 * `in-flight`) instead, mirroring the in-memory opCache's own drop-on-failure rule: a failed op
 * performed no side effect, so a retry must re-attempt, not replay a stale failure for the next
 * two weeks.
 *
 * `markInFlight` mints a fresh generation token on every call - including a re-execution over an
 * already-in-flight record (the opCache-eviction-during-in-flight tail, accepted in Audit round 3)
 * - and `clear` only takes effect when the caller's own generation still matches the CURRENT one.
 * This is what keeps a stale, superseded attempt's eventual failure from erasing a newer, still-
 * live attempt's own in-flight marker (an already-`complete` record is separately immune to
 * `clear` regardless of generation, since the op's side effect already happened by then).
 *
 * Explicitly independent of any device/conversation teardown - the in-memory opCache's own
 * idempotency dies after ~1h of console silence via the mailbox's idle-teardown sweep, precisely
 * the lifetime bug this store exists to not inherit.
 *
 * Persisted synchronously on every state transition (not a periodic tick, unlike DeviceMailbox/
 * ReplayGuard/SessionStore) - a hard crash must lose at most the write already in flight, not up
 * to a whole tick interval, since that window is exactly what this store exists to close.
 */
export class DurableOpStore {
	private readonly byConversation = new Map<string, Map<string, Entry>>();
	private nextGeneration = 1;

	public constructor(
		private readonly durable: DurableStore,
		private readonly ttlMs: number = DEFAULT_TTL_MS,
		private readonly maxOpsPerConversation: number = DEFAULT_MAX_OPS_PER_CONVERSATION,
		private readonly maxConversations: number = DEFAULT_MAX_CONVERSATIONS,
		private readonly now: () => number = Date.now,
	) {
		this.restore();
	}

	/** The stored record for `(conversationId, opId)`, or undefined if unknown or expired. */
	public get(conversationId: string, opId: string): OpRecord | undefined {
		const entry = this.byConversation.get(conversationId)?.get(opId);
		if (!entry || entry.expiresAt <= this.now()) return undefined;
		return entry.record;
	}

	/** Total tracked op records across every conversation - boot-time/operational visibility only
	 * (mirrors SessionStore/DeviceMailboxStore/PendingJobStore's own `size`, all logged together at
	 * boot in gateway/index.ts). */
	public get size(): number {
		let total = 0;
		for (const perConv of this.byConversation.values()) total += perConv.size;
		return total;
	}

	/** Write `in-flight` before dispatching the op's work, minting a fresh generation token the
	 * caller must present back to `clear()` at its own eventual settlement. */
	public markInFlight(conversationId: string, opId: string): number {
		const existing = this.byConversation.get(conversationId)?.get(opId);
		if (existing?.record.state === "in-flight") {
			// The crash-mid-work/opCache-eviction-during-in-flight recovery path (Audit round 3) -
			// exactly the moment a duplicate side effect (a second channel_push/response_push) can
			// occur, so it is worth a trace even though it is an accepted, expected corner.
			console.warn(
				`[durableOpStore] ${conversationId.slice(0, 12)}/${opId} re-executing over an already in-flight record (generation ${existing.generation})`,
			);
		}
		const generation = this.nextGeneration++;
		this.write(conversationId, opId, { state: "in-flight" }, generation);
		return generation;
	}

	/** Write `complete` - call this ONLY when the op's side effect has actually succeeded. Not
	 * generation-gated: any attempt that genuinely succeeded is a permanent completion once
	 * written, regardless of a newer attempt racing it - but write-once: a second attempt's own
	 * genuine success must never overwrite the FIRST completion's result (two concurrent successes
	 * for one opId can legitimately produce different result content, e.g. a fast send's own
	 * `{status:"running"}` vs the backgrounded path's `{status:"sent"}` for the same op). */
	public markComplete(conversationId: string, opId: string, result: ConsoleOpResult): void {
		const existing = this.byConversation.get(conversationId)?.get(opId);
		if (existing?.record.state === "complete") {
			// Two concurrent attempts for the same opId both genuinely succeeded - a real duplicate
			// side effect just happened. Worth a trace even though the store itself handles it safely.
			console.warn(
				`[durableOpStore] ${conversationId.slice(0, 12)}/${opId} discarding a second genuine completion - two concurrent attempts both succeeded; the first result wins`,
			);
			return;
		}
		this.write(conversationId, opId, { state: "complete", result }, existing?.generation ?? this.nextGeneration++);
	}

	/** An op settled as a failure: drop the record so a retry re-attempts instead of replaying the
	 * stale failure - but ONLY if `generation` (returned by this attempt's own `markInFlight`)
	 * still matches the record's current generation. A mismatch means a newer attempt has since
	 * taken over this key (the opCache-eviction-during-in-flight tail); this stale attempt's
	 * failure must not erase that newer attempt's own still-live in-flight marker. Returns whether
	 * it actually cleared - a caller also holding an in-memory cache keyed the same way (e.g.
	 * consoleHandler.ts's opCache) uses this to decide whether IT is still safe to evict too. */
	public clear(conversationId: string, opId: string, generation: number): boolean {
		const perConv = this.byConversation.get(conversationId);
		const entry = perConv?.get(opId);
		if (!perConv || !entry) return true;
		// Once complete, the op's side effect already happened - immune regardless of generation.
		if (entry.record.state === "complete") return false;
		if (entry.generation !== generation) {
			// The losing side of the same race markComplete's write-once guard logs the winning side
			// of - a newer attempt already took over this key, so this stale attempt's failure must
			// not erase it.
			console.warn(
				`[durableOpStore] ${conversationId.slice(0, 12)}/${opId} refusing to clear - a newer attempt (generation ${entry.generation}) has since taken over this key (stale generation ${generation})`,
			);
			return false;
		}
		perConv.delete(opId);
		if (perConv.size === 0) this.byConversation.delete(conversationId);
		this.persist();
		return true;
	}

	/** Actively remove TTL-expired entries rather than leaving them as dead weight only masked at
	 * read time (`get`) - without this, a completed op for an otherwise-idle conversation sits
	 * fully intact (and gets faithfully re-serialized by every OTHER conversation's `persist()`
	 * call) for the entire TTL window even under ordinary, non-abusive usage. Mirrors
	 * SessionStore's own `sweep(ttlMs)`, called from the same periodic tick in gateway/index.ts.
	 * Returns whether anything was actually removed, so a caller can skip an unnecessary persist. */
	public sweep(): boolean {
		const t = this.now();
		let removedAny = false;
		for (const [conv, perConv] of this.byConversation) {
			for (const [opId, entry] of perConv) {
				if (entry.expiresAt <= t) {
					perConv.delete(opId);
					removedAny = true;
				}
			}
			if (perConv.size === 0) this.byConversation.delete(conv);
		}
		if (removedAny) this.persist();
		return removedAny;
	}

	private write(conversationId: string, opId: string, record: OpRecord, generation: number): void {
		let perConv = this.byConversation.get(conversationId);
		// Delete-then-reinsert (Map iteration is insertion-ordered) moves this conversation to the
		// END of byConversation, so the conversation cap below evicts by LAST-WRITTEN, not first-
		// CREATED - a long-lived, actively-used conversation must never be evicted ahead of an idle
		// one just because it happened to be created first.
		if (perConv) this.byConversation.delete(conversationId);
		else perConv = new Map();
		this.byConversation.set(conversationId, perConv);
		const conversationsBefore = this.byConversation.size;
		capFifo(this.byConversation, this.maxConversations);
		if (this.byConversation.size < conversationsBefore) {
			console.warn(
				`[durableOpStore] conversation cap reached (${this.maxConversations}) - evicted the least-recently-written conversation`,
			);
		}
		// Same reasoning one level down: an existing opId's re-write (in-flight -> complete, or a
		// re-executed in-flight after eviction/crash recovery) must move to the END of perConv too,
		// or the per-conversation cap below could evict an op that was JUST written ahead of a
		// genuinely stale sibling that simply happened to be inserted later.
		if (perConv.has(opId)) perConv.delete(opId);
		perConv.set(opId, { record, expiresAt: this.now() + this.ttlMs, generation });
		const opsBefore = perConv.size;
		capFifo(perConv, this.maxOpsPerConversation);
		if (perConv.size < opsBefore) {
			console.warn(
				`[durableOpStore] ${conversationId.slice(0, 12)} per-conversation op cap reached (${this.maxOpsPerConversation}) - evicted the least-recently-written op record`,
			);
		}
		this.persist();
	}

	private persist(): void {
		const snapshot: Array<[string, Array<[string, OpRecord, number, number]>]> = [];
		for (const [conv, perConv] of this.byConversation) {
			const rows: Array<[string, OpRecord, number, number]> = [];
			for (const [opId, entry] of perConv) rows.push([opId, entry.record, entry.expiresAt, entry.generation]);
			snapshot.push([conv, rows]);
		}
		this.durable.save(snapshot);
	}

	private restore(): void {
		const raw = this.durable.load();
		if (!Array.isArray(raw)) return;
		const t = this.now();
		let maxGeneration = 0;
		let rejectedConversations = 0;
		let rejectedRows = 0;
		for (const convEntry of raw) {
			if (!Array.isArray(convEntry) || convEntry.length !== 2) {
				rejectedConversations++;
				continue;
			}
			const [conv, rows] = convEntry as [unknown, unknown];
			if (typeof conv !== "string" || !Array.isArray(rows)) {
				rejectedConversations++;
				continue;
			}
			const perConv = new Map<string, Entry>();
			for (const row of rows) {
				if (!Array.isArray(row) || row.length !== 4) {
					rejectedRows++;
					continue;
				}
				const [opId, record, expiresAt, generation] = row as [unknown, unknown, unknown, unknown];
				if (typeof opId !== "string" || typeof expiresAt !== "number") {
					rejectedRows++;
					continue;
				}
				if (expiresAt <= t) continue;
				if (typeof generation !== "number") {
					rejectedRows++;
					continue;
				}
				if (!isOpRecord(record)) {
					rejectedRows++;
					continue;
				}
				perConv.set(opId, { record, expiresAt, generation });
				if (generation > maxGeneration) maxGeneration = generation;
			}
			// Re-apply the SAME caps write() enforces live - a persisted file from a prior boot with
			// looser bounds (a config rollback, or a hand-restored/foreign snapshot) must not load
			// uncapped into memory just because it predates the current limits.
			capFifo(perConv, this.maxOpsPerConversation);
			if (perConv.size > 0) this.byConversation.set(conv, perConv);
		}
		capFifo(this.byConversation, this.maxConversations);
		if (rejectedConversations > 0 || rejectedRows > 0) {
			console.warn(
				`[durableOpStore] restore rejected ${rejectedConversations} malformed conversation(s) and ${rejectedRows} malformed row(s) - a schema change or file corruption may have silently dropped durable completions`,
			);
		}
		// Resume minting generations above every restored one, so a freshly-restored in-flight
		// record can never collide with (or be mistaken for current by) a brand-new attempt's token.
		this.nextGeneration = maxGeneration + 1;
	}
}

/** Validates a restored row's record shape before it is trusted and (for `complete`) later
 * replayed verbatim to a console - mirrors SessionStore.restore()'s own per-field validation of
 * its durable snapshot rather than blindly casting. A `complete` record's result is checked
 * against the real wire schema, not just "is it an object", since it flows straight to a sealed
 * console reply with no other validation on that path. */
function isOpRecord(value: unknown): value is OpRecord {
	if (typeof value !== "object" || value === null || !("state" in value)) return false;
	if (value.state === "in-flight") return true;
	if (value.state !== "complete") return false;
	return "result" in value && ConsoleOpResultSchema.safeParse(value.result).success;
}
