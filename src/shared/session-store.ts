import crypto from "node:crypto";
import {
	type CodexAgentCatalog,
	CodexAgentCatalogSchema,
	type CodexPersistedAgent,
	restoreCodexAgentCatalog,
} from "./codex-thinking.js";
import { DurableStoreInstalledError } from "./durable-store.js";
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
	// Host sessions: the console-picked working directory (absolute or ~-rooted), taking precedence
	// over workdirHint. Only ever set from the owner-sealed create_session op, never from a register,
	// so path separators are safe here where the label rules forbid them.
	workdirPath?: string;
	// The AI-managed session description: the session's own agent's answer to the gateway's periodic
	// vibe check ("what is this session about, as a short phrase"). Written only by setDescription
	// (the vibe-check resolve path), never user-typed - sessionLabel stays the human-owned name.
	description?: string;
	// The harness resume id, bound at handshake-confirm; the one-record-per-transcript dedup key.
	claudeSessionId?: string;
	// The (conversationId, opId) that minted this id, set only when the id itself was gateway-minted
	// (never for a caller-supplied id). Lets a retry of the same request find its own prior record by
	// provenance instead of recomputing/re-probing anything.
	mintedFrom?: string;
	// The session's bearer binding, minted when the gateway dispatches a launch and delivered only
	// through that launch command. Minted once and never rotated: a reattach does not re-run the
	// launch command, so a re-mint would orphan an already-running session.
	bindToken?: string;
	// When a register first proved it holds bindToken. A launch dispatch cannot know whether the
	// daemon will really launch or just reattach to a live pane (which discards the launch command,
	// token export included), so a minted token is NOT proof the session ever received one. The
	// binding therefore stays inert - claimable by anyone, exactly as an unbound name - until a
	// register actually presents it, and only then does it start excluding everyone else. Without
	// this, any reattach would bind a name its live session could never claim again.
	bindActiveAt?: number;
	liveTeam?: LiveRef;
	confirmedAt?: number;
	lastSeen: number;
}

export type PersistedSessionRecord = Omit<SessionRecord, "liveTeam"> & { codexCatalog?: CodexAgentCatalog };

export type CodexCatalogCommitResult =
	| { committed: true; catalog: CodexAgentCatalog }
	| { committed: false; reason: "owner_missing" | "revision_conflict" };

export type CodexCatalogCheckpointResult =
	| { confirmed: true; catalog: CodexAgentCatalog }
	| { confirmed: false; reason: "owner_missing" | "revision_conflict" };

/** Composition-root capability for catalog mutation. Every operation snapshots the full session
 * resume envelope through the checked persistence callback before reporting confirmation. */
export interface CodexCatalogWriter {
	commit(
		owner: SessionRecord,
		expectedRevision: number,
		agents: readonly CodexPersistedAgent[],
	): CodexCatalogCommitResult;
	/** Whether the exact live revision has crossed the checked persistence barrier. */
	isDurable(owner: SessionRecord, revision: number): boolean;
	/** Rewrites an unchanged revision to confirm an installed or restored snapshot. */
	checkpoint(owner: SessionRecord, expectedRevision: number): CodexCatalogCheckpointResult;
}

/** Extra id-space the mint/adopt clash check must avoid beyond existing records: catalog project
 * names and reserved host sessions live in gateway state, so the gateway injects the predicate. */
export type ClashPredicate = (id: string) => boolean;

export interface SessionStoreOptions {
	clash?: ClashPredicate;
	now?: () => number;
	// Injectable id generator for deterministic tests; production uses 6-hex randomBytes.
	idGen?: () => string;
	// Injectable binding-token generator for deterministic tests; production uses 32-byte randomBytes.
	tokenGen?: () => string;
	codexCatalogPersistence?: {
		persistChecked: () => void;
		receiveWriter: (writer: CodexCatalogWriter) => void;
	};
}

