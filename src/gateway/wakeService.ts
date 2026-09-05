import type { ServerWebSocket } from "bun";
import { isReservedHostSession } from "../shared/host-op.js";
import { isHostSpawn } from "../shared/host-spawn.js";
import { isComposite, parseSessionName } from "../shared/session-id.js";
import type { SessionStore } from "../shared/session-store.js";
import type { PresenceFacade } from "./presence.js";
import { decideWakeCreate, type WakeCoordinator, type WakeResult } from "./wake.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "./wsTypes.js";

export interface WakeServiceDeps {
	registry: TeamRegistry;
	sessionStore: SessionStore;
	presence: Pick<PresenceFacade, "wakeStart" | "wakeEnd" | "createStart" | "createEnd" | "mintOrReattach" | "forget">;
	wakeCoordinator: WakeCoordinator;
	isAvailableProject: (name: string) => boolean;
	knownTeamPaths: Map<string, string>;
	offlineCatalog: Map<string, string>;
	liveHostSocket: () => ServerWebSocket<WsData> | undefined;
	wakeTimeoutMs: number;
}

export class WakeService {
	private inflightWakes = new Map<string, Promise<WakeResult>>();
	// Concurrent sends for one team share a single wake.
	private inflightCreates = new Set<string>();

	constructor(private deps: WakeServiceDeps) {}

	isWakeInFlight(team: string): boolean {
		return this.inflightWakes.has(team) || this.inflightCreates.has(team);
	}

	markCreateInFlight(team: string): () => void {
		this.inflightCreates.add(team);
		this.deps.presence.createStart(team);
		return () => {
			this.inflightCreates.delete(team);
			this.deps.presence.createEnd(team);
		};
	}

	tryWakeTeam(team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }): Promise<WakeResult> {
		const existing = this.inflightWakes.get(team);
		if (existing) {
			console.log(`[wake] ${team} wake already in flight; joining it`);
			return existing;
		}
		this.deps.presence.wakeStart(team);
		// Presence lifecycle is separate from promise deduplication.
		const wake = this.doWakeTeam(team, createOpts);
		this.inflightWakes.set(team, wake);
		void wake
			.catch(() => {})
			.finally(() => {
				this.inflightWakes.delete(team);
				this.deps.presence.wakeEnd(team);
			});
		return wake;
	}

	private async doWakeTeam(
		team: string,
		createOpts: { displayLabel?: string; mintedFrom?: string } = {},
	): Promise<WakeResult> {
		const { project, session } = parseSessionName(team);
		if (this.deps.isAvailableProject(project) && (!isComposite(team) || !this.deps.offlineCatalog.has(project))) {
			console.log(`[wake] ${team} is a spawn-point project, not a session; not waking`);
			return { ok: false };
		}

		if (resolveLiveIncarnation(this.deps.registry, this.deps.sessionStore, team)) {
			console.log(`[wake] ${team} already has a live incarnation; not waking`);
			return { ok: true };
		}

		if (isHostSpawn(project) && isReservedHostSession(session)) {
			console.log(`[wake] ${team} is a reserved host session; not waking`);
			return { ok: false };
		}
		let pendingMintLabel: string | undefined;
		if (isComposite(team)) {
			const decision = decideWakeCreate(
				team,
				this.deps.sessionStore.getByTeam(team) != null,
				createOpts.displayLabel,
			);
			if (decision.kind === "refuse") {
				console.log(`[wake] ${team} has no record and no displayLabel; refusing to adopt the typed name`);
				return { ok: false, error: decision.error };
			}
			if (decision.kind === "mint" && isHostSpawn(project)) {
				// Only authenticated create_session may mint host sessions.
				console.log(`[wake] refusing to mint host session "${team}" - create_session owns that door`);
				return { ok: false, error: `no session named "${team}"; create it from the console first` };
			}
			if (decision.kind === "mint") pendingMintLabel = decision.sessionLabel;
		}

		const hostWs = this.deps.liveHostSocket();

		if (!hostWs) {
			console.log(`[wake] cannot wake ${team} - host is not connected`);
			return { ok: false, errorKind: "disconnected" };
		}

		let provisionalCreated = false;
		let wakeTeam = team;
		if (pendingMintLabel !== undefined) {
			const minted = this.deps.presence.mintOrReattach({
				spawn: project,
				sessionLabel: pendingMintLabel,
				workdirHint: pendingMintLabel,
				mintedFrom: createOpts.mintedFrom,
			});
			provisionalCreated = minted.created;
			wakeTeam = this.deps.sessionStore.teamOf(minted.record);
		}

		const projectPath = this.deps.offlineCatalog.get(project) ?? this.deps.knownTeamPaths.get(project);
		const record = this.deps.sessionStore.getByTeam(wakeTeam);
		const resumeSessionId = record?.claudeSessionId;
		const workdirHint = record ? this.deps.sessionStore.hostWorkdirHint(record) : undefined;
		hostWs.send(
			JSON.stringify({
				type: "wake",
				team: wakeTeam,
				...(projectPath ? { projectPath } : {}),
				...(resumeSessionId ? { resumeSessionId } : {}),
				...(workdirHint ? { workdirHint } : {}),
				...(record ? { sessionToken: this.deps.sessionStore.ensureBindToken(record) } : {}),
			}),
		);

		console.log(`[wake] requesting ${wakeTeam} startup${projectPath ? ` (${projectPath})` : " (convention)"}`);

		const result = await this.deps.wakeCoordinator.waitFor(wakeTeam, this.deps.wakeTimeoutMs);
		console.log(`[wake] ${wakeTeam} ${result.ok ? "is now online" : "failed to come online"}`);
		if (!result.ok && provisionalCreated) {
			// Remove provisional records when the wake never comes online.
			const rec = this.deps.sessionStore.getByTeam(wakeTeam);
			if (
				rec &&
				rec.confirmedAt === undefined &&
				!resolveLiveIncarnation(this.deps.registry, this.deps.sessionStore, wakeTeam)
			) {
				this.deps.presence.forget(wakeTeam);
			}
		}
		return wakeTeam !== team ? { ...result, resolvedTeam: wakeTeam } : result;
	}
}
