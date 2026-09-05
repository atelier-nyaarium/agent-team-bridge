import type { Ambient, IntervalHandle, TimerHandle } from "../../shared/ambient.js";

export interface ShareAttestorDeps {
	shares: () => string[];
	liveJobIds: (sessionTarget: string) => string[];
	send: (action: string, params: Record<string, unknown>) => Promise<unknown>;
	incarnation: () => number | null;
	intervalMs?: number;
	/** Floor between attestations, so a burst of job changes sends one frame set, not one each. */
	minGapMs?: number;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer" | "setInterval" | "clearInterval">;
}

export function createShareAttestor(deps: ShareAttestorDeps) {
	let previousLive = new Map<string, string[]>();
	let timer: IntervalHandle | null = null;
	let coalesce: TimerHandle | null = null;
	let lastAt = Number.NEGATIVE_INFINITY;
	const now = () => deps.ambient.now();
	const minGapMs = deps.minGapMs ?? 1_000;

	/** Coalesced entry point: every caller outside the timer comes through here. */
	const attest = (): void => {
		if (coalesce) return;
		const wait = Math.max(0, minGapMs - (now() - lastAt));
		if (wait === 0) {
			send();
			return;
		}
		coalesce = deps.ambient.setTimer(() => {
			coalesce = null;
			send();
		}, wait);
	};

	const send = (): void => {
		const incarnation = deps.incarnation();
		if (incarnation === null) return;
		lastAt = now();
		const current = new Set(deps.shares());
		const currentLive = new Map<string, string[]>();
		for (const sessionTarget of new Set([...current, ...previousLive.keys()])) {
			const jobIds = deps.liveJobIds(sessionTarget);
			if (jobIds.length === 0 && !previousLive.has(sessionTarget)) continue;
			if (jobIds.length > 0) currentLive.set(sessionTarget, jobIds);
			void deps.send("share_job_live", {
				sessionTarget,
				jobIds,
				observedAt: now(),
			});
		}
		previousLive = currentLive;
	};

	// The interval re-states every live share, which is what the Router's sweep reads. It bypasses
	// the coalescing floor because it is the heartbeat, not a reaction to a change.
	const start = (): void => {
		if (timer) return;
		timer = deps.ambient.setInterval(send, deps.intervalMs ?? 60_000);
	};

	const stop = (): void => {
		if (coalesce) deps.ambient.clearTimer(coalesce);
		coalesce = null;
		if (!timer) return;
		deps.ambient.clearInterval(timer);
		timer = null;
	};

	return { attest, start, stop };
}