interface CreateOpts {
	spawn: string;
	sessionLabel?: string;
	workdirHint?: string;
	workdirPath?: string;
	claudeSessionId?: string;
	mintedFrom?: string;
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

const WORKDIR_PATH_MAX = 512;
// The label's forbidden classes plus the launch-command breakout set (quotes, backtick, $,
// backslash), minus "/" which is the entire point of a path.
const WORKDIR_PATH_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}'"`$\\]/u;

/** Normalize a console-picked host workdir path (create_session's workdir): trimmed, capped on
 * code points, absolute or ~-rooted, visibly printable, free of the characters that could break
 * out of the daemon's quoted launch command (see host-op.ts isWorkdirPath, the boundary twin).
 * Returns null when unusable - a truncated path would name a different directory, so an over-long
 * one is rejected rather than sliced. */
export function sanitizeWorkdirPath(raw: string | undefined | null): string | null {
	const trimmed = (raw ?? "").trim();
	if (!trimmed || [...trimmed].length > WORKDIR_PATH_MAX) return null;
	if (!trimmed.startsWith("/") && trimmed !== "~" && !trimmed.startsWith("~/")) return null;
	if (WORKDIR_PATH_FORBIDDEN.test(trimmed)) return null;
	return trimmed;
}

const DESCRIPTION_MAX = 120;
// The label's forbidden classes minus the path separators: a description is display-only prose
// (never joined into a filesystem path), so "/" is fine; invisible/direction-warping characters are
// still stripped so an LLM answer cannot render blank or spoofed on the board.
const DESCRIPTION_STRIP = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu;

/** Normalize an agent-authored session description (the vibe-check answer): controls/invisibles
 * STRIPPED rather than rejected (an LLM phrase with a stray newline should survive as one line, not
 * vanish), whitespace collapsed, capped on code points. Returns null when nothing remains. */
export function sanitizeDescription(raw: string | undefined | null): string | null {
	const cleaned = (raw ?? "").replace(DESCRIPTION_STRIP, " ").replace(/\s+/g, " ").trim();
	const capped = [...cleaned].slice(0, DESCRIPTION_MAX).join("").trim();
	return capped || null;
}

function randomId(): string {
	return crypto.randomBytes(3).toString("hex");
}

/** The session binding secret. Unlike the 6-hex id (a display/address segment that only needs to be
 * unique within its spawn), this is guessing-resistant: it is the only thing standing between a
 * neighbouring container and this session's name. */
function randomBindToken(): string {
	return crypto.randomBytes(32).toString("hex");
}

function bindingTokensEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && crypto.timingSafeEqual(left, right);
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
	private readonly codexCatalogs = new WeakMap<SessionRecord, CodexAgentCatalog>();
	private readonly unconfirmedCodexCatalogs = new WeakMap<SessionRecord, number>();
	// Per-spawn set of taken labels, so dedup is O(1) rather than a full-store scan on every create.
	private readonly labels = new Map<string, Set<string>>();
	private readonly clash: ClashPredicate;
	private readonly now: () => number;
	private readonly idGen: () => string;
	private readonly tokenGen: () => string;

	constructor(opts: SessionStoreOptions = {}) {
		this.clash = opts.clash ?? (() => false);
		this.now = opts.now ?? (() => Date.now());
		this.idGen = opts.idGen ?? randomId;
		this.tokenGen = opts.tokenGen ?? randomBindToken;
		if (opts.codexCatalogPersistence) {
			const { persistChecked, receiveWriter } = opts.codexCatalogPersistence;
			receiveWriter({
				commit: (owner, expectedRevision, agents) =>
					this.commitCodexCatalog(owner, expectedRevision, agents, persistChecked),
				isDurable: (owner, revision) => this.isCodexCatalogDurable(owner, revision),
				checkpoint: (owner, expectedRevision) =>
					this.checkpointCodexCatalog(owner, expectedRevision, persistChecked),
			});
		}
	}

	/** The record a session token belongs to, or undefined. A token is meaningless without a record,
	 * so an unknown or ambiguous one resolves to nothing and the caller treats it as unbound. */
	recordByBindToken(token: string): SessionRecord | undefined {
		let found: SessionRecord | undefined;
		for (const record of this.records.values()) {
			if (!record.bindToken || !bindingTokensEqual(record.bindToken, token)) continue;
			if (found) return undefined;
			found = record;
		}
		return found;
	}

	/**
	 * The record's binding, minted on first use. Called ONLY where the gateway is about to have the
	 * daemon launch this session, because that launch is the sole delivery channel: a record whose
	 * session appeared on its own (a hand-launched Claude that registered and confirmed) must stay
	 * tokenless, or the gate would demand a secret nothing ever handed it. Minting here rather than
	 * at create() also gives "mint once" for free - a relaunch reuses the existing token, which is
	 * required since a reattach never re-runs the launch command.
	 */
	ensureBindToken(record: SessionRecord): string {
		if (!record.bindToken) record.bindToken = this.tokenGen();
		return record.bindToken;
	}

	/** Whether this record's binding is being enforced yet: true once some register proved it holds
	 * the token. Until then the name stays open, so a token that was minted but never delivered (a
	 * reattach) cannot lock its own session out. */
	isBindingActive(record: SessionRecord): boolean {
		return !!record.bindToken && record.bindActiveAt !== undefined;
	}

	/** Record that a register presented this record's token, arming the binding from here on. */
	activateBinding(record: SessionRecord): void {
		if (record.bindToken && record.bindActiveAt === undefined) record.bindActiveAt = this.now();
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

	/** The host workdir value the daemon resolves: a console-picked path first (workdirPath; the
	 * daemon recognizes its leading "/" or "~", which a label can never carry), else the frozen
	 * workdirHint, else the current sessionLabel. workdirHint before sessionLabel is load-bearing -
	 * rename() mutates only sessionLabel, so a renamed session's workdir must stay pinned to its
	 * original label. The one owner of this precedence so the wake and create paths cannot drift. */
	hostWorkdirHint(record: SessionRecord): string {
		return record.workdirPath ?? record.workdirHint ?? record.sessionLabel;
	}

	/** The record a composite team field names, or undefined. */
	getByTeam(team: string): SessionRecord | undefined {
		return isComposite(team) ? this.records.get(team) : undefined;
	}

	/** A validated copy of one owner's catalog. Callers cannot mutate the stored nested objects. */
	codexCatalog(owner: SessionRecord): CodexAgentCatalog | undefined {
		if (this.records.get(this.teamOf(owner)) !== owner) return undefined;
		const catalog = this.codexCatalogs.get(owner);
		return catalog ? CodexAgentCatalogSchema.parse(catalog) : undefined;
	}

	listCodexAgents(owner: SessionRecord): readonly CodexPersistedAgent[] {
		return this.codexCatalog(owner)?.agents ?? [];
	}

	private commitCodexCatalog(
		owner: SessionRecord,
		expectedRevision: number,
		agents: readonly CodexPersistedAgent[],
		persistChecked: () => void,
	): CodexCatalogCommitResult {
		if (this.records.get(this.teamOf(owner)) !== owner) return { committed: false, reason: "owner_missing" };
		const previous = this.codexCatalogs.get(owner);
		const currentRevision = previous?.revision ?? 0;
		if (currentRevision !== expectedRevision) return { committed: false, reason: "revision_conflict" };
		const previousUnconfirmedRevision = this.unconfirmedCodexCatalogs.get(owner);
		const next = CodexAgentCatalogSchema.parse({
			version: 1,
			revision: expectedRevision + 1,
			agents,
		});
		this.codexCatalogs.set(owner, next);
		try {
			persistChecked();
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) {
				this.unconfirmedCodexCatalogs.set(owner, next.revision);
			} else {
				if (previous) this.codexCatalogs.set(owner, previous);
				else this.codexCatalogs.delete(owner);
				if (previousUnconfirmedRevision === undefined) this.unconfirmedCodexCatalogs.delete(owner);
				else this.unconfirmedCodexCatalogs.set(owner, previousUnconfirmedRevision);
			}
			throw error;
		}
		this.unconfirmedCodexCatalogs.delete(owner);
		return { committed: true, catalog: CodexAgentCatalogSchema.parse(next) };
	}

	private isCodexCatalogDurable(owner: SessionRecord, revision: number): boolean {
		if (this.records.get(this.teamOf(owner)) !== owner) return false;
		return (
			this.codexCatalogs.get(owner)?.revision === revision &&
			this.unconfirmedCodexCatalogs.get(owner) !== revision
		);
	}

	private checkpointCodexCatalog(
		owner: SessionRecord,
		expectedRevision: number,
		persistChecked: () => void,
	): CodexCatalogCheckpointResult {
		if (this.records.get(this.teamOf(owner)) !== owner) return { confirmed: false, reason: "owner_missing" };
		const catalog = this.codexCatalogs.get(owner);
		if (!catalog || catalog.revision !== expectedRevision) {
			return { confirmed: false, reason: "revision_conflict" };
		}
		try {
			persistChecked();
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) {
				this.unconfirmedCodexCatalogs.set(owner, catalog.revision);
			}
			throw error;
		}
		this.unconfirmedCodexCatalogs.delete(owner);
		return { confirmed: true, catalog: CodexAgentCatalogSchema.parse(catalog) };
	}

	/** Create a record under a fresh random id. Re-rolls on any clash with an existing record in this
	 * spawn or the injected id-space; the space is 16^6 against a handful of records, so the retry cap
	 * is unreachable in practice and exists to make a broken idGen loud. The primary path for a
	 * gateway-minted create_session id (paired with mintedFrom for retry safety); also used by
	 * establishOnConfirm's tier-4 fallback (a confirming session whose segment collides with a
	 * reserved/catalog name). */
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

	/** The idempotent MINT path: when `mintedFrom` is set, reattach the record its own prior attempt
	 * already produced (a retry finding its own earlier mint by provenance, never a stranger's), else
	 * mint a fresh opaque id. `mintedFrom` absent skips the reattach check and mints outright - a
	 * caller with no provenance key of its own still goes through this ONE method rather than falling
	 * back to a second, parallel `mint()` call site. The no-caller-supplied-id counterpart to
	 * adoptOrReattach, shared by every path that wants "give me a fresh id" retry-safety: create_session's
	 * displayLabel-only branch and a send-triggered creation with nothing typed to adopt. */
	mintOrReattach(opts: CreateOpts): { record: SessionRecord; created: boolean } {
		const existing = opts.mintedFrom ? this.findByMintedFrom(opts.mintedFrom, opts.spawn) : undefined;
		if (existing) return { record: existing, created: false };
		return { record: this.mint(opts), created: true };
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

	/** The record a gateway-minted id's own (conversationId, opId) produced, scoped to a spawn. Two
	 * records sharing a mintedFrom (only reachable via a corrupted or hand-edited persisted file) is
	 * ambiguous rather than trusting either - a wrong match would silently reattach to an unrelated
	 * stranger's session. */
	findByMintedFrom(mintedFrom: string, spawn: string): SessionRecord | undefined {
		let found: SessionRecord | undefined;
		for (const record of this.records.values()) {
			if (record.mintedFrom !== mintedFrom || record.spawn !== spawn) continue;
			if (found) return undefined;
			found = record;
		}
		return found;
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

	/** Apply an AI-authored description (the vibe-check answer). Returns the description actually
	 * stored after sanitization, or null when the record is gone or nothing safe remained. Unlike
	 * rename, no dedup: two sessions may legitimately be about the same thing. */
	setDescription(team: string, raw: string): string | null {
		const record = this.records.get(team);
		const clean = sanitizeDescription(raw);
		if (!record || !clean) return null;
		record.description = clean;
		record.lastSeen = this.now();
		return clean;
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
	 * file then never carries a just-expired record. Returns the removed team keys (empty on the
	 * overwhelming majority of ticks), so a caller can both skip its presence announcement and run
	 * the per-session end-of-life hooks (the task board's trash-and-unassign) against exactly the
	 * sessions the cutoff took. */
	sweep(ttlMs: number): string[] {
		const cutoff = this.now() - ttlMs;
		const removed: string[] = [];
		for (const [team, record] of this.records) {
			if (record.lastSeen < cutoff) {
				this.releaseLabel(record);
				this.records.delete(team);
				removed.push(team);
			}
		}
		return removed;
	}

	/** The persisted shape: records keyed by their composite team, live pointers stripped (a
	 * liveTeam stamp must never survive the sockets it points at). */
	snapshot(): Record<string, PersistedSessionRecord> {
		const out: Record<string, PersistedSessionRecord> = {};
		for (const record of this.records.values()) {
			const {
				codexCatalog: _escaped,
				liveTeam: _live,
				...rest
			} = record as SessionRecord & {
				codexCatalog?: unknown;
			};
			const codexCatalog = this.codexCatalogs.get(record);
			out[this.teamOf(record)] = codexCatalog
				? { ...rest, codexCatalog: CodexAgentCatalogSchema.parse(codexCatalog) }
				: rest;
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
			const v = value as Partial<PersistedSessionRecord> & { claudeSessionId?: string; lastSeen?: number };
			const lastSeen = typeof v.lastSeen === "number" ? v.lastSeen : this.now();
			const persisted = typeof v.id === "string";
			if (!persisted && typeof v.claudeSessionId !== "string") continue;
			const label = (persisted ? sanitizeLabel(v.sessionLabel) : segment) ?? segment;
			const record: SessionRecord = {
				id: segment,
				sessionLabel: this.dedupLabel(spawn, label),
				spawn,
				workdirHint: persisted ? (sanitizeLabel(v.workdirHint) ?? undefined) : segment,
				workdirPath: persisted ? (sanitizeWorkdirPath(v.workdirPath) ?? undefined) : undefined,
				description:
					persisted && typeof v.description === "string"
						? (sanitizeDescription(v.description) ?? undefined)
						: undefined,
				claudeSessionId: typeof v.claudeSessionId === "string" ? v.claudeSessionId : undefined,
				mintedFrom: persisted && typeof v.mintedFrom === "string" ? v.mintedFrom : undefined,
				// Never re-minted here: a record restored without one belongs to a session already
				// running with no token (or none), and minting a fresh one would bind a name its live
				// session could never present. It stays unbound until something relaunches it.
				bindToken: persisted && typeof v.bindToken === "string" ? v.bindToken : undefined,
				bindActiveAt: persisted && typeof v.bindActiveAt === "number" ? v.bindActiveAt : undefined,
				confirmedAt: persisted ? (typeof v.confirmedAt === "number" ? v.confirmedAt : undefined) : lastSeen,
				lastSeen,
			};
			this.records.set(team, record);
			const codexCatalog = persisted ? restoreCodexAgentCatalog(v.codexCatalog) : undefined;
			if (codexCatalog) {
				this.codexCatalogs.set(record, codexCatalog);
				// A restored pathname is readable, but only a new checked save confirms its directory entry
				// before an acceptance receipt is acknowledged.
				this.unconfirmedCodexCatalogs.set(record, codexCatalog.revision);
			}
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
			workdirPath: sanitizeWorkdirPath(opts.workdirPath) ?? undefined,
			claudeSessionId: opts.claudeSessionId,
			mintedFrom: opts.mintedFrom,
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
