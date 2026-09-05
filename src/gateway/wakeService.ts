import type { ServerWebSocket } from "bun";
import { isReservedHostSession } from "../shared/host-op.js";
import { isHostSpawn } from "../shared/host-spawn.js";
import { isComposite, parseSessionName } from "../shared/session-id.js";
import type { SessionStore } from "../shared/session-store.js";
import type { PresenceFacade } from "./presence.js";
import { decideWakeCreate, type WakeCoordinator, type WakeResult } from "./wake.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "./wsTypes.js";

////////////////////////////////
//  Interfaces & Types

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

////////////////////////////////
//  Class

export class WakeService {
	// Concurrent sends to the same sleeping team must share ONE wake: two
	// parallel `devcontainer up` runs for the same project race each other and
	// both error out, failing sends whose container actually comes up.
	private inflightWakes = new Map<string, Promise<WakeResult>>();
	// create_session's relayToHost branch (a host target, or any target with no tryWakeTeam wired)
	// never touches inflightWakes above, so isWakeInFlight needs a separate signal for that branch
	// covering "launch requested" through "MCP registered" (consoleHandler.ts's create_session pairs
	// this with awaitRegister below to keep it set through the actual registration, not just the
	// host-op's own near-instant tmux-spawn ack). Tracked separately (rather than folded into
	// inflightWakes) so it never interferes with tryWakeTeam's own dedup-by-team join semantics.
	private inflightCreates = new Set<string>();

	constructor(private deps: WakeServiceDeps) {}

	/** Either half of "a launch is under way for this team". Named once so its three readers cannot
	 * drift; deliberately NOT presence's own wakeInFlight, which tracks the same thing on its own
	 * lifecycle for the presence plane. */
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
		// Presence-facade wake-in-flight tracking: a SEPARATE signal from inflightWakes below (which
		// exists purely for promise-joining) with a correlated but independently-owned lifecycle - see
		// presence.ts's own doc comment. Started only on a genuinely NEW wake (a join must not
		// re-announce what is already showing verifying).
		this.deps.presence.wakeStart(team);
		const wake = this.doWakeTeam(team, createOpts);
		this.inflightWakes.set(team, wake);
		// `.catch` before `.finally` so this cleanup-chain promise resolves; callers still receive
		// the original `wake` (unchanged) and see any rejection via their own await.
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
		// Clean break: a catalog project is a non-chat spawn-point, not a session. A send to it has no
		// destination (the daemon would launch project.<default> under a name the waiter never sees),
		// so fail fast instead of waiting out WAKE_TIMEOUT_MS. Catalog membership is the signal (a
		// dotted dir name "my.app" is still a project); named sessions are never in the catalog. A
		// definitive "no" - there is no ambiguity to wait out, so no errorKind.
		if (this.deps.isAvailableProject(project) && (!isComposite(team) || !this.deps.offlineCatalog.has(project))) {
			console.log(`[wake] ${team} is a spawn-point project, not a session; not waking`);
			return { ok: false };
		}

		// A live incarnation already serves this record - its canonical pane, or an alias re-incarnation
		// (a manual `claude --resume` under a different name) stamped as liveTeam. Routing reaches it, so
		// relaunching would spawn a duplicate on the same transcript. Report it up rather than wake.
		if (resolveLiveIncarnation(this.deps.registry, this.deps.sessionStore, team)) {
			console.log(`[wake] ${team} already has a live incarnation; not waking`);
			return { ok: true };
		}

		// A composite `project.session` resolves its container/path by the PROJECT segment (composites
		// are never in knownTeamPaths); a mapped Claude id lets the daemon `--resume` the session.
		// Never dispatch a wake that would relaunch over the host-daemon's own supervisor pane (the
		// daemon refuses it too; this stops the wake message at the source).
		if (isHostSpawn(project) && isReservedHostSession(session)) {
			console.log(`[wake] ${team} is a reserved host session; not waking`);
			return { ok: false };
		}
		// A send-woken composite with an existing record just reattaches (idempotent - a re-wake lands
		// on the same record, and a displayLabel is ignored - the target is addressed, not (re)created).
		// One with no record yet is a genuine creation: a displayLabel mints a fresh opaque id under the
		// addressed spawn (the SAME mint-and-provenance path create_session uses, via mintOrReattach -
		// mintedFrom lets a retry sharing the same provenance key reattach instead of minting again)
		// rather than adopting the typed segment as-is - no silent typed-text-becomes-the-id. No
		// displayLabel refuses outright rather than adopt. The decision itself is pure and side-effect-
		// free, so it is checked BEFORE the host-connectivity check below (a doomed-either-way send gets
		// the more specific, more actionable reason) - but the actual mint is DEFERRED until after that
		// check passes, so a disconnected host can never leave a freshly-minted, never-to-be-woken record
		// behind (the rollback below only runs once a wake was actually attempted). Minting means the
		// address actually launched is NOT necessarily the one the caller typed - wakeTeam tracks the
		// real one, and the caller must address that for everything downstream of this wake. A bare
		// (non-composite) wake keeps the legacy convention and gets no record either way.
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
			// A send never creates a session on the host MACHINE. `/send` accepts an unbound sender, so
			// minting here would let any caller name `<hostSpawn>.<anything>` and have the daemon launch
			// it. The console's authenticated create_session is the only door to a host record.
			if (decision.kind === "mint" && isHostSpawn(project)) {
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
		// The host workdir hint: the record's hint (workdirHint ?? sessionLabel, owned by the store).
		// A devcontainer ignores the hint; a bare (non-composite, recordless) host wake has none.
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
		// Roll back a provisional record THIS wake created if the launch never came online (a bogus or
		// removed project, a dead launch), so a failed send-wake leaves no persisted phantom "available"
		// card (mirrors create_session). A record a confirm has since bound (confirmedAt set, or a live
		// incarnation) is left intact - the wake may have timed out while a slow session was confirming.
		if (!result.ok && provisionalCreated) {
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
