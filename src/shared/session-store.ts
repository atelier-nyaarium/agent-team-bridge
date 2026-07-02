import crypto from "node:crypto";
import { composeSessionName, isComposite, isSlug, parseSessionName } from "./session-id.js";

////////////////////////////////
//  Interfaces & Types

/** The live registry socket currently serving a record: the registered team field plus the subId
 * that confirmed. Volatile - never persisted (a stamp cannot outlive the sockets it points at). */
export interface LiveRef {
	team: string;
	subId: string;
}

/** One phone session. `id` is the address session segment (and the tmux name for daemon panes);
 * `sessionLabel` is the free-form human label the board renders. Records key on the composite
 * `spawn.id`, so `id` need only be unique WITHIN its spawn (as the address grammar already is). */
export interface SessionRecord {
	id: string;
	sessionLabel: string;
	spawn: string;
	// Host sessions: drives the daemon's ~/projects/<hint> workdir inference (the id is opaque).
	workdirHint?: string;
	// The harness resume id, bound at handshake-confirm; the one-record-per-transcript dedup key.
	claudeSessionId?: string;
	liveTeam?: LiveRef;
	confirmedAt?: number;
	lastSeen: number;
}

/** Extra id-space the mint/adopt clash check must avoid beyond existing records: catalog project
 * names and reserved host sessions live in gateway state, so the gateway injects the predicate. */
export type ClashPredicate = (id: string) => boolean;

export interface SessionStoreOptions {
	clash?: ClashPredicate;
	now?: () => number;
	// Injectable id generator for deterministic tests; production uses 6-hex randomBytes.
	idGen?: () => string;
}

interface CreateOpts {
	spawn: string;
	sessionLabel?: string;
	workdirHint?: string;
	claudeSessionId?: string;
}

////////////////////////////////
//  Functions & Helpers

const LABEL_MAX = 64;
// Invisible or direction-warping characters (controls, zero-width/format, bidi overrides, lone
// surrogates, private-use, unassigned) make a label unrenderable or spoofable on the board; path
// separators would let an unauthenticated register steer resolveHostWorkdir's path join. One rule
// for both risks: a label is a single, VISIBLY printable path segment. Unicode category classes
// rather than a codepoint blocklist, so new invisible characters cannot slip through.
const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}/\\]/u;

/** Normalize a human-supplied label (create, rename, register cwdName): trimmed, capped, visibly
 * printable, a single path segment. Returns null when nothing safe remains. */
export function sanitizeLabel(raw: string | undefined | null): string | null {
	// Cap on CODE POINTS: a code-unit slice can split an astral character and leave an ill-formed
	// string that breaks JSON consumers downstream.
	const trimmed = [...(raw ?? "").trim()].slice(0, LABEL_MAX).join("");
	if (!trimmed || trimmed === "." || trimmed === "..") return null;
	if (LABEL_FORBIDDEN.test(trimmed)) return null;
	return trimmed;
}

function randomId(): string {
	return crypto.randomBytes(3).toString("hex");
}

////////////////////////////////
//  Class

/**
 * The gateway's authoritative session store: SessionRecords keyed by their composite `spawn.id`
 * team field (globally unique, exactly the address a session registers and lists under). All data
 * invariants live here - per-spawn id + label uniqueness, label sanitization, and the legacy-file
 * migration. Liveness POLICY (first-binding-holds refusal, wake suppression) stays with callers:
 * "live" is a registry probe only the gateway can make, so the store carries the liveTeam data and
 * callers decide.
 */
export class SessionStore {
	private readonly records = new Map<string, SessionRecord>();
	// Per-spawn set of taken labels, so dedup is O(1) rather than a full-store scan on every create.
	private readonly labels = new Map<string, Set<string>>();
	private readonly clash: ClashPredicate;
	private readonly now: () => number;
	private readonly idGen: () => string;

	constructor(opts: SessionStoreOptions = {}) {
		this.clash = opts.clash ?? (() => false);
		this.now = opts.now ?? (() => Date.now());
		this.idGen = opts.idGen ?? randomId;
	}

	get size(): number {
		return this.records.size;
	}

