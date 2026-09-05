import type { Clock } from "./ambient.js";
import {
	type CodexAgentCatalog,
	CodexAgentCatalogSchema,
	type CodexPersistedAgent,
	restoreCodexAgentCatalog,
} from "./codex-agent.js";
import {
	type CopilotAgentCatalog,
	CopilotAgentCatalogSchema,
	type CopilotPersistedAgent,
	restoreCopilotAgentCatalog,
} from "./copilot-agent.js";
import { DurableStoreInstalledError } from "./durable-store.js";
import { composeSessionName, isComposite, isSlug, parseSessionName } from "./session-id.js";
import { LABEL_MAX, sanitizeLabel, sanitizeWorkdirPath } from "./session-sanitize.js";
import { bindingTokensEqual, randomBindToken, randomId } from "./session-tokens.js";

////////////////////////////////
//  Interfaces & Types

/** Volatile - never persisted. */
export interface LiveRef {
	team: string;
	subId: string;
}

/** `id` need only be unique WITHIN its spawn. */
export interface SessionRecord {
	id: string;
	sessionLabel: string;
	spawn: string;
	// Host: drives ~/projects/<hint> inference.
	workdirHint?: string;
	// Host: the console-picked path, taking precedence.
	workdirPath?: string;
	// Bound at handshake-confirm: the dedup key.
	claudeSessionId?: string;
	// Set only for a gateway-minted id. Lets a retry find its own prior record.
	mintedFrom?: string;
	// Minted once, never rotated: a reattach never re-runs the launch command.
	bindToken?: string;
	// Inert until a register presents bindToken, or a reattach binds a name its own session can
	// never claim.
	bindActiveAt?: number;
	liveTeam?: LiveRef;
	confirmedAt?: number;
	lastSeen: number;
}

export type PersistedSessionRecord = Omit<SessionRecord, "liveTeam"> & {
	codexCatalog?: CodexAgentCatalog;
	copilotCatalog?: CopilotAgentCatalog;
};

export type AgentCatalogCommitResult<Catalog> =
	| { committed: true; catalog: Catalog }
	| { committed: false; reason: "owner_missing" | "revision_conflict" };

export type AgentCatalogCheckpointResult<Catalog> =
	| { confirmed: true; catalog: Catalog }
	| { confirmed: false; reason: "owner_missing" | "revision_conflict" };

export interface AgentCatalogWriter<Catalog, Agent> {
	commit(owner: SessionRecord, expectedRevision: number, agents: readonly Agent[]): AgentCatalogCommitResult<Catalog>;
	/** Crossed the checked persistence barrier. */
	isDurable(owner: SessionRecord, revision: number): boolean;
	/** Confirms an installed or restored snapshot. */
	checkpoint(owner: SessionRecord, expectedRevision: number): AgentCatalogCheckpointResult<Catalog>;
}

export type CodexCatalogCommitResult = AgentCatalogCommitResult<CodexAgentCatalog>;
export type CodexCatalogCheckpointResult = AgentCatalogCheckpointResult<CodexAgentCatalog>;
export type CodexCatalogWriter = AgentCatalogWriter<CodexAgentCatalog, CodexPersistedAgent>;
export type CopilotCatalogCommitResult = AgentCatalogCommitResult<CopilotAgentCatalog>;
export type CopilotCatalogCheckpointResult = AgentCatalogCheckpointResult<CopilotAgentCatalog>;
export type CopilotCatalogWriter = AgentCatalogWriter<CopilotAgentCatalog, CopilotPersistedAgent>;

/** Catalog names and reserved sessions live in gateway state, injected by the gateway. */
export type ClashPredicate = (id: string) => boolean;

/** Liveness is the socket registry's answer, which the store does not hold. */
export interface SweepCap {
	maxEntries: number;
	isLive: (team: string) => boolean;
}

