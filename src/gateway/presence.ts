import type { ServerWebSocket } from "bun";
import { type PlanePersistedState, type PlaneRegistry, stableHash } from "../shared/plane-registry.js";
import { isComposite, isSlug, parseSessionName } from "../shared/session-id.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import type { TeamInfo } from "../shared/types.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "./websocket.js";

////////////////////////////////
//  Interfaces & Types

export interface WorkingState {
	working?: boolean;
	needsLogin?: boolean;
	limitBlocked?: boolean;
	limitDetail?: string;
}

/** The gateway-internal name for a presence-plane row. TeamInfo's wire schema already carries
 * `working`/`needsLogin`/`presenceFresh` as optional fields, so this is a semantic alias, not a
 * structural extension - kept distinct so a presence-plane callsite reads as what it is. */
export type PresenceRow = TeamInfo & WorkingState & { presenceFresh?: "fresh" | "quiet" | "unreachable" };

export interface PresenceFacadeDeps {
	sessionStore: SessionStore;
	registry: TeamRegistry;
	offlineCatalog: Map<string, string>;
	localGatewayId: string;
	localDomainId: () => string | null;
	displayName: () => string | null | undefined;
	isAdminDomain: () => boolean | null | undefined;
}

////////////////////////////////
//  Functions & Helpers

/** The identity hash of a presence snapshot: every field except `lastActive` (a per-second-churn
 * timestamp that must never gate a bump - see plan ruling 2's ambient-field exclusion). Rows are
 * pre-sorted by team in `snapshot()`, so this needs no further ordering work. */
function presenceIdentityOf(rows: PresenceRow[]): string {
	return stableHash(rows.map(({ lastActive: _lastActive, ...rest }) => rest));
}

////////////////////////////////
//  Class

/**
 * The single writer over every field `GET /teams` and the presence plane read: SessionStore
 * records, the live-socket registry, wake/create in-flight state, and the derived working/
 * needsLogin map. Wraps SessionStore rather than replacing it (SessionStore stays the tested,
 * unchanged data layer); this class adds the "a mutation always marks the plane dirty" contract on
 * top, plus the presence-only concepts SessionStore has no reason to know about.
 *
 * Every route into a presence-read field goes through a method here. websocket.ts's own small,
 * fixed set of live-socket transition points (register, resolveHandshake, close, evictSocket) call
 * `markDirty()` directly at each exact site, since a WsData mutation is a raw property write with
 * no class boundary to wrap. That is still the single-writer pattern (a small closed set of
 * transition points announcing their own store's change) and not the callsite-nudge anti-pattern
 * (many scattered UI triggers remembering to refresh something else's state).
 */
export class PresenceFacade {
	private readonly sessionStore: SessionStore;
	private readonly registry: TeamRegistry;
	private readonly offlineCatalog: Map<string, string>;
	private readonly localGatewayId: string;
	private readonly localDomainId: () => string | null;
	private readonly displayName: () => string | null | undefined;
	private readonly isAdminDomain: () => boolean | null | undefined;
	private planeRegistry: PlaneRegistry | undefined;
	private onDirty?: () => void;

	private readonly wakeInFlight = new Set<string>();
	private readonly createInFlight = new Set<string>();
	private readonly working = new Map<string, WorkingState>();

	constructor(deps: PresenceFacadeDeps) {
		this.sessionStore = deps.sessionStore;
		this.registry = deps.registry;
		this.offlineCatalog = deps.offlineCatalog;
		this.localGatewayId = deps.localGatewayId;
		this.localDomainId = deps.localDomainId;
		this.displayName = deps.displayName;
		this.isAdminDomain = deps.isAdminDomain;
	}

	/** Wired once the plane registry exists (presence and the registry are constructed together in
	 * index.ts; this two-step avoids a circular constructor dependency). */
	attach(planeRegistry: PlaneRegistry): void {
		this.planeRegistry = planeRegistry;
	}

	/** Wire a secondary observer of every markDirty() call, regardless of call site - late-bound
	 * (federation activates well after this class is constructed) and optional (nothing to observe
	 * when federation is off). The cross-Domain-presence source side's hook into "this Gateway's
	 * own local presence just changed" (session/WS/wake/working-state mutations), so it never has
	 * to be scattered across this class's dozen-plus individual mutators one by one. */
	onMarkDirty(fn: () => void): void {
		this.onDirty = fn;
	}

