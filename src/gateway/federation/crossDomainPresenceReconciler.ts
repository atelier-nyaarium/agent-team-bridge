import type { CrossDomainPresenceSession } from "../../shared/federation-protocol.js";

export interface CrossDomainPresenceReconcilerDeps {
	/** Enumerate linked Domains afresh on every tick. */
	linkedDomainIds: () => string[];
	/** Null means failed pull; empty means confirmed empty. */
	pull: (domainId: string) => Promise<CrossDomainPresenceSession[] | null>;
	land: (domainId: string, sessions: CrossDomainPresenceSession[]) => void;
}

export interface CrossDomainPresenceReconciler {
	tick: () => void;
	cancel: (domainId: string) => void;
}

export function createCrossDomainPresenceReconciler(
	deps: CrossDomainPresenceReconcilerDeps,
): CrossDomainPresenceReconciler {
	const { linkedDomainIds, pull, land } = deps;
	const inFlight = new Map<string, number>();
	let nextToken = 0;

	function tick(): void {
		for (const domainId of linkedDomainIds()) {
			// Skip overlapping pulls for the same Domain.
			if (inFlight.has(domainId)) continue;
			const token = nextToken++;
			inFlight.set(domainId, token);
			pull(domainId)
				.then((sessions) => {
					// Ignore stale pulls after cancellation.
					if (sessions && inFlight.get(domainId) === token) land(domainId, sessions);
				})
				.catch((err) => {
					console.warn(
						`[cross-domain-presence] backstop pull for "${domainId}" failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				})
				.finally(() => {
					if (inFlight.get(domainId) === token) inFlight.delete(domainId);
				});
		}
	}

	function cancel(domainId: string): void {
		inFlight.delete(domainId);
	}

	return { tick, cancel };
}