export interface SessionStoreOptions {
	clash?: ClashPredicate;
	ambient: Clock;
	idGen?: () => string;
	tokenGen?: () => string;
	codexCatalogPersistence?: {
		persistChecked: () => void;
		receiveWriter: (writer: CodexCatalogWriter) => void;
	};
	copilotCatalogPersistence?: {
		persistChecked: () => void;
		receiveWriter: (writer: CopilotCatalogWriter) => void;
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
//  Class

/** One instance per backend, so CAS discipline cannot drift between them. */
class AgentCatalogStore<Catalog extends { revision: number }, Agent> {
	private readonly catalogs = new WeakMap<SessionRecord, Catalog>();
	private readonly unconfirmed = new WeakMap<SessionRecord, number>();

	constructor(
		private readonly parseCatalog: (candidate: unknown) => Catalog,
		private readonly ownerAlive: (owner: SessionRecord) => boolean,
	) {}

	/** Callers cannot mutate the stored nested objects. */
	get(owner: SessionRecord): Catalog | undefined {
		if (!this.ownerAlive(owner)) return undefined;
		const catalog = this.catalogs.get(owner);
		return catalog ? this.parseCatalog(catalog) : undefined;
	}

	commit(
		owner: SessionRecord,
		expectedRevision: number,
		agents: readonly Agent[],
		persistChecked: () => void,
	): AgentCatalogCommitResult<Catalog> {
		if (!this.ownerAlive(owner)) return { committed: false, reason: "owner_missing" };
		const previous = this.catalogs.get(owner);
		const currentRevision = previous?.revision ?? 0;
		if (currentRevision !== expectedRevision) return { committed: false, reason: "revision_conflict" };
		const previousUnconfirmedRevision = this.unconfirmed.get(owner);
		const next = this.parseCatalog({ version: 1, revision: expectedRevision + 1, agents });
		this.catalogs.set(owner, next);
		try {
			persistChecked();
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) {
				this.unconfirmed.set(owner, next.revision);
			} else {
				if (previous) this.catalogs.set(owner, previous);
				else this.catalogs.delete(owner);
				if (previousUnconfirmedRevision === undefined) this.unconfirmed.delete(owner);
				else this.unconfirmed.set(owner, previousUnconfirmedRevision);
			}
			throw error;
		}
		this.unconfirmed.delete(owner);
		return { committed: true, catalog: this.parseCatalog(next) };
	}

	isDurable(owner: SessionRecord, revision: number): boolean {
		if (!this.ownerAlive(owner)) return false;
		return this.catalogs.get(owner)?.revision === revision && this.unconfirmed.get(owner) !== revision;
	}

	checkpoint(
		owner: SessionRecord,
		expectedRevision: number,
		persistChecked: () => void,
	): AgentCatalogCheckpointResult<Catalog> {
		if (!this.ownerAlive(owner)) return { confirmed: false, reason: "owner_missing" };
		const catalog = this.catalogs.get(owner);
		if (!catalog || catalog.revision !== expectedRevision) {
			return { confirmed: false, reason: "revision_conflict" };
		}
		try {
			persistChecked();
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) {
				this.unconfirmed.set(owner, catalog.revision);
			}
			throw error;
		}
		this.unconfirmed.delete(owner);
		return { confirmed: true, catalog: this.parseCatalog(catalog) };
	}

	/** Readable at once, but the revision starts unconfirmed until a new save. */
	install(record: SessionRecord, catalog: Catalog): void {
		this.catalogs.set(record, catalog);
		this.unconfirmed.set(record, catalog.revision);
	}
}

/** Keyed by the composite `spawn.id`. Liveness POLICY stays with callers: the store only carries
 * liveTeam data. */
export class SessionStore {
	private readonly records = new Map<string, SessionRecord>();
	private readonly codexCatalogStore = new AgentCatalogStore<CodexAgentCatalog, CodexPersistedAgent>(
		(candidate) => CodexAgentCatalogSchema.parse(candidate),
		(owner) => this.records.get(this.teamOf(owner)) === owner,
	);
	private readonly copilotCatalogStore = new AgentCatalogStore<CopilotAgentCatalog, CopilotPersistedAgent>(
		(candidate) => CopilotAgentCatalogSchema.parse(candidate),
		(owner) => this.records.get(this.teamOf(owner)) === owner,
	);
	// O(1) dedup, not a full-store scan.
	private readonly labels = new Map<string, Set<string>>();
	private readonly clash: ClashPredicate;
	private readonly now: () => number;
	private readonly idGen: () => string;
	private readonly tokenGen: () => string;

