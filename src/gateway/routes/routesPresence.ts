import type { DiscoverCoverage } from "../../shared/console-protocol.js";
import type { HostSpawnState } from "../../shared/host-spawn.js";
import { OwnerPresenceProjectionSchema } from "../../shared/schemasRouterPresence.js";
import type { GatewayConfig, GatewaySpawnPoints, TeamInfo } from "../../shared/types.js";
import { jsonResponse } from "../routeSchemas.js";

export interface PresenceRoutesDeps {
	config: GatewayConfig;
	localDomain: string;
	// Live daemon catalog state. `known` distinguishes no reply from an empty catalog.
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

	/** What THIS machine offers, as the one-element list every consumer merges peers into.
	 *
	 * Always a row, even when the list is empty: an empty `hostSpawns` is an affirmative "nothing
	 * beyond host", which is a different answer from a Gateway that said nothing at all, and only the
	 * row makes that distinction expressible. */
	function localSpawnPoints(): GatewaySpawnPoints[] {
		// NO ROW until a daemon has actually answered. An empty `hostSpawns` is an affirmative.
		if (!hostSpawnPoints?.known) return [];
		return [
			{
				...(localDomainId ? { domainId: localDomainId } : {}),
				gatewayId: localGatewayId,
				hostSpawns: [...hostSpawnPoints.ids],
			},
		];
	}

	/** Folds the Router projection. Coverage rides along because a peer that could not be asked and
	 * one with nothing to say are otherwise the same answer, and its sessions get swept as absent. */
	async function discoverFull(): Promise<{
		teams: TeamInfo[];
		coverage: DiscoverCoverage;
		spawnPoints: GatewaySpawnPoints[];
	}> {
		const local = (await teams().json()) as TeamInfo[];
		const offlineCoverage: DiscoverCoverage = { rosterKnown: false, asked: 0, answered: 0 };
		// isRegistered, not isConnected: a refused registration leaves the socket open, and reading.
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

	/** HTTP wrapper. The bare array is the legacy shape older plugins parse; `?coverage=1` opts into
	 * the object form. Carries this Gateway's own identity so the caller can tell ITS row from a
	 * same-named session on another machine. */
	async function discover(url?: URL): Promise<Response> {
		const full = await discoverFull();
		if (url?.searchParams.get("coverage") === "1") {
			// `spawnPoints` is destructured off and NOT served here. It is answered to a same-Domain.
			const { spawnPoints: _spawnPoints, ...served } = full;
			return jsonResponse({ ...served, localGatewayId, localDomainId: localDomain });
		}
		return jsonResponse(full.teams);
	}

	return { localSpawnPoints, discoverFull, discover };
}
