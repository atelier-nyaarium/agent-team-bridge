// Cross-Domain presence, source side: this Gateway computing what a linked friend sees of it.

import type { CrossDomainPresenceSession } from "../../shared/federation-protocol.js";
import { type PlanePersistedState, type PlaneRegistry, stableHash } from "../../shared/plane-registry.js";

/** What one linked Domain currently sees (or was last pushed) of this Gateway's sessions. */
export type PresenceForDomain = CrossDomainPresenceSession[];

/** Cap on distinct linked Domains this Gateway tracks a source-side (outbound) or consumer-side
 * (landed) presence plane for. Linking is owner-gated (a slow, deliberate, human-paced action via
 * the enroll ceremony) rather than attacker-forceable the way an unauthenticated input is, so this
 * is primarily a performance/sanity bound - mirrors readAnchors.ts's MAX_TEAMS_PER_OWNER as this
 * codebase's established order of magnitude for a per-relationship cap. A genuinely NEW Domain
 * beyond the cap is refused a plane outright; an already-tracked Domain's own updates are
 * unaffected regardless of how many others exist. */
export const MAX_LINKED_DOMAINS_FOR_PRESENCE = 500;

export function crossDomainPresenceSourcePlaneName(domainId: string): string {
	return `presence:crossdomain-source:${domainId}`;
}

function sortSessions(sessions: PresenceForDomain): PresenceForDomain {
	return [...sessions].sort((a, b) => a.team.localeCompare(b.team) || a.gatewayId.localeCompare(b.gatewayId));
}

export interface CrossDomainPresenceSourceDeps {
	planeRegistry: PlaneRegistry;
	restoredPlanes: Record<string, PlanePersistedState> | undefined;
	/** What Domain `domainId` currently sees of this Gateway's own sessions - the exact filter
	 * `list_teams`'s cross-Domain leg already computes for pull, called fresh every time. Called up
	 * to once per currently linked-and-shared Domain (`MAX_LINKED_DOMAINS_FOR_PRESENCE`, today 500)
	 * within a SINGLE synchronous `recomputeAll()` pass - an implementation whose own underlying
	 * computation is expensive MUST memoize it across that burst itself (see `invalidatePresenceCache`
	 * below); this dependency has no way to detect or enforce that on its own. */
	presenceForDomain: (domainId: string) => PresenceForDomain;
	/** Every currently linked-and-shared Domain id - enumerated fresh by the caller on every
	 * `recomputeAll()` call, never cached here. */
	linkedAndSharedDomainIds: () => string[];
	/** Force the next `presenceForDomain` read to recompute rather than reuse a same-tick cache
	 * (routes.ts's `invalidatePresenceSnapshotCache`). Called once at the top of every
	 * `recomputeDomain`/`recomputeAll` entry so two genuinely separate mutations landing in the SAME
	 * synchronous tick (e.g. a reconnect's evict-then-confirm) each see fresh state, while the
	 * per-Domain loop WITHIN one `recomputeAll()` call still shares a single computation. */
	invalidatePresenceCache: () => void;
	/** Push the given content toward `domainId`'s gateway (the caller owns retry/coalescing). */
	push: (domainId: string, sessions: PresenceForDomain) => void;
	/** Cancel any in-flight/pending push for `domainId` (a `CoalescedPusher.cancel`) - called from
	 * `teardown()` so a stale attempt cannot coalesce away a fresh cold-start push on a fast
	 * unlink-then-relink. */
	cancelPush: (domainId: string) => void;
}

export interface CrossDomainPresenceSource {
	/** Recompute (and, on a real change, push) presence for exactly this Domain - the precise
	 * path for a mutation that names a single affected Domain (a specific-Domain share/unshare,
	 * `dropDomain`, or an unlink/untrust). A Domain touched for the very first time is registered
	 * and its current content pushed unconditionally (see the module doc on cold start); every
	 * later call just marks its plane dirty and lets the registry's own hash gate decide. */
	recomputeDomain: (domainId: string) => void;
	/** `recomputeDomain` over EVERY currently linked-and-shared Domain - the fallback path for a
	 * mutation that cannot name a single affected Domain (an everyone-trusted share/unshare, or
	 * `CrossDomainPeers`' own argument-less onChange). */
	recomputeAll: () => void;
	/** Drop a Domain's change-detector plane. Call from `unlinkDomain`/`untrustOwner`'s existing
	 * cleanup, alongside the peer/share/job drops they already do. */
	teardown: (domainId: string) => void;
}

/**
 * The source-side outbound mechanism: one internal, never-polled change-detector plane per
 * linked-and-shared-to Domain, whose only consumer is its own `onBump` callback (a push, not
 * anything a poll response ever serves directly).
 *
 * Cold start: `Plane`'s constructor seeds its baseline hash from the snapshot computed AT
 * REGISTRATION TIME, so `recompute()` can never see a brand-new plane's very first content as
 * "changed" - nothing would ever reach the peer without an explicit bypass. A plane restored from
 * a CLEAN shutdown does NOT need this bypass: `PlaneRegistry.reconcileOnBoot()` runs once, at boot,
 * strictly BEFORE federation activates and any crossdomain-source plane is ever registered (this
 * plane is always "registered late" - same situation as the pre-existing linked-peers plane - so
 * reconcileOnBoot's one-shot pass structurally can never reach it, for any Domain). The 60-second
 * tripwire is therefore the ONLY mechanism that recomputes against live state and fires `onBump`
 * normally if anything actually drifted from what was last persisted - firing the bypass
 * unconditionally on every registration would spuriously re-push unchanged content on every
 * restart. A NON-clean restore (the common case: only a graceful
 * SIGTERM/SIGINT ever persists `cleanShutdown:true`, so a crash/OOM/`docker kill` leaves the last
 * regular tick's `false`) does NOT get this rescue: `Plane`'s constructor discards the persisted
 * hash entirely and reseeds the baseline from the CURRENT snapshot instead, exactly like a
 * brand-new plane - so it needs the SAME unconditional bypass, or nothing ever corrects whatever
 * the peer cached before the crash.
 */