	constructor(opts: SessionStoreOptions) {
		this.clash = opts.clash ?? (() => false);
		this.now = () => opts.ambient.now();
		this.idGen = opts.idGen ?? randomId;
		this.tokenGen = opts.tokenGen ?? randomBindToken;
		if (opts.codexCatalogPersistence) {
			const { persistChecked, receiveWriter } = opts.codexCatalogPersistence;
			receiveWriter({
				commit: (owner, expectedRevision, agents) =>
					this.codexCatalogStore.commit(owner, expectedRevision, agents, persistChecked),
				isDurable: (owner, revision) => this.codexCatalogStore.isDurable(owner, revision),
				checkpoint: (owner, expectedRevision) =>
					this.codexCatalogStore.checkpoint(owner, expectedRevision, persistChecked),
			});
		}
		if (opts.copilotCatalogPersistence) {
			const { persistChecked, receiveWriter } = opts.copilotCatalogPersistence;
			receiveWriter({
				commit: (owner, expectedRevision, agents) =>
					this.copilotCatalogStore.commit(owner, expectedRevision, agents, persistChecked),
				isDurable: (owner, revision) => this.copilotCatalogStore.isDurable(owner, revision),
				checkpoint: (owner, expectedRevision) =>
					this.copilotCatalogStore.checkpoint(owner, expectedRevision, persistChecked),
			});
		}
	}

	/** An unknown or ambiguous token resolves to nothing, treated as unbound. */
	recordByBindToken(token: string): SessionRecord | undefined {
		let found: SessionRecord | undefined;
		for (const record of this.records.values()) {
			if (!record.bindToken || !bindingTokensEqual(record.bindToken, token)) continue;
			if (found) return undefined;
			found = record;
		}
		return found;
	}

	/** Called only where the daemon is about to launch: a hand-launched session must stay tokenless.
	 * "Mint once" for free, since a reattach never re-runs the launch command. */
	ensureBindToken(record: SessionRecord): string {
		if (!record.bindToken) record.bindToken = this.tokenGen();
		return record.bindToken;
	}

	/** A minted-but-undelivered token must not lock its own session out. */
	isBindingActive(record: SessionRecord): boolean {
		return !!record.bindToken && record.bindActiveAt !== undefined;
	}

	/** Arms the binding from here on. */
	activateBinding(record: SessionRecord): void {
		if (record.bindToken && record.bindActiveAt === undefined) record.bindActiveAt = this.now();
	}

	get size(): number {
		return this.records.size;
	}

	list(): SessionRecord[] {
		return [...this.records.values()];
	}

	/** Its store key. */
	teamOf(record: SessionRecord): string {
		return composeSessionName(record.spawn, record.id);
	}

	/** hint before label is load-bearing: rename() mutates only the label, so workdir must stay
	 * pinned to the original. */
	hostWorkdirHint(record: SessionRecord): string {
		return record.workdirPath ?? record.workdirHint ?? record.sessionLabel;
	}

	getByTeam(team: string): SessionRecord | undefined {
		return isComposite(team) ? this.records.get(team) : undefined;
	}

	codexCatalog(owner: SessionRecord): CodexAgentCatalog | undefined {
		return this.codexCatalogStore.get(owner);
	}

	listCodexAgents(owner: SessionRecord): readonly CodexPersistedAgent[] {
		return this.codexCatalogStore.get(owner)?.agents ?? [];
	}

	copilotCatalog(owner: SessionRecord): CopilotAgentCatalog | undefined {
		return this.copilotCatalogStore.get(owner);
	}

	listCopilotAgents(owner: SessionRecord): readonly CopilotPersistedAgent[] {
		return this.copilotCatalogStore.get(owner)?.agents ?? [];
	}

	/** Re-rolls on clash. The retry cap is unreachable in practice; it exists to make a broken idGen
	 * loud. */
	mint(opts: CreateOpts): SessionRecord {
		for (let i = 0; i < 64; i++) {
			const id = this.idGen();
			if (!this.records.has(composeSessionName(opts.spawn, id)) && !this.clash(id)) return this.create(id, opts);
		}
		throw new Error("session id space exhausted");
	}

