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
	crossDomainPresenceConsumer?: import("./federation/crossDomainPresence.js").CrossDomainPresenceConsumer | null;
	tryLocalAddress: (name: string) => Address | null;
	relayToGateway: (
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

/** Validated and bounded relay reply. */
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
	// presence.snapshot() is domain-INDEPENDENT (an O(local sessions) walk + sort, per
	// presence.ts), but presenceForDomain below is invoked once per linked-and-shared Domain from
	// crossDomainPresence.ts's recomputeAll() - up to MAX_LINKED_DOMAINS_FOR_PRESENCE (500) calls
	// in one fully-synchronous pass triggered by a single, ordinary local presence mutation (any
	// session's working-state flip). createBurstCache makes that whole burst pay for one
	// computation, not one per Domain, while any OTHER, later caller (a plain GET /teams) still
	// gets a fresh one.
	const presenceSnapshotCache = createBurstCache<TeamInfo[]>(() => presence?.snapshot() ?? []);
	function presenceSnapshotForThisTick(): TeamInfo[] {
		return presenceSnapshotCache.get();
	}

	/** Force the next `presenceSnapshotForThisTick()` call to recompute rather than reuse a cached
	 * read. Two genuinely separate local presence mutations (e.g. a reconnect's evict-then-confirm)
	 * can each synchronously trigger their own `recomputeAll()` pass within the SAME tick, before the
	 * microtask that clears the cache ever runs - without this, the second pass would silently
	 * compare against the first pass's now-stale intermediate snapshot and conclude nothing changed.
	 * Called once at the start of every `recomputeAll`/`recomputeDomain` entry (crossDomainPresence.ts)
	 * so each TOP-LEVEL call sees fresh state while still sharing one computation across its own
	 * per-Domain loop. */
	function invalidatePresenceSnapshotCache(): void {
		presenceSnapshotCache.invalidate();
	}

	/** Lands verified peer presence locally without forwarding it. */
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

	/** Push this Gateway's current presenceForDomain(toDomainId) content to EVERY gateway linked
	 * peer under that Domain (a Domain may run more than one, mirroring discover()'s own "one
	 * gateway is queried once even if a Domain runs several" fan-out) - a single-shot attempt (no
	 * retry of its own; the caller, crossDomainPresence.ts's coalesced pusher, owns backoff/retry
	 * so the two retry loops never compound). Resolves ok once at least one gateway accepts it;
	 * partial delivery to a Domain's other gateway(s) is not itself a failure. Threads the
	 * explicit dstDomain through relayToGateway's 3-argument form so an ambiguous bare-gateway-id
	 * collision across two different linked Domains can never misroute it. */
	async function pushPresenceToDomain(
		toDomainId: string,
		sessions: CrossDomainPresenceSession[],
	): Promise<{ ok: boolean; error?: string }> {
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

	/** Relay a `{kind:"list_teams"}` call to `dstGateway` and validate the reply against
	 * `ListTeamsRelayResultSchema` before any caller treats it as typed content. `relayToGateway`
	 * itself returns `result` as `unknown` by design (the reply is a PEER's content, not this
	 * process's own), so every caller that reads it as `TeamInfo[]` has to remember to validate it -
	 * this is the one place that discipline lives, rather than being a convention each call site can
	 * separately forget (as `pullPresenceFromDomain` initially did). Resolves `{ok:false}` for either
	 * a relay failure OR a reply that fails validation - a version-skewed or buggy peer omitting a
	 * required field must never land as if it were a legitimate empty answer. */
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
		// A peer may report only its own gateway rows.
		const spawnPoints = (parsed.data.spawnPoints ?? []).filter((s) => s.gatewayId === dstGateway);
		return { ok: true, teams: parsed.data.teams ?? [], spawnPoints };
	}

	/** The cross-Domain-presence backstop pull: query every one of `fromDomainId`'s gateways for its
	 * OWN `list_teams` at once (a sequential await-per-gateway loop would let one hung gateway delay
	 * even STARTING the request to that Domain's other, possibly healthy, gateways by up to the full
	 * relay timeout, degrading this Domain's own backstop cadence far below the reconciler's intended
	 * 10s tick), deduped by gateway id like `discover()`'s own fan-out, converted through the same
	 * `toCrossDomainPresenceSession` filter the push side uses - no `sharesFor` gate here, since the
	 * peer's own gateway already decided what to share to this Domain before answering. Resolves
	 * `null` if every gateway for this Domain was unreachable OR answered with something that failed
	 * validation this attempt (the caller must not overwrite existing landed state with emptiness on
	 * a failed pull); an array (possibly empty, if the Domain genuinely shares nothing back) once at
	 * least one gateway answered with a valid reply. */
	async function pullPresenceFromDomain(fromDomainId: string): Promise<CrossDomainPresenceSession[] | null> {
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