export function createCrossDomainPresenceSource(deps: CrossDomainPresenceSourceDeps): CrossDomainPresenceSource {
	const {
		planeRegistry,
		restoredPlanes,
		presenceForDomain,
		linkedAndSharedDomainIds,
		invalidatePresenceCache,
		push,
		cancelPush,
	} = deps;
	const registered = new Set<string>();

	/** Shared body for recomputeDomain/recomputeAll below, taking the CURRENT linked-and-shared set
	 * as a parameter rather than re-deriving it - recomputeAll already has one (from its own single
	 * upfront call) and would otherwise pay for a fresh O(Domains * (peers + shares)) enumeration
	 * once per Domain in its own loop (an O(N) pass turning into O(N^2)), on a path wired to fire on
	 * essentially every local presence mutation. */
	function recomputeDomainIn(domainId: string, linked: ReadonlySet<string>): void {
		if (!linked.has(domainId)) {
			// Not linked-and-shared (any longer, or ever) - most commonly a same-tick side effect of
			// the very unlink/unshare/untrust that made it so (e.g. dropDomain's onChange firing this
			// before the caller's own teardown() call runs). Tear down rather than register or push a
			// plane for a Domain relationship that does not currently exist - registering one here
			// would resurrect a zombie plane right after (or instead of) a legitimate teardown.
			teardown(domainId);
			return;
		}
		const name = crossDomainPresenceSourcePlaneName(domainId);
		if (!registered.has(domainId)) {
			if (registered.size >= MAX_LINKED_DOMAINS_FOR_PRESENCE) {
				console.warn(
					`[cross-domain-presence] refusing a new source plane for "${domainId}" - at the ${MAX_LINKED_DOMAINS_FOR_PRESENCE}-Domain cap`,
				);
				return;
			}
			registered.add(domainId);
			const restored = restoredPlanes?.[name];
			planeRegistry.registerPlane(
				{
					name,
					snapshot: () => sortSessions(presenceForDomain(domainId)),
					identityOf: (snapshot) => stableHash(snapshot),
					onBump: () => push(domainId, sortSessions(presenceForDomain(domainId))),
				},
				restored,
			);
			// A plane restored from a CLEAN shutdown trusts its persisted hash as the comparison
			// baseline (Plane's own constructor), so a genuine drift is caught by the 60-second
			// tripwire like any other bump (registered strictly after reconcileOnBoot's one-shot pass
			// already ran, so that pass never reaches this plane) - no bypass needed. Anything else
			// (nothing restored at all, or restored but NOT a clean shutdown) reseeds the baseline
			// from the CURRENT snapshot instead (same Plane constructor), which can never see its own
			// seed content as "changed" - so both cases need this unconditional bypass, not just the
			// brand-new one.
			if (!restored?.cleanShutdown) push(domainId, sortSessions(presenceForDomain(domainId)));
			return;
		}
		planeRegistry.markDirty(name);
	}

	function recomputeDomain(domainId: string): void {
		invalidatePresenceCache();
		recomputeDomainIn(domainId, new Set(linkedAndSharedDomainIds()));
	}

	function recomputeAll(): void {
		invalidatePresenceCache();
		const linked = new Set(linkedAndSharedDomainIds());
		for (const domainId of linked) recomputeDomainIn(domainId, linked);
	}

	function teardown(domainId: string): void {
		// Drop any in-flight/retrying push for this Domain FIRST - otherwise a fast unlink-then-
		// relink's fresh cold-start push (below) would silently coalesce behind the stale attempt
		// instead of sending, until that stale attempt eventually settles (up to the relay timeout).
		cancelPush(domainId);
		// A restoredPlanes entry only ever represents state as of THIS PROCESS'S boot. Once torn
		// down, any later re-registration (a same-process unlink then relink) is a genuinely fresh
		// grant, not a restart continuity - deleting the entry here stops recomputeDomain's clean-
		// shutdown check above from mistaking stale boot-time data for it.
		if (restoredPlanes) delete restoredPlanes[crossDomainPresenceSourcePlaneName(domainId)];
		// Unconditional, never gated on `registered.delete(domainId)`'s own return value (mirrors the
		// consumer side's own teardown) - `registered` and the registry's actual plane set are meant
		// to stay in lockstep, but this method must not silently skip cleanup if they ever don't.
		// `unregisterPlane` is documented as a safe no-op when the name is not currently registered.
		registered.delete(domainId);
		planeRegistry.unregisterPlane(crossDomainPresenceSourcePlaneName(domainId));
	}

	return { recomputeDomain, recomputeAll, teardown };
}
