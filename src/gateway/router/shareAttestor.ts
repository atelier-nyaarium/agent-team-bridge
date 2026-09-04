export interface ShareAttestorDeps {
	shares: () => string[];
	liveJobIds: (sessionTarget: string) => string[];
	send: (action: string, params: Record<string, unknown>) => Promise<unknown>;
	incarnation: () => number | null;
	intervalMs?: number;
	/** Floor between attestations, so a burst of job changes sends one frame set, not one each. */
	minGapMs?: number;
	now?: () => number;
}

export function createShareAttestor(deps: ShareAttestorDeps) {
	let previousLive = new Map<string, string[]>();
	let timer: ReturnType<typeof setInterval> | null = null;
	let coalesce: ReturnType<typeof setTimeout> | null = null;
	let lastAt = Number.NEGATIVE_INFINITY;
	const now = deps.now ?? (() => Date.now());
	const minGapMs = deps.minGapMs ?? 1_000;

	/** Coalesced entry point: every caller outside the timer comes through here. */
	const attest = (): void => {
		if (coalesce) return;
		const wait = Math.max(0, minGapMs - (now() - lastAt));
		if (wait === 0) {
			send();
			return;
		}
		coalesce = setTimeout(() => {
			coalesce = null;
			send();
		}, wait);
		coalesce.unref?.();
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
		timer = setInterval(send, deps.intervalMs ?? 60_000);
		timer.unref?.();
	};

	const stop = (): void => {
		if (coalesce) clearTimeout(coalesce);
		coalesce = null;
		if (!timer) return;
		clearInterval(timer);
		timer = null;
	};

	return { attest, start, stop };
}
