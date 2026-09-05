import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import type { PresenceForDomain } from "./crossDomainPresenceSource.js";

type PendingPush = { sessions: PresenceForDomain; token: number };

export interface CoalescedPusher {
	push: (domainId: string, sessions: PresenceForDomain) => void;
	stop: () => void;
	/** Cancels stale retries during unlink. */
	cancel: (domainId: string) => void;
}

export function createCoalescedPresencePusher(
	sendOnce: (domainId: string, sessions: PresenceForDomain) => Promise<{ ok: boolean; error?: string }>,
	deps: { ambient: Pick<Ambient, "setTimer" | "clearTimer"> },
): CoalescedPusher {
	const pending = new Map<string, PendingPush>();
	const retries = new Set<TimerHandle>();
	let nextToken = 0;

	function attempt(domainId: string, attemptNum: number, token: number): void {
		// Tokens fence cancel-then-repush generations.
		const entry = pending.get(domainId);
		if (!entry || entry.token !== token) return;
		const sent = entry.sessions;
		void sendOnce(domainId, sent)
			.catch((err) => ({
				ok: false,
				error: `threw: ${err instanceof Error ? err.message : String(err)}`,
			}))
			.then((r) => {
				const cur = pending.get(domainId);
				if (!cur || cur.token !== token) return;
				if (cur.sessions !== sent) {
					// A newer payload resets backoff.
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
