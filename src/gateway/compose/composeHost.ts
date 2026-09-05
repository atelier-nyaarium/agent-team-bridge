// The host daemon socket and everything routed over it.

import type { ServerWebSocket } from "bun";
import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { HostOpCoordinator } from "../hostOpCoordinator.js";
import { WakeCoordinator } from "../wake.js";
import { WakeService } from "../wakeService.js";
import type { WsData } from "../wsTypes.js";
import type { SessionsStage } from "./composeSessions.js";

const HOST_OP_TIMEOUT_MS = 20_000;

export interface HostStageDeps {
	sessions: Pick<
		SessionsStage,
		| "registry"
		| "sessionStore"
		| "presence"
		| "isAvailableProject"
		| "knownTeamPaths"
		| "offlineCatalog"
		| "intentTracker"
	>;
	wakeTimeoutMs: number;
	ambient: Ambient;
}

export interface HostStage {
	liveHostSocket: () => ServerWebSocket<WsData> | undefined;
	wakeCoordinator: WakeCoordinator;
	hostOpCoordinator: HostOpCoordinator;
	wakeService: WakeService;
	relayToHost: (op: HostOp) => Promise<HostOpResult>;
	/** Re-sends the watch list; `force` re-sends an unchanged one. */
	pushPresenceWatch: (force?: boolean) => void;
	presenceWatchTimer: IntervalHandle;
}

export function composeHost({ sessions, wakeTimeoutMs, ambient }: HostStageDeps): HostStage {
	const wakeCoordinator = new WakeCoordinator(ambient);
	const hostOpCoordinator = new HostOpCoordinator(ambient);

	function liveHostSocket(): ServerWebSocket<WsData> | undefined {
		const hostSubs = sessions.registry.get("host");
		return hostSubs ? [...hostSubs.values()].find((ws) => ws.readyState === 1) : undefined;
	}

	const wakeService = new WakeService({
		registry: sessions.registry,
		sessionStore: sessions.sessionStore,
		presence: sessions.presence,
		wakeCoordinator,
		isAvailableProject: sessions.isAvailableProject,
		knownTeamPaths: sessions.knownTeamPaths,
		offlineCatalog: sessions.offlineCatalog,
		liveHostSocket,
		wakeTimeoutMs,
	});

	async function relayToHost(op: HostOp): Promise<HostOpResult> {
		const hostWs = liveHostSocket();
		if (!hostWs) return { ok: false, error: "host daemon offline - terminal unavailable" };
		const reqId = ambient.randomBytes(8).toString("hex");
		hostWs.send(JSON.stringify({ type: "host_op", reqId, op }));
		return hostOpCoordinator.wait(reqId, HOST_OP_TIMEOUT_MS);
	}

	let lastPushedWatch = "";
	function pushPresenceWatch(force = false): void {
		const hostWs = liveHostSocket();
		if (!hostWs) return;
		const liveTeams = sessions.presence
			.snapshot()
			.filter((row) => row.status === "online" || row.status === "verifying")
			.map((row) => row.team);
		const watch = sessions.intentTracker.watchList(liveTeams);
		const serialized = JSON.stringify(watch);
		if (!force && serialized === lastPushedWatch) return;
		lastPushedWatch = serialized;
		hostWs.send(JSON.stringify({ type: "presence_watch", watch }));
	}
	const presenceWatchTimer = ambient.setInterval(() => pushPresenceWatch(), 2_000);

	return {
		liveHostSocket,
		wakeCoordinator,
		hostOpCoordinator,
		wakeService,
		relayToHost,
		pushPresenceWatch,
		presenceWatchTimer,
	};
}
