import packageJson from "../../../package.json";
import type { PendingJobStore } from "../../shared/pending-job-store.js";
import { FEDERATION_PROTOCOL_VERSION } from "../../shared/router-protocol.js";
import type { Address } from "../../shared/session-id.js";
import type { GatewayConfig, ResponsePayload, TeamInfo } from "../../shared/types.js";
import { jsonResponse } from "../routeSchemas.js";
import type { TeamRegistry } from "../websocket.js";

export interface StatusRoutesDeps {
	config: GatewayConfig;
	registry: TeamRegistry;
	store: Pick<PendingJobStore<ResponsePayload>, "listAll" | "size">;
	routerClient?: Pick<
		import("../router/routerClient.js").RouterClient,
		"incarnation" | "acceptedOpLedgerProtocol" | "isConnected" | "isRegistered"
	> | null;
	/** The Router leaf fingerprint this Gateway pins; health reports it for the verify gate. */
	routerCertFp?: string;
	// teams() delegates to this snapshot. Optional in test harnesses.
	presence?: { snapshot(): TeamInfo[] };
	// Session records support live-incarnation resolution. Optional in test harnesses.
	sessionStore?: Pick<import("../../shared/session-store.js").SessionStore, "touchLive">;
	// Refresh the share lastSeenAt for a live local session (its canonical domain.gateway.spawn.session),.
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

	/**
	 * Every live job, which is why it is gated: a `session_id` is the credential `/poll` and
	 * `/respond` accept, and a console-originated one embeds the owner's own mailbox key, so
	 * enumerating them hands out the keys to both doors.
	 */
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

	/** The presence facade owns this computation (`presence.snapshot()`) - GET /teams and the
	 * poll response's presence plane can never disagree, since both read the same function. The
	 * two side effects the facade correctly does NOT own stay here: touching a live session's
	 * cross-Domain shares fresh (an unrelated subsystem), and touchLive's lastSeen refresh (a
	 * purely ambient field, deliberately excluded from the presence identity hash). */
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
			// Distinct from connected: a refused register leaves the socket open.
			router_registered: routerClient?.isRegistered() ?? false,
		});
	}

	return { pending, teams, health };
}