	/** Mark the presence plane dirty. Public so websocket.ts's own live-socket transition points
	 * (raw WsData property writes with no method boundary of their own to wrap) can announce
	 * themselves; every OTHER mutation in this class calls this internally instead of requiring the
	 * caller to remember to. */
	markDirty(): void {
		this.planeRegistry?.markDirty("presence");
		this.onDirty?.();
	}

	////////////////////////////////
	//  SessionStore read passthroughs (no dirty-mark needed - a read cannot change anything). The
	//  underlying SessionStore instance itself is deliberately never exposed (no getter), so a
	//  caller cannot reach its mutators directly and bypass the dirty-marking wrappers below.

	getByTeam(team: string): SessionRecord | undefined {
		return this.sessionStore.getByTeam(team);
	}

	list(): SessionRecord[] {
		return this.sessionStore.list();
	}

	teamOf(record: SessionRecord): string {
		return this.sessionStore.teamOf(record);
	}

	resolveLive(team: string): { team: string; subId: string } | undefined {
		return this.sessionStore.resolveLive(team);
	}

	hostWorkdirHint(record: SessionRecord): string {
		return this.sessionStore.hostWorkdirHint(record);
	}

	/** Plain delegation: the binding is not presence-affecting, so minting one announces nothing. */
	ensureBindToken(record: SessionRecord): string {
		return this.sessionStore.ensureBindToken(record);
	}

	findByMintedFrom(mintedFrom: string, spawn: string): SessionRecord | undefined {
		return this.sessionStore.findByMintedFrom(mintedFrom, spawn);
	}

	////////////////////////////////
	//  SessionStore write delegation (marks dirty on every write)

	mint(opts: Parameters<SessionStore["mint"]>[0]): SessionRecord {
		const r = this.sessionStore.mint(opts);
		this.markDirty();
		return r;
	}

	adoptById(id: string, opts: Parameters<SessionStore["adoptById"]>[1]): SessionRecord | null {
		const r = this.sessionStore.adoptById(id, opts);
		if (r) this.markDirty();
		return r;
	}

	adoptOrReattach(
		id: string,
		opts: Parameters<SessionStore["adoptOrReattach"]>[1],
	): ReturnType<SessionStore["adoptOrReattach"]> {
		const r = this.sessionStore.adoptOrReattach(id, opts);
		if (r?.created) this.markDirty();
		return r;
	}

	mintOrReattach(opts: Parameters<SessionStore["mintOrReattach"]>[0]): ReturnType<SessionStore["mintOrReattach"]> {
		const r = this.sessionStore.mintOrReattach(opts);
		if (r.created) this.markDirty();
		return r;
	}

	confirm(team: string, live?: { team: string; subId: string }): SessionRecord | undefined {
		const r = this.sessionStore.confirm(team, live);
		this.markDirty();
		return r;
	}

	establishOnConfirm(
		team: string,
		args: { claudeSessionId?: string; label?: string; live: { team: string; subId: string }; handover?: boolean },
	): SessionRecord | undefined {
		const r = this.sessionStore.establishOnConfirm(team, args);
		this.markDirty();
		return r;
	}

	rename(team: string, label: string): string | null {
		const r = this.sessionStore.rename(team, label);
		this.markDirty();
		return r;
	}

	forget(team: string): boolean {
		const r = this.sessionStore.forget(team);
		this.markDirty();
		this.working.delete(team);
		return r;
	}

	/** Disconnect hook: drop a live pointer. Also clears working/needsLogin for that exact
	 * incarnation's team in the SAME write (plan's sleep semantics: no window where a session reads
	 * available/asleep while working still holds a stale live-session value). */
	clearLive(team: string, subId: string): void {
		this.sessionStore.clearLive(team, subId);
		this.working.delete(team);
		this.markDirty();
	}

	////////////////////////////////
	//  Wake / create in-flight, tracked via facade-owned enter/leave mutators, so a wake outcome -
	//  success, failure, timeout - always announces itself. The Promise-joining `inflightWakes` map
	//  in index.ts is a SEPARATE, unrelated concurrency-dedup mechanism with a correlated but
	//  independently-owned lifecycle, not replaced by this.

	wakeStart(team: string): void {
		this.wakeInFlight.add(team);
		this.markDirty();
	}

	wakeEnd(team: string): void {
		if (this.wakeInFlight.delete(team)) this.markDirty();
	}

	createStart(team: string): void {
		this.createInFlight.add(team);
		this.markDirty();
	}

