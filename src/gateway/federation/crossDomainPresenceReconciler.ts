// Cross-Domain presence: backstop pull, decoupled from the console poll loop.

import type { CrossDomainPresenceSession } from "../../shared/federation-protocol.js";

export interface CrossDomainPresenceReconcilerDeps {
	/** Every currently linked Domain id, enumerated fresh on every tick - never a cached roster,
	 * same "no stale membership list" requirement the source side's own recomputeAll needs. */
	linkedDomainIds: () => string[];
	/** Pull `domainId`'s current shareable sessions from its gateway(s). Resolves `null` if every
	 * gateway for that Domain was unreachable this attempt - the caller must NOT overwrite existing
	 * landed state with emptiness on a failed pull. Resolves an array (possibly empty, if the Domain
	 * genuinely shares nothing back) once at least one of its gateways answered. */
	pull: (domainId: string) => Promise<CrossDomainPresenceSession[] | null>;
	/** Land a successful pull's result - the SAME entry point a real push uses (`land`), so a pull
	 * gets the identical rate-limit/coalesce/sanitize/cap handling with no separate code path. */
	land: (domainId: string, sessions: CrossDomainPresenceSession[]) => void;
}

export interface CrossDomainPresenceReconciler {
	/** Run one reconciliation pass: pull every currently-linked Domain not already mid-attempt. */
	tick: () => void;
	/** Cancel any in-flight pull for `domainId` so its eventual resolution cannot resurrect state a
	 * concurrent teardown just removed - mirrors `CoalescedPusher.cancel`'s own generation-token
	 * fix for the structurally identical hazard on the source side. Call from `unlinkDomain`/
	 * `untrustOwner` alongside the existing `crossDomainPresenceConsumer.teardown()` call. */
	cancel: (domainId: string) => void;
}

/**
 * The backstop pull: `presence_push` gets no long-running retry chain of its own (a failed or
 * retry-exhausted push is simply caught here a few seconds later, so the feature leans on ONE
 * recovery mechanism instead of two competing ones). Runs on its OWN cadence, fully decoupled from
 * the console's own message poll loop, so a hung/unreachable linked peer can never stall it.
 *
 * Each destination peer is guarded by an in-flight generation token (mirrors `PresenceFacade`'s own
 * `wakeInFlight` for the SKIP-if-already-attempting half, and `CoalescedPusher`'s own token for the
 * CANCEL-a-stale-attempt half): a peer still mid-attempt
 * from a prior tick is skipped, not piled onto - without this, a persistently hung peer (the
 * scenario motivating this whole feature) would accumulate one MORE overlapping relay attempt every
 * tick for as long as the underlying relay call takes to time out, reproducing the original stall
 * at the mesh level instead of fixing it. A Domain can run more than one gateway, and
 * `pull` only needs ONE to answer to resolve non-null - so an in-flight pull can still be resolving
 * (from an earlier-answering gateway) after `cancel()` was called for a Domain unlinked mid-pull;
 * the token is what lets that stale resolution recognize it is no longer current and skip `land()`,
 * rather than resurrecting state `unlinkDomain`'s `teardown()` call just removed.
 */
export function createCrossDomainPresenceReconciler(
	deps: CrossDomainPresenceReconcilerDeps,
): CrossDomainPresenceReconciler {
	const { linkedDomainIds, pull, land } = deps;
	const inFlight = new Map<string, number>();
	let nextToken = 0;

	function tick(): void {
		for (const domainId of linkedDomainIds()) {
			if (inFlight.has(domainId)) continue;
			const token = nextToken++;
			inFlight.set(domainId, token);
			pull(domainId)
				.then((sessions) => {
					// A cancel() (or, in principle, a fresh dispatch racing some other way) would have
					// removed or replaced this domainId's token - only land if THIS attempt is still
					// the current one for it.
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