	/** Null when the id is taken or reserved: the caller decides bind vs mint. */
	adoptById(id: string, opts: CreateOpts): SessionRecord | null {
		if (!isSlug(id) || this.clash(id)) return null;
		if (this.records.has(composeSessionName(opts.spawn, id))) return null;
		return this.create(id, opts);
	}

	/** Adopts, else REATTACHes an already-taken id (a retry). Null when neither works: the caller
	 * refuses rather than launch a recordless session. */
	adoptOrReattach(id: string, opts: CreateOpts): { record: SessionRecord; created: boolean } | null {
		const created = this.adoptById(id, opts);
		if (created) return { record: created, created: true };
		const existing = this.records.get(composeSessionName(opts.spawn, id));
		return existing ? { record: existing, created: false } : null;
	}

	/** The no-caller-supplied-id counterpart to adoptOrReattach: reattaches by provenance when
	 * `mintedFrom` is set, else mints fresh. */
	mintOrReattach(opts: CreateOpts): { record: SessionRecord; created: boolean } {
		const existing = opts.mintedFrom ? this.findByMintedFrom(opts.mintedFrom, opts.spawn) : undefined;
		if (existing) return { record: existing, created: false };
		return { record: this.mint(opts), created: true };
	}

	/** Confirm tier 1. */
	bindBySegment(team: string, extra: { claudeSessionId?: string; live?: LiveRef } = {}): SessionRecord | null {
		const record = this.getByTeam(team);
		return record ? this.bind(record, extra) : null;
	}

	/** Read-only, so a caller can apply first-binding-holds before binding. */
	resumeRecord(claudeSessionId: string): SessionRecord | undefined {
		for (const record of this.records.values()) {
			if (record.claudeSessionId === claudeSessionId) return record;
		}
		return undefined;
	}

	/** Two records sharing a mintedFrom is ambiguous, not trusted either way. */
	findByMintedFrom(mintedFrom: string, spawn: string): SessionRecord | undefined {
		let found: SessionRecord | undefined;
		for (const record of this.records.values()) {
			if (record.mintedFrom !== mintedFrom || record.spawn !== spawn) continue;
			if (found) return undefined;
			found = record;
		}
		return found;
	}

	/** Confirm tier 2: a manual `--resume` re-incarnation. */
	bindResume(claudeSessionId: string, extra: { live?: LiveRef } = {}): SessionRecord | null {
		const record = this.resumeRecord(claudeSessionId);
		return record ? this.bind(record, { claudeSessionId, live: extra.live }) : null;
	}

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
	 * One record per Claude transcript. A bare spawn-point team returns undefined.
	 *  1. own segment names an existing record
	 *  2. the resume id matches a record
	 *  3. the segment is free -> adopt it
	 *  4. else mint a fresh id
	 */
	establishOnConfirm(
		team: string,
		{
			claudeSessionId,
			label,
			live,
			handover = false,
		}: { claudeSessionId?: string; label?: string; live: LiveRef; handover?: boolean },
	): SessionRecord | undefined {
		if (!isComposite(team)) return undefined;
		let record = this.bindBySegment(team, { claudeSessionId });
		if (!record && claudeSessionId) {
			record = this.bindResume(claudeSessionId);
			if (record && handover) {
				const previousTeam = this.teamOf(record);
				const { project: spawn, session: id } = parseSessionName(team);
				if (this.records.has(team)) return undefined;
				this.records.delete(previousTeam);
				record.spawn = spawn;
				record.id = id;
				this.records.set(team, record);
			}
		}
		if (!record) {
			const { project: spawn, session: id } = parseSessionName(team);
			record =
				this.adoptById(id, { spawn, sessionLabel: label, workdirHint: label ?? id, claudeSessionId }) ??
				this.mint({ spawn, sessionLabel: label, workdirHint: label, claudeSessionId });
		}
		return this.confirm(this.teamOf(record), live);
	}

	/** Null when the record is gone or nothing safe remained. */
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

	/** So the TTL sweep never deletes a live session. */
	touchLive(team: string): void {
		const record = this.records.get(team);
		if (record) record.lastSeen = this.now();
	}