	list(): SessionRecord[] {
		return [...this.records.values()];
	}

	/** The composite team field a record registers and lists under - its store key. */
	teamOf(record: SessionRecord): string {
		return composeSessionName(record.spawn, record.id);
	}

	/** The host workdir hint the daemon resolves to ~/projects/<hint>: the frozen workdirHint, else the
	 * current sessionLabel. workdirHint FIRST is load-bearing - rename() mutates only sessionLabel, so a
	 * renamed session's workdir must stay pinned to its original label. The one owner of this precedence
	 * so the wake and create paths cannot drift apart. */
	hostWorkdirHint(record: SessionRecord): string {
		return record.workdirHint ?? record.sessionLabel;
	}

	/** The record a composite team field names, or undefined. */
	getByTeam(team: string): SessionRecord | undefined {
		return isComposite(team) ? this.records.get(team) : undefined;
	}

	/** Create a record under a fresh random id. Re-rolls on any clash with an existing record in this
	 * spawn or the injected id-space; the space is 16^6 against a handful of records, so the retry cap
	 * is unreachable in practice and exists to make a broken idGen loud. Used by establishOnConfirm's
	 * tier-4 fallback (a confirming session whose segment collides with a reserved/catalog name). */
	mint(opts: CreateOpts): SessionRecord {
		for (let i = 0; i < 64; i++) {
			const id = this.idGen();
			if (!this.records.has(composeSessionName(opts.spawn, id)) && !this.clash(id)) return this.create(id, opts);
		}
		throw new Error("session id space exhausted");
	}

	/** Create a record under a caller-supplied id (the hand-set composite escape hatch, send-wake).
	 * Returns null when the id is taken in this spawn or reserved - the caller decides bind vs mint. */
	adoptById(id: string, opts: CreateOpts): SessionRecord | null {
		if (!isSlug(id) || this.clash(id)) return null;
		if (this.records.has(composeSessionName(opts.spawn, id))) return null;
		return this.create(id, opts);
	}

	/** The idempotent create path: adopt a caller-supplied id, else REATTACH the record already under
	 * it (a retry / post-restart re-dispatch of the same create). Returns `{record, created}` (created
	 * true iff a fresh record was made), or null when the id is reserved/clashing and no record holds
	 * it - the caller refuses rather than launch a recordless session. */
	adoptOrReattach(id: string, opts: CreateOpts): { record: SessionRecord; created: boolean } | null {
		const created = this.adoptById(id, opts);
		if (created) return { record: created, created: true };
		const existing = this.records.get(composeSessionName(opts.spawn, id));
		return existing ? { record: existing, created: false } : null;
	}

	/** Bind the resume id (and optional live pointer) onto the record a team names. Confirm tier 1. */
	bindBySegment(team: string, extra: { claudeSessionId?: string; live?: LiveRef } = {}): SessionRecord | null {
		const record = this.getByTeam(team);
		return record ? this.bind(record, extra) : null;
	}

	/** The record holding a Claude transcript, or undefined - a read-only lookup so a caller can
	 * apply first-binding-holds (refuse a second live incarnation of the same transcript) before
	 * binding. */
	resumeRecord(claudeSessionId: string): SessionRecord | undefined {
		for (const record of this.records.values()) {
			if (record.claudeSessionId === claudeSessionId) return record;
		}
		return undefined;
	}

	/** Bind a live registrant to the record holding its Claude transcript (a manual `--resume`
	 * re-incarnation). Confirm tier 2. */
	bindResume(claudeSessionId: string, extra: { live?: LiveRef } = {}): SessionRecord | null {
		const record = this.resumeRecord(claudeSessionId);
		return record ? this.bind(record, { claudeSessionId, live: extra.live }) : null;
	}

	/** Stamp a completed lead handshake: confirmedAt plus the optional live incarnation pointer. */
	confirm(team: string, live?: LiveRef): SessionRecord | undefined {
		const record = this.records.get(team);
		if (record) {
			record.confirmedAt = this.now();
			record.lastSeen = this.now();
			if (live) record.liveTeam = live;
		}
		return record;
	}

