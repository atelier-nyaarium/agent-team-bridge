import type { ServerWebSocket } from "bun";
import type { PlanePersistedState, PlaneRegistry } from "../shared/plane-registry.js";
import type { PresenceRow } from "../shared/presence-identity.js";
import { presenceIdentityOf } from "../shared/presence-identity.js";
import { isComposite, isSlug, parseSessionName } from "../shared/session-id.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "./wsTypes.js";

export interface WorkingState {
	working?: boolean;
	needsLogin?: boolean;
	limitBlocked?: boolean;
	limitDetail?: string;
}

export type { PresenceRow } from "../shared/presence-identity.js";

export interface PresenceFacadeDeps {
	sessionStore: SessionStore;
	registry: TeamRegistry;
	offlineCatalog: Map<string, string>;
	localGatewayId: string;
	localDomainId: () => string | null;
	displayName: () => string | null | undefined;
	isAdminDomain: () => boolean | null | undefined;
}

export class PresenceFacade {
	// All presence mutations mark the shared plane dirty.
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

	attach(planeRegistry: PlaneRegistry): void {
		// Late attachment avoids the registry and facade constructor cycle.
		this.planeRegistry = planeRegistry;
	}

	onMarkDirty(fn: () => void): void {
		this.onDirty = fn;
	}

	markDirty(): void {
		this.planeRegistry?.markDirty("presence");
		this.onDirty?.();
	}

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

	ensureBindToken(record: SessionRecord): string {
		return this.sessionStore.ensureBindToken(record);
	}

	findByMintedFrom(mintedFrom: string, spawn: string): SessionRecord | undefined {
		return this.sessionStore.findByMintedFrom(mintedFrom, spawn);
	}

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

	clearLive(team: string, subId: string): void {
		this.sessionStore.clearLive(team, subId);
		this.working.delete(team);
		this.markDirty();
	}

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

	setWorking(team: string, state: WorkingState): void {
		// Unknown working state differs from observed false.
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

	clearWorkingFor(team: string): void {
		if (this.working.delete(team)) this.markDirty();
	}

	clearAllWorking(): void {
		// Daemon loss invalidates every derived working state.
		if (this.working.size === 0) return;
		this.working.clear();
		this.markDirty();
	}

	snapshot(): PresenceRow[] {
		// Include catalog spawn points without session rows.
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

	registerPlane(restored?: PlanePersistedState): void {
		// Register only after attach so the plane reads this facade.
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