	resolveLive(team: string): LiveRef | undefined {
		return this.records.get(team)?.liveTeam;
	}

	/** Matches BOTH fields, or a sibling sub-session could clear a still-live pointer. */
	clearLive(team: string, subId: string): void {
		for (const record of this.records.values()) {
			if (record.liveTeam?.team === team && record.liveTeam.subId === subId) record.liveTeam = undefined;
		}
	}

	/** Caller-driven, so the gateway can sweep BEFORE snapshot(): the persisted file never carries a
	 * just-expired record. Returns the removed keys, for end-of-life hooks. */
	sweep(ttlMs: number, cap?: SweepCap): string[] {
		const cutoff = this.now() - ttlMs;
		const removed: string[] = [];
		for (const [team, record] of this.records) {
			if (record.lastSeen < cutoff) {
				this.releaseLabel(record);
				this.records.delete(team);
				removed.push(team);
			}
		}
		if (!cap || this.records.size <= cap.maxEntries) return removed;
		// Least-recently-seen first, since insertion order says nothing about which record is idle.
		const evictable = [...this.records]
			.filter(([team]) => !cap.isLive(team))
			.sort((left, right) => left[1].lastSeen - right[1].lastSeen);
		for (const [team, record] of evictable) {
			if (this.records.size <= cap.maxEntries) break;
			this.releaseLabel(record);
			this.records.delete(team);
			removed.push(team);
		}
		return removed;
	}

	/** Live pointers stripped: a liveTeam stamp must never survive its sockets. */
	snapshot(): Record<string, PersistedSessionRecord> {
		const out: Record<string, PersistedSessionRecord> = {};
		for (const record of this.records.values()) {
			const {
				codexCatalog: _escaped,
				copilotCatalog: _copilotEscaped,
				liveTeam: _live,
				...rest
			} = record as SessionRecord & {
				codexCatalog?: unknown;
				copilotCatalog?: unknown;
			};
			const codexCatalog = this.codexCatalogStore.get(record);
			const copilotCatalog = this.copilotCatalogStore.get(record);
			out[this.teamOf(record)] = {
				...rest,
				...(codexCatalog ? { codexCatalog } : {}),
				...(copilotCatalog ? { copilotCatalog } : {}),
			};
		}
		return out;
	}

	/** Migrates the legacy `{claudeSessionId, lastSeen}` resume-map shape into a full record. Labels
	 * are re-sanitized and re-deduped. */
	restore(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		// TODO(post-upgrade cleanup): drop the `!persisted` legacy branch once every gateway has
		// re-written session-resume.json in the new shape.
		for (const [team, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			// Never a valid chat.
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
				claudeSessionId: typeof v.claudeSessionId === "string" ? v.claudeSessionId : undefined,
				mintedFrom: persisted && typeof v.mintedFrom === "string" ? v.mintedFrom : undefined,
				// Never re-minted here, or it binds a name its live session could never present.
				bindToken: persisted && typeof v.bindToken === "string" ? v.bindToken : undefined,
				bindActiveAt: persisted && typeof v.bindActiveAt === "number" ? v.bindActiveAt : undefined,
				confirmedAt: persisted ? (typeof v.confirmedAt === "number" ? v.confirmedAt : undefined) : lastSeen,
				lastSeen,
			};
			this.records.set(team, record);
			const codexCatalog = persisted ? restoreCodexAgentCatalog(v.codexCatalog) : undefined;
			if (codexCatalog) this.codexCatalogStore.install(record, codexCatalog);
			const copilotCatalog = persisted ? restoreCopilotAgentCatalog(v.copilotCatalog) : undefined;
			if (copilotCatalog) this.copilotCatalogStore.install(record, copilotCatalog);
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

	/** Per-spawn only: two spawns may reuse a label. */
	private dedupLabel(spawn: string, label: string): string {
		const taken = this.labels.get(spawn);
		if (!taken?.has(label)) return label;
		for (let n = 2; ; n++) {
			const suffix = `-${n}`;
			// Code points, so an astral char at the boundary stays well-formed.
			const candidate = `${[...label].slice(0, LABEL_MAX - suffix.length).join("")}${suffix}`;
			if (!taken.has(candidate)) return candidate;
		}
	}
}
