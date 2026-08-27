import { z } from "zod";
import { createBurstCache } from "../shared/burst-cache.js";
import {
	type CrossDomainPresenceSession,
	type FederatedOp,
	MAX_CROSSDOMAIN_PRESENCE_SESSIONS,
} from "../shared/federation-protocol.js";
import { GatewaySpawnPointsSchema, TeamInfoSchema } from "../shared/schemas.js";
import type { Address } from "../shared/session-id.js";
import type { GatewaySpawnPoints, TeamInfo } from "../shared/types.js";

////////////////////////////////
//  Interfaces & Types

export interface PresenceExchangeDeps {
	/** The presence facade. Optional so a harness with no presence wiring shares nothing rather than
	 * throwing. */
	presence?: { snapshot(): TeamInfo[] };
	/** The session targets currently shared to a friend Domain. Absent when federation sharing is not
	 * wired. */
	sharesFor?: ((domainId: string) => string[]) | null;
	crossDomainPeers?: import("./federation/crossDomainPeers.js").CrossDomainPeers | null;
	/** The cross-Domain-presence landing store. Absent when federation is not wired. */
	crossDomainPresenceConsumer?: import("./federation/crossDomainPresence.js").CrossDomainPresenceConsumer | null;
	/** Null instead of throwing for a registry key that is not a session name (routes.ts's own). */
	tryLocalAddress: (name: string) => Address | null;
	relayToGateway: (
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

////////////////////////////////
//  Schemas

/** The shape every `{kind:"list_teams"}` relay reply must match before any caller trusts it as
 * typed content - capped at `MAX_CROSSDOMAIN_PRESENCE_SESSIONS` as a blanket sanity bound on how
 * much one reply can cost to process, matching the push path's own wire-level `.max()`. */
const ListTeamsRelayResultSchema = z.object({
	teams: z.array(TeamInfoSchema).max(MAX_CROSSDOMAIN_PRESENCE_SESSIONS).optional(),
	// Same-Domain peers only; a cross-Domain reply never carries it. Optional, so an older peer that
	// omits it lands as "not advertised" rather than failing the whole reply and contributing nothing.
	spawnPoints: z.array(GatewaySpawnPointsSchema).max(64).optional(),
});

////////////////////////////////
//  Functions & Helpers

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

	/** Land a linked friend's presence_push - the cross-Domain-presence landing side (mirrors
	 * consolePushOps.ts's consolePush shape and posture: local-append only, never fans out further).
	 * `srcDomainId` is the sealer-VERIFIED sender (see gatewayRelay.ts's presence_push case),
	 * never a payload-supplied value. A no-op pre-enrollment or when federation is not wired. */
	function landCrossDomainPresence(srcDomainId: string, sessions: CrossDomainPresenceSession[]): void {
		crossDomainPresenceConsumer?.land(srcDomainId, sessions);
	}

	/** Kind-filter + slug-validate + field-slice one TeamInfo row down to a CrossDomainPresenceSession
	 * - shared by `presenceForDomain` (this Gateway's own outbound rows, still needing its own
	 * `sharesFor` gate on top) and the backstop-pull reconciler (a linked peer's OWN already-shared-
	 * filtered `list_teams` response, needing no further gate). Only devcontainer/loose sessions are
	 * ever shareable (matching `gateCrossDomainTarget`'s own kind check); free-text fields are
	 * truncated - this crosses a cross-Domain trust boundary TeamInfo itself was never scoped for.
	 * `tryLocalAddress`, not the throwing `localAddress`: a row's team name is not always
	 * slug-validated at intake (an ordinary devcontainer directory name can be uppercase, contain an
	 * underscore/space, or exceed 64 chars), so an invalid one is skipped here, never an uncaught
	 * throw. Returns null for a row that fails either check. */
	function toCrossDomainPresenceSession(t: TeamInfo): CrossDomainPresenceSession | null {
		if (t.kind !== "devcontainer" && t.kind !== "loose") return null;
		if (!tryLocalAddress(t.team)) return null;
		return {
			team: t.team,
			gatewayId: t.gatewayId,
			status: t.status,
			kind: t.kind,
			sessionLabel: t.sessionLabel?.slice(0, 64),
			description: t.description?.slice(0, 120),
			lastActive: t.lastActive,
			queueDepth: t.queue_depth,
			working: t.working,
			needsLogin: t.needsLogin,
		};
	}

	/** What Domain `toDomainId` currently sees of this Gateway's own sessions - the exact
	 * `sharesFor` filter gatewayRelay.ts's list_teams case already applies for a PULL, reused
	 * here for the cross-Domain-presence PUSH (see crossDomainPresence.ts's source side). The
	 * underlying local snapshot is cached for the current synchronous tick only (see
	 * presenceSnapshotForThisTick) - never across ticks. */
	function presenceForDomain(toDomainId: string): CrossDomainPresenceSession[] {
		const local = presenceSnapshotForThisTick();
		const shared = new Set(sharesFor?.(toDomainId) ?? []);
		const out: CrossDomainPresenceSession[] = [];
		for (const t of local) {
			if (out.length >= MAX_CROSSDOMAIN_PRESENCE_SESSIONS) break;
			const addr = tryLocalAddress(t.team);
			if (!addr || !shared.has(addr.canonical)) continue;
			const session = toCrossDomainPresenceSession(t);
			if (session) out.push(session);
		}
		return out;
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
		// A peer names its OWN gatewayId in each row, so a peer claiming to speak for a third machine
		// is dropped rather than merged. Discovery asked THIS gateway a question; only its answer
		// about itself is evidence.
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
			const session = toCrossDomainPresenceSession(t);
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