	/**
	 * Establish the durable record for a confirmed lead, one record per Claude transcript. Runs the
	 * binding-order precedence and stamps the confirm, so this write-invariant lives here rather than
	 * in the caller. A bare (spawn-point) team returns undefined - it never becomes a session record.
	 *  1. own segment names an existing record (preemptive create, legacy, daemon relaunch)
	 *  2. the resume id matches a record (a manual `claude --resume` re-incarnation)
	 *  3. the segment is free -> adopt it (a hand-set composite name, and every flag-enabled loose
	 *     launch, whose self-composed segment is free by construction)
	 *  4. else mint a fresh id (reached only when the segment collides with the catalog / reserved
	 *     names).
	 * A re-confirm converges on the same record via its segment (tier 1) or transcript id (tier 2);
	 * only a colliding-segment session with no transcript id falls to the tier-4 mint fallback.
	 */
	establishOnConfirm(
		team: string,
		{ claudeSessionId, label, live }: { claudeSessionId?: string; label?: string; live: LiveRef },
	): SessionRecord | undefined {
		if (!isComposite(team)) return undefined;
		let record = this.bindBySegment(team, { claudeSessionId });
		if (!record && claudeSessionId) record = this.bindResume(claudeSessionId);
		if (!record) {
			const { project: spawn, session: id } = parseSessionName(team);
			record =
				this.adoptById(id, { spawn, sessionLabel: label, workdirHint: label ?? id, claudeSessionId }) ??
				this.mint({ spawn, sessionLabel: label, workdirHint: label, claudeSessionId });
		}
		return this.confirm(this.teamOf(record), live);
	}

	/** Apply a new label (sealed rename op). Returns the label actually applied after sanitization
	 * + per-spawn dedup, or null when the record is gone or nothing safe remained. */
	rename(team: string, label: string): string | null {
		const record = this.records.get(team);
		const clean = sanitizeLabel(label);
		if (!record || !clean) return null;
		this.releaseLabel(record);
		record.sessionLabel = this.dedupLabel(record.spawn, clean);
		this.claimLabel(record);
		record.lastSeen = this.now();
		return record.sessionLabel;
	}

	forget(team: string): boolean {
		const record = this.records.get(team);
		if (!record) return false;
		this.releaseLabel(record);
		return this.records.delete(team);
	}

	/** Refresh a record's lastSeen while a live incarnation serves it, so the TTL sweep can never
	 * delete a live session's record out of visibility. */
	touchLive(team: string): void {
		const record = this.records.get(team);
		if (record) record.lastSeen = this.now();
	}

	resolveLive(team: string): LiveRef | undefined {
		return this.records.get(team)?.liveTeam;
	}

	/** Disconnect hook: drop the live pointer of the record the closing (team, subId) incarnation
	 * served. Matches BOTH fields so a sibling sub-session under the same team cannot clear a
	 * still-live incarnation's pointer. */
	clearLive(team: string, subId: string): void {
		for (const record of this.records.values()) {
			if (record.liveTeam?.team === team && record.liveTeam.subId === subId) record.liveTeam = undefined;
		}
	}

	/** Drop records not seen inside the TTL. Live records survive via touchLive refreshes.
	 * Deliberately caller-driven (the TTL is a per-call arg, unlike the self-timer sibling stores)
	 * so the gateway can sweep immediately BEFORE snapshot() on the persist tick - the persisted
	 * file then never carries a just-expired record. */
	sweep(ttlMs: number): void {
		const cutoff = this.now() - ttlMs;
		for (const [team, record] of this.records) {
			if (record.lastSeen < cutoff) {
				this.releaseLabel(record);
				this.records.delete(team);
			}
		}
	}

	/** The persisted shape: records keyed by their composite team, live pointers stripped (a
	 * liveTeam stamp must never survive the sockets it points at). */
	snapshot(): Record<string, Omit<SessionRecord, "liveTeam">> {
		const out: Record<string, Omit<SessionRecord, "liveTeam">> = {};
		for (const record of this.records.values()) {
			const { liveTeam: _live, ...rest } = record;
			out[this.teamOf(record)] = rest;
		}
		return out;
	}

