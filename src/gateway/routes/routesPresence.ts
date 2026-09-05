import type { DiscoverCoverage } from "../../shared/console-protocol.js";
import type { HostSpawnState } from "../../shared/host-spawn.js";
import { OwnerPresenceProjectionSchema } from "../../shared/schemasRouterPresence.js";
import type { GatewayConfig, GatewaySpawnPoints, TeamInfo } from "../../shared/types.js";
import { jsonResponse } from "../routeSchemas.js";

export interface PresenceRoutesDeps {
	config: GatewayConfig;
	localDomain: string;
	// `known` separates no reply from an empty catalog.
	hostSpawnPoints?: HostSpawnState;
	routerClient?: Pick<import("../router/routerClient.js").RouterClient, "isRegistered" | "callInboxTool"> | null;
	teams: () => Response;
}

export function createPresenceRoutes({
	config,
	localDomain,
	hostSpawnPoints,
	routerClient,
	teams,
}: PresenceRoutesDeps) {
	const { localGatewayId, localDomainId } = config;

	/** This machine's one row, empty `hostSpawns` and all: that says nothing beyond host. */
	function localSpawnPoints(): GatewaySpawnPoints[] {
		// No row until a daemon has answered, which is a different answer from an empty one.
		if (!hostSpawnPoints?.known) return [];
		return [
			{
				...(localDomainId ? { domainId: localDomainId } : {}),
				gatewayId: localGatewayId,
				hostSpawns: [...hostSpawnPoints.ids],
			},
		];
	}

	/** Folds the Router projection. Coverage rides along: an unasked peer is not a silent one. */
	async function discoverFull(): Promise<{
		teams: TeamInfo[];
		coverage: DiscoverCoverage;
		spawnPoints: GatewaySpawnPoints[];
	}> {
		const local = (await teams().json()) as TeamInfo[];
		const offlineCoverage: DiscoverCoverage = { rosterKnown: false, asked: 0, answered: 0 };
		// isRegistered, not isConnected: a refused registration leaves the socket open.
		if (!routerClient?.isRegistered()) {
			return { teams: local, coverage: offlineCoverage, spawnPoints: localSpawnPoints() };
		}
		const result = await routerClient.callInboxTool("presence_read", {});
		const parsed = !result.error ? OwnerPresenceProjectionSchema.safeParse(result.result) : null;
		if (!parsed?.success) return { teams: local, coverage: offlineCoverage, spawnPoints: localSpawnPoints() };
		const linkedTeams = parsed.data.linked.flatMap((entry) =>
			entry.sessions.map(({ queueDepth, ...session }) => ({
				...session,
				domainId: entry.domainId,
				queue_depth: queueDepth,
			})),
		);
		// Keep local sessions authoritative after a lost presence write.
		const remoteRows = parsed.data.rows.filter((row) => row.gatewayId !== localGatewayId);
		const remoteSpawns = parsed.data.spawnPoints.filter((point) => point.gatewayId !== localGatewayId);
		return {
			teams: [...local, ...remoteRows, ...linkedTeams],
			coverage: parsed.data.coverage,
			spawnPoints: [...localSpawnPoints(), ...remoteSpawns],
		};
	}

	/** `?coverage=1` opts into the object form, which names this Gateway; the bare array is the rest. */
	async function discover(url?: URL): Promise<Response> {
		const full = await discoverFull();
		if (url?.searchParams.get("coverage") === "1") {
			// `spawnPoints` is deliberately not served on this route.
			const { spawnPoints: _spawnPoints, ...served } = full;
			return jsonResponse({ ...served, localGatewayId, localDomainId: localDomain });
		}
		return jsonResponse(full.teams);
	}

	return { localSpawnPoints, discoverFull, discover };
}