	createEnd(team: string): void {
		if (this.createInFlight.delete(team)) this.markDirty();
	}

	isWakeInFlight(team: string): boolean {
		return this.wakeInFlight.has(team) || this.createInFlight.has(team);
	}

	////////////////////////////////
	//  Working / needs-login (daemon-derived; see plan item 4)

	/** Applied by the host-daemon derivation loop's report. Clears to UNKNOWN (both fields absent)
	 * distinctly from setting them false - "never observed" and "observed as not working" are
	 * different facts a tile should not conflate. */
	setWorking(team: string, state: WorkingState): void {
		const prev = this.working.get(team);
		if (
			prev?.working === state.working &&
			prev?.needsLogin === state.needsLogin &&
			prev?.limitBlocked === state.limitBlocked &&
			prev?.limitDetail === state.limitDetail
		)
			return;
		this.working.set(team, state);
		this.markDirty();
	}

	/** Session-level clear: this ONE session can no longer be peeked (socket disconnect, wake
	 * failure, a peek-failure streak), regardless of daemon health. */
	clearWorkingFor(team: string): void {
		if (this.working.delete(team)) this.markDirty();
	}

	/** Daemon-level clear: the daemon itself disconnected, so EVERY session's working/needsLogin is
	 * now unknown (it was the only frame source for all of them). */
	clearAllWorking(): void {
		if (this.working.size === 0) return;
		this.working.clear();
		this.markDirty();
	}

	////////////////////////////////
	//  Snapshot (the presence plane's content; also GET /teams's computation, unified onto one path)

	/** Every row the board shows: one per SessionStore record, plus one per catalog spawn-point
	 * project not already covered by a record under that exact name. A project's bare catalog row
	 * ("proj") and its composite session rows ("proj.main") are different team names and both
	 * appear - `seen` only guards against a genuine same-name collision, not against a project
	 * having sessions nested under it (the board renders both: a SpawnPointHeader plus its nested
	 * chats). */
	snapshot(): PresenceRow[] {
		const rows: PresenceRow[] = [];
		const seen = new Set<string>();
		const ownDisplayName = this.displayName();
		const domainId = this.localDomainId();
		const commonFields = {
			gatewayId: this.localGatewayId,
			...(domainId ? { domainId } : {}),
			...(ownDisplayName ? { displayName: ownDisplayName } : {}),
			...(this.isAdminDomain() ? { isAdminDomain: true as const } : {}),
		};

		for (const record of this.sessionStore.list()) {
			const name = this.sessionStore.teamOf(record);
			const parts = parseSessionName(name);
			if (!isComposite(name) || !isSlug(parts.project) || !isSlug(parts.session)) continue;
			seen.add(name);
			const live = resolveLiveIncarnation(this.registry, this.sessionStore, name);
			const w = this.working.get(name);
			rows.push({
				team: name,
				...commonFields,
				status: live
					? live.data.handshakeConfirmed
						? "online"
						: "verifying"
					: this.isWakeInFlight(name)
						? "verifying"
						: "available",
				...(live ? { mode: live.data.mode, version: live.data.version } : { lastActive: record.lastSeen }),
				kind: "loose",
				sessionLabel: record.sessionLabel,
				...(w?.working !== undefined ? { working: w.working } : {}),
				...(w?.needsLogin !== undefined ? { needsLogin: w.needsLogin } : {}),
				...(w?.limitBlocked !== undefined ? { limitBlocked: w.limitBlocked } : {}),
				...(w?.limitDetail !== undefined ? { limitDetail: w.limitDetail } : {}),
				queue_depth: 0,
			});
		}

		for (const [name] of this.offlineCatalog) {
			if (seen.has(name)) continue;
			seen.add(name);
			rows.push({ team: name, ...commonFields, status: "available", kind: "devcontainer", queue_depth: 0 });
		}

		rows.sort((a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : 0));
		return rows;
	}

	/** Registers the presence plane once, wired to this facade's own snapshot/identity functions.
	 * Call after `attach()`, passing this plane's own slice of whatever combined persisted blob the
	 * caller loaded (or undefined on first boot / an unrecoverable file - mints a fresh epoch). */
	registerPlane(restored?: PlanePersistedState): void {
		this.planeRegistry?.registerPlane(
			{
				name: "presence",
				snapshot: () => this.snapshot(),
				identityOf: presenceIdentityOf,
			},
			restored,
		);
	}
}

export type { TeamRegistry };
export type LiveSocket = ServerWebSocket<WsData>;
