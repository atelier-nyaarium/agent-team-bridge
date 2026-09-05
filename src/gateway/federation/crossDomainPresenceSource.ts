import type { CrossDomainPresenceSession } from "../../shared/federation-protocol.js";
import { type PlanePersistedState, type PlaneRegistry, stableHash } from "../../shared/plane-registry.js";

export type PresenceForDomain = CrossDomainPresenceSession[];

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
	presenceForDomain: (domainId: string) => PresenceForDomain;
	linkedAndSharedDomainIds: () => string[];
	invalidatePresenceCache: () => void;
	push: (domainId: string, sessions: PresenceForDomain) => void;
	cancelPush: (domainId: string) => void;
}

export interface CrossDomainPresenceSource {
	recomputeDomain: (domainId: string) => void;
	recomputeAll: () => void;
	teardown: (domainId: string) => void;
}

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

	// Reuse the current linked set so recomputeAll stays linear.
	function recomputeDomainIn(domainId: string, linked: ReadonlySet<string>): void {
		if (!linked.has(domainId)) {
			// Tear down unlinked domains to avoid resurrecting zombie planes.
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
			// Bypass the seeded hash unless a clean restore supplies the baseline.
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
		// Cancel stale pushes before a fast relink can coalesce behind them.
		cancelPush(domainId);
		// Discard boot-time state so relinking gets a fresh baseline.
		if (restoredPlanes) delete restoredPlanes[crossDomainPresenceSourcePlaneName(domainId)];
		registered.delete(domainId);
		planeRegistry.unregisterPlane(crossDomainPresenceSourcePlaneName(domainId));
	}

	return { recomputeDomain, recomputeAll, teardown };
}
