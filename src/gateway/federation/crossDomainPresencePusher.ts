// Cross-Domain presence: per-destination outbound push coalescing and retry.

import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import type { PresenceForDomain } from "./crossDomainPresenceSource.js";

type PendingPush = { sessions: PresenceForDomain; token: number };

export interface CoalescedPusher {
	push: (domainId: string, sessions: PresenceForDomain) => void;
	/** Drops every pending payload and retry. */
	stop: () => void;
	/** Drop any in-flight/pending payload for `domainId` without waiting for it to settle. This
	 * bumps that Domain's generation token (by removing its `pending` entry outright), so an
	 * ALREADY-in-flight attempt's eventual settle can tell it is stale - even if a fresh `push()`
	 * dispatches its own attempt for the same domainId before the stale one resolves. Without the
	 * token, the stale attempt's own "did a fresher payload supersede me" check (a plain `sessions`
	 * object-identity comparison) cannot distinguish that case from an in-place supersede, and would
	 * wrongly re-dispatch a second, redundant, concurrent send of whatever the fresh attempt already
	 * sent. Call when that Domain is being torn down, so a stale attempt can never coalesce away
	 * (or duplicate) a fresh cold-start push landing during a fast unlink-then-relink. */
	cancel: (domainId: string) => void;
}

/** At most one in-flight `presence_push` attempt per destination Domain; a new push arriving
 * while a prior attempt to the SAME destination is still retrying REPLACES that attempt's payload
 * rather than queuing a second one, so a stale retry can never land after a fresher one already
 * succeeded. The same coalescing design the parked same-Domain sibling feature specifies, reused
 * rather than re-invented. */
export function createCoalescedPresencePusher(
	sendOnce: (domainId: string, sessions: PresenceForDomain) => Promise<{ ok: boolean; error?: string }>,
	deps: { ambient: Pick<Ambient, "setTimer" | "clearTimer"> },
): CoalescedPusher {
	const pending = new Map<string, PendingPush>();
	const retries = new Set<TimerHandle>();
	let nextToken = 0;

	// `token` identifies which `pending` GENERATION this specific attempt() call belongs to - not
	// merely which payload. `cancel()` removes the entry without assigning its token to anything, so
	// a later `push()` for the same domainId (with no entry to mutate in place) mints a brand-new
	// token. A stale attempt's continuation then correctly recognizes "the entry I'm looking at
	// belongs to a DIFFERENT generation than the one I was dispatched for" and stops, rather than
	// misreading a cancel-then-repush as an in-place supersede of its own payload.
	function attempt(domainId: string, attemptNum: number, token: number): void {
		const entry = pending.get(domainId);
		if (!entry || entry.token !== token) return;
		const sent = entry.sessions;
		// A rejection (sendOnce is expected to always resolve, never throw) folds into the SAME
		// {ok:false} shape .then() already handles below, so a superseded payload is retried
		// identically whether the in-flight attempt failed by resolving false or by throwing.
		void sendOnce(domainId, sent)
			.catch((err) => ({
				ok: false,
				error: `threw: ${err instanceof Error ? err.message : String(err)}`,
			}))
			.then((r) => {
				const cur = pending.get(domainId);
				if (!cur || cur.token !== token) return;
				if (cur.sessions !== sent) {
					// Same generation, but the payload was mutated in place (a push() arrived while I was
					// in flight, with no cancel() in between) - send it now as a fresh attempt (reset
					// backoff), regardless of whether the superseded one landed.
					attempt(domainId, 0, token);
					return;
				}
				if (r.ok) {
					pending.delete(domainId);
					return;
				}
				if (attemptNum >= 4) {
					console.error(`[cross-domain-presence] push to "${domainId}" failed after retries: ${r.error}`);
					pending.delete(domainId);
					return;
				}
				const retry = deps.ambient.setTimer(
					() => {
						retries.delete(retry);
						attempt(domainId, attemptNum + 1, token);
					},
					Math.min(2000 * 2 ** attemptNum, 30_000),
				);
				retries.add(retry);
			});
	}

	return {
		stop: () => {
			for (const retry of retries) deps.ambient.clearTimer(retry);
			retries.clear();
			pending.clear();
		},
		push: (domainId, sessions) => {
			const existing = pending.get(domainId);
			if (existing) {
				existing.sessions = sessions;
				return;
			}
			const token = nextToken++;
			pending.set(domainId, { sessions, token });
			attempt(domainId, 0, token);
		},
		cancel: (domainId) => {
			pending.delete(domainId);
		},
	};
}
