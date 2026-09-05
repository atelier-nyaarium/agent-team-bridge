import { z } from "zod";
import { createBurstCache } from "../shared/burst-cache.js";
import {
	type CrossDomainPresenceSession,
	type FederatedOp,
	MAX_CROSSDOMAIN_PRESENCE_SESSIONS,
} from "../shared/federation-protocol.js";
import {
	presenceForDomain as projectPresenceForDomain,
	toCrossDomainPresenceSession,
} from "../shared/presence-projection.js";
import { GatewaySpawnPointsSchema, TeamInfoSchema } from "../shared/schemas.js";
import type { Address } from "../shared/session-id.js";
import type { GatewaySpawnPoints, TeamInfo } from "../shared/types.js";

export interface PresenceExchangeDeps {
	presence?: { snapshot(): TeamInfo[] };
	sharesFor?: ((domainId: string) => string[]) | null;
	crossDomainPeers?: import("./federation/crossDomainPeers.js").CrossDomainPeers | null;
	crossDomainPresenceConsumer?:
		| import("./federation/crossDomainPresenceConsumer.js").CrossDomainPresenceConsumer
		| null;
	tryLocalAddress: (name: string) => Address | null;
	relayToGateway: (
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

const ListTeamsRelayResultSchema = z.object({
	teams: z.array(TeamInfoSchema).max(MAX_CROSSDOMAIN_PRESENCE_SESSIONS).optional(),
	spawnPoints: z.array(GatewaySpawnPointsSchema).max(64).optional(),
});

export function createPresenceExchange({
	presence,
	sharesFor,
	crossDomainPeers,
	crossDomainPresenceConsumer,
	tryLocalAddress,
	relayToGateway,
}: PresenceExchangeDeps) {
	const presenceSnapshotCache = createBurstCache<TeamInfo[]>(() => presence?.snapshot() ?? []);
	function presenceSnapshotForThisTick(): TeamInfo[] {
		return presenceSnapshotCache.get();
	}

	function invalidatePresenceSnapshotCache(): void {
		// Each top-level recompute gets a fresh snapshot.
		presenceSnapshotCache.invalidate();
	}

	function landCrossDomainPresence(srcDomainId: string, sessions: CrossDomainPresenceSession[]): void {
		crossDomainPresenceConsumer?.land(srcDomainId, sessions);
	}

	function presenceForDomain(toDomainId: string): CrossDomainPresenceSession[] {
		return projectPresenceForDomain(
			toDomainId,
			presenceSnapshotForThisTick(),
			sharesFor ?? (() => []),
			tryLocalAddress,
		);
	}

	async function pushPresenceToDomain(
		toDomainId: string,
		sessions: CrossDomainPresenceSession[],
	): Promise<{ ok: boolean; error?: string }> {
		// One attempt per gateway; the caller owns retries.
		const gateways = (crossDomainPeers?.all() ?? [])
			.filter((p) => p.friendDomainId === toDomainId)
			.map((p) => p.friendGatewayId);
		if (gateways.length === 0) return { ok: false, error: `no linked gateway for Domain "${toDomainId}"` };
		const results = await Promise.all(
			gateways.map((g) => relayToGateway(g, { kind: "presence_push", sessions }, toDomainId)),
		);
		const ok = results.some((r) => r.ok);
		return ok ? { ok: true } : { ok: false, error: results[0]?.error };
	}

	async function relayListTeams(
		dstGateway: string,
		dstDomain?: string,
	): Promise<{ ok: true; teams: TeamInfo[]; spawnPoints: GatewaySpawnPoints[] } | { ok: false; error: string }> {
		const r = await relayToGateway(dstGateway, { kind: "list_teams" }, dstDomain);
		if (!r.ok) return { ok: false, error: r.error ?? "relay failed" };
		const parsed = ListTeamsRelayResultSchema.safeParse(r.result);
		if (!parsed.success) {
			const error = `malformed list_teams reply from "${dstGateway}": ${parsed.error.message}`;
			console.warn(`[relay] ${error}`);
			return { ok: false, error };
		}
		// Peer replies remain untrusted until schema validation.
		const spawnPoints = (parsed.data.spawnPoints ?? []).filter((s) => s.gatewayId === dstGateway);
		return { ok: true, teams: parsed.data.teams ?? [], spawnPoints };
	}

	async function pullPresenceFromDomain(fromDomainId: string): Promise<CrossDomainPresenceSession[] | null> {
		// Failed pulls return null, never an empty replacement.
		const peers = (crossDomainPeers?.all() ?? []).filter((p) => p.friendDomainId === fromDomainId);
		if (peers.length === 0) return null;
		const seenGateways = new Set<string>();
		const toQuery = peers.filter((peer) => {
			if (seenGateways.has(peer.friendGatewayId)) return false;
			seenGateways.add(peer.friendGatewayId);
			return true;
		});
		const results = await Promise.all(toQuery.map((peer) => relayListTeams(peer.friendGatewayId)));
		const rows: TeamInfo[] = [];
		let anyOk = false;
		for (const r of results) {
			if (!r.ok) continue;
			anyOk = true;
			rows.push(...r.teams);
		}
		if (!anyOk) return null;
		const out: CrossDomainPresenceSession[] = [];
		for (const t of rows) {
			if (out.length >= MAX_CROSSDOMAIN_PRESENCE_SESSIONS) break;
			const session = toCrossDomainPresenceSession(t, tryLocalAddress);
			if (session) out.push(session);
		}
		return out;
	}

	return {
		presenceForDomain,
		pushPresenceToDomain,
		pullPresenceFromDomain,
		relayListTeams,
		landCrossDomainPresence,
		invalidatePresenceSnapshotCache,
	};
}