	/**
	 * Load a persisted snapshot, migrating the legacy resume-map shape. Both shapes key by the
	 * composite team: a legacy value is `{claudeSessionId, lastSeen}` and becomes a full record
	 * (label + workdir hint seeded from the segment, confirmedAt = lastSeen, since it was recorded
	 * under the old trusted-provenance regime); a persisted record (value carries `id`) is loaded as
	 * is. Labels are re-sanitized (path-safety) and re-deduped (a hand-edited file could hold two
	 * same-spawn records sharing a label), and a rename survives any number of restarts because a
	 * loaded record is never re-derived from its segment.
	 */
	restore(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		// TODO(post-upgrade cleanup): the `!persisted` legacy branch below reads the OLD
		// {claudeSessionId, lastSeen} resume-map shape. Every persist tick re-snapshots in the new
		// record shape, so once every gateway has re-written session-resume.json this branch (and its
		// `persisted` ternaries) is dead and should be dropped, leaving only the record-shaped load.
		// Same one-shot pattern as the DATA_DIR boot migration.
		for (const [team, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			// A non-composite / non-slug key was never a valid chat; skip it (a hand-edited file).
			if (!isComposite(team) || this.records.has(team)) continue;
			const { project: spawn, session: segment } = parseSessionName(team);
			if (!isSlug(spawn) || !isSlug(segment)) continue;
			const v = value as Partial<SessionRecord> & { claudeSessionId?: string; lastSeen?: number };
			const lastSeen = typeof v.lastSeen === "number" ? v.lastSeen : this.now();
			const persisted = typeof v.id === "string";
			if (!persisted && typeof v.claudeSessionId !== "string") continue;
			const label = (persisted ? sanitizeLabel(v.sessionLabel) : segment) ?? segment;
			const record: SessionRecord = {
				id: segment,
				sessionLabel: this.dedupLabel(spawn, label),
				spawn,
				workdirHint: persisted ? (sanitizeLabel(v.workdirHint) ?? undefined) : segment,
				claudeSessionId: typeof v.claudeSessionId === "string" ? v.claudeSessionId : undefined,
				confirmedAt: persisted ? (typeof v.confirmedAt === "number" ? v.confirmedAt : undefined) : lastSeen,
				lastSeen,
			};
			this.records.set(team, record);
			this.claimLabel(record);
		}
	}

	private bind(record: SessionRecord, extra: { claudeSessionId?: string; live?: LiveRef }): SessionRecord {
		if (extra.claudeSessionId) record.claudeSessionId = extra.claudeSessionId;
		if (extra.live) record.liveTeam = extra.live;
		record.lastSeen = this.now();
		return record;
	}

	private create(id: string, opts: CreateOpts): SessionRecord {
		const record: SessionRecord = {
			id,
			sessionLabel: this.dedupLabel(opts.spawn, sanitizeLabel(opts.sessionLabel) ?? id),
			spawn: opts.spawn,
			workdirHint: sanitizeLabel(opts.workdirHint) ?? undefined,
			claudeSessionId: opts.claudeSessionId,
			lastSeen: this.now(),
		};
		this.records.set(this.teamOf(record), record);
		this.claimLabel(record);
		return record;
	}

	private claimLabel(record: SessionRecord): void {
		const set = this.labels.get(record.spawn) ?? new Set<string>();
		set.add(record.sessionLabel);
		this.labels.set(record.spawn, set);
	}

	private releaseLabel(record: SessionRecord): void {
		this.labels.get(record.spawn)?.delete(record.sessionLabel);
	}

	/** Per-spawn label uniqueness via a `-#` suffix; the board groups by spawn header, so two spawns
	 * may reuse a label but one spawn may not. O(1) via the per-spawn taken-set. */
	private dedupLabel(spawn: string, label: string): string {
		const taken = this.labels.get(spawn);
		if (!taken?.has(label)) return label;
		for (let n = 2; ; n++) {
			const suffix = `-${n}`;
			// Slice on code points so a max-length label ending in an astral char stays well-formed.
			const candidate = `${[...label].slice(0, LABEL_MAX - suffix.length).join("")}${suffix}`;
			if (!taken.has(candidate)) return candidate;
		}
	}
}
