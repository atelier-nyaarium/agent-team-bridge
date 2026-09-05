import packageJson from "../../../package.json";
import type { PendingJobStore } from "../../shared/pending-job-store.js";
import { FEDERATION_PROTOCOL_VERSION } from "../../shared/router-protocol.js";
import type { Address } from "../../shared/session-id.js";
import type { GatewayConfig, ResponsePayload, TeamInfo } from "../../shared/types.js";
import { jsonResponse } from "../routeSchemas.js";
import type { TeamRegistry } from "../wsTypes.js";

export interface StatusRoutesDeps {
	config: GatewayConfig;
	registry: TeamRegistry;
	store: Pick<PendingJobStore<ResponsePayload>, "listAll" | "size">;
	routerClient?: Pick<
		import("../router/routerClient.js").RouterClient,
		"incarnation" | "acceptedOpLedgerProtocol" | "isConnected" | "isRegistered"
	> | null;
	routerCertFp?: string;
	presence?: { snapshot(): TeamInfo[] };
	sessionStore?: Pick<import("../../shared/session-store.js").SessionStore, "touchLive">;
	touchShares?: ((sessionTarget: string) => void) | null;
	tryLocalAddress: (name: string) => Address | null;
	provedLocalSession: (req: Request) => boolean;
}

export function createStatusRoutes({
	config,
	registry,
	store,
	routerClient,
	routerCertFp,
	presence,
	sessionStore,
	touchShares,
	tryLocalAddress,
	provedLocalSession,
}: StatusRoutesDeps) {
	const { localGatewayId } = config;

	// Job rows contain session credentials.
	function pending(req: Request): Response {
		if (!provedLocalSession(req)) {
			return jsonResponse({ error: "the job list is not open to this caller" }, 403);
		}
		const list = store.listAll().map((e) => ({
			session_id: e.id,
			from: e.from,
			to: e.to,
			state: e.state,
		}));
		return jsonResponse(list);
	}

	function teams(): Response {
		const rows = presence?.snapshot() ?? [];
		for (const row of rows) {
			if (row.status !== "online" && row.status !== "verifying") continue;
			const selfAddr = tryLocalAddress(row.team);
			if (selfAddr) touchShares?.(selfAddr.canonical);
			sessionStore?.touchLive(row.team);
		}
		return jsonResponse(rows);
	}

	function health(): Response {
		return jsonResponse({
			ok: true,
			version: packageJson.version,
			gatewayId: localGatewayId,
			incarnation: routerClient?.incarnation() ?? null,
			protocolVersion: FEDERATION_PROTOCOL_VERSION,
			opLedgerProtocol: routerClient?.acceptedOpLedgerProtocol() ?? null,
			routerCertFp: routerCertFp ?? null,
			teams: registry.size,
			pending_jobs: store.size,
			router_connected: routerClient?.isConnected() ?? false,
			// Registration may be refused while the socket remains connected.
			router_registered: routerClient?.isRegistered() ?? false,
		});
	}

	return { pending, teams, health };
}
