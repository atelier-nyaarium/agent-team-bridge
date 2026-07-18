import { isAgentWorking, isLoggedOut } from "../../shared/agent-screen.js";
import type { HostPeekResult, TmuxTarget } from "../../shared/host-op.js";

////////////////////////////////
//  Interfaces & Types

export interface DerivedState {
	working: boolean;
	needsLogin: boolean;
}

/** One watched session: the peek target, and how often to peek it (the max over every intent
 * currently declaring interest in it - see plan item 5; this module only consumes the resolved
 * cadence, it does not compute the intent union itself). */
export interface WatchEntry {
	team: string;
	target: TmuxTarget;
	cadenceMs: number;
}

/** Peeks a target WITHOUT the terminal view's resize side effect (plan item 4's captureNoResize) -
 * injected so this module stays testable without a real tmux process. */
export type NoResizePeek = (target: TmuxTarget) => Promise<HostPeekResult>;

////////////////////////////////
//  Functions & Helpers

////////////////////////////////
//  Class

/**
 * Per-team 2-distinct-frame hysteresis: a derived value only lands after being observed on two
 * CONSECUTIVE DISTINCT frames (by hash) - a hash-unchanged repeat peek carries no new evidence and
 * neither extends nor resets the window. One transient footer state (a flicker mid-render) cannot
 * become a confirmed flip. Pure state machine, no I/O - the scheduler feeds it frames and asks
 * whether the confirmed value changed.
 */
class HysteresisTracker {
	private lastFrameHash: string | undefined;
	private pendingHash: string | undefined;
	private pendingValue: DerivedState | undefined;
	private confirmed: DerivedState | undefined;

	/** Feed one derived observation from a freshly-captured frame. Returns the confirmed value if
	 * this observation just caused a confirmation (a genuine change to report), else undefined. */
	observe(frameHash: string, value: DerivedState): DerivedState | undefined {
		if (frameHash === this.lastFrameHash) return undefined; // repeat frame: no new evidence
		this.lastFrameHash = frameHash;

		if (sameValue(value, this.confirmed)) {
			// Already the confirmed state - a fresh frame reaffirming it resets any pending flip
			// attempt (the transient blip settled back before hysteresis could confirm it).
			this.pendingHash = undefined;
			this.pendingValue = undefined;
			return undefined;
		}
		if (this.pendingHash !== undefined && sameValue(value, this.pendingValue)) {
			// Second distinct frame agreeing with the pending value: confirmed.
			this.confirmed = value;
			this.pendingHash = undefined;
			this.pendingValue = undefined;
			return value;
		}
		// First frame observing this (different-from-confirmed) value: start the pending window.
		this.pendingHash = frameHash;
		this.pendingValue = value;
		return undefined;
	}

	/** The daemon lost its only frame source for this session (disconnect, wake-failure, a peek-
	 * failure streak) - clears to unknown and resets hysteresis, so reconnection re-derives from
	 * scratch rather than resuming a stale pending window. */
	clear(): void {
		this.lastFrameHash = undefined;
		this.pendingHash = undefined;
		this.pendingValue = undefined;
		this.confirmed = undefined;
	}
}

function sameValue(a: DerivedState, b: DerivedState | undefined): boolean {
	return b !== undefined && a.working === b.working && a.needsLogin === b.needsLogin;
}

/** Derive {working, needsLogin} from a peek result. Regex runs ONLY on kind=tmux frames -
 * container-logs boot text must never false-positive (a stray "esc" or "Not logged in" string in
 * build output is not the agent's own footer). Returns undefined for a non-tmux frame (nothing to
 * derive yet) or a hash-unchanged frame (no new evidence - the caller should not re-feed it). */
export function deriveFromPeek(peek: HostPeekResult): { hash: string; value: DerivedState } | undefined {
	if (peek.kind !== "tmux") return undefined;
	return {
		hash: peek.hash,
		value: { working: isAgentWorking(peek.ansi), needsLogin: isLoggedOut(peek.ansi) },
	};
}

/**
 * Drives the intent-driven derivation loop: peeks every watched session at its own resolved
 * cadence (independently timed, not a single shared tick), runs it through that session's
 * hysteresis tracker, and reports a confirmed change exactly once per genuine flip. Owns no
 * network I/O of its own - `peek` and `report` are injected, so this is fully unit-testable
 * without tmux or a WebSocket.
 */
export class PresenceScheduler {
	private readonly peek: NoResizePeek;
	private readonly report: (team: string, value: DerivedState | undefined) => void;
	private readonly now: () => number;
	private readonly watches = new Map<string, WatchEntry>();
	private readonly trackers = new Map<string, HysteresisTracker>();
	private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
	private readonly consecutiveFailures = new Map<string, number>();

	constructor(opts: {
		peek: NoResizePeek;
		/** Called with the confirmed DerivedState on a genuine flip, or `undefined` when derivation
		 * itself becomes impossible for this team (session-level clear - see plan's derivation-death
		 * semantics). Never called for a mere unconfirmed pending observation. */
		report: (team: string, value: DerivedState | undefined) => void;
		now?: () => number;
	}) {
		this.peek = opts.peek;
		this.report = opts.report;
		this.now = opts.now ?? (() => Date.now());
	}

	/** Replace the full watch set (the plan's intent-driven scheduler: the gateway pushes the
	 * current live-session list + each one's resolved cadence whenever either changes). A team
	 * dropped from the new set stops being peeked and clears to unknown (it can no longer be
	 * observed - not "still whatever it last was"). A team whose cadence changed reschedules at the
	 * new interval without losing its hysteresis history (a cadence ramp is not a derivation
	 * discontinuity). Returns once every newly-(re)scheduled entry's immediate first tick has run -
	 * production callers may fire-and-forget it; tests can await it for determinism. */
	setWatches(entries: WatchEntry[]): Promise<void> {
		const next = new Map(entries.map((e) => [e.team, e]));
		for (const [team] of this.watches) {
			if (!next.has(team)) this.stopWatching(team);
		}
		const initialTicks: Promise<void>[] = [];
		for (const entry of entries) {
			const existing = this.watches.get(entry.team);
			if (existing && existing.cadenceMs === entry.cadenceMs) {
				this.watches.set(entry.team, entry); // target may have changed even if cadence didn't
				continue;
			}
			this.watches.set(entry.team, entry);
			initialTicks.push(this.rescheduleTimer(entry));
		}
		return Promise.all(initialTicks).then(() => undefined);
	}

	/** Stop watching one team - used both by setWatches's drop path and directly when a session's
	 * own lifecycle ends (e.g. forgotten) independent of a watch-list refresh. */
	stopWatching(team: string): void {
		const timer = this.timers.get(team);
		if (timer) clearInterval(timer);
		this.timers.delete(team);
		this.watches.delete(team);
		this.consecutiveFailures.delete(team);
		const tracker = this.trackers.get(team);
		if (tracker) {
			tracker.clear();
			this.report(team, undefined);
		}
		this.trackers.delete(team);
	}

	/** Every watch's own daemon-level clear (host-daemon disconnect: the only frame source for
	 * every session vanished at once). Watches themselves are NOT dropped - reconnect resumes
	 * peeking the same set without needing a fresh watch-list push. */
	clearAll(): void {
		for (const team of this.trackers.keys()) this.report(team, undefined);
		for (const tracker of this.trackers.values()) tracker.clear();
	}

	private rescheduleTimer(entry: WatchEntry): Promise<void> {
		const existingTimer = this.timers.get(entry.team);
		if (existingTimer) clearInterval(existingTimer);
		if (!this.trackers.has(entry.team)) this.trackers.set(entry.team, new HysteresisTracker());
		const timer = setInterval(() => void this.tick(entry.team), entry.cadenceMs);
		timer.unref?.();
		this.timers.set(entry.team, timer);
		return this.tick(entry.team); // an immediate first peek, not a wait-out-the-cadence start
	}

	/** Fire one peek-and-derive cycle for a watched team immediately, independent of its timer -
	 * the internal auto-scheduling is a thin wrapper over this same method, so this is also the
	 * deterministic entry point for tests (no dependency on fake timers). No-op for a team that is
	 * not currently watched. */
	async tick(team: string): Promise<void> {
		const entry = this.watches.get(team);
		const tracker = this.trackers.get(team);
		if (!entry || !tracker) return; // dropped between scheduling and firing
		let peek: HostPeekResult;
		try {
			peek = await this.peek(entry.target);
		} catch {
			// A peek-failure streak (3 consecutive) clears to unknown - a single transient blip keeps
			// the last frame (matching the terminal view's own no-flicker-on-one-miss convention).
			const failures = (this.consecutiveFailures.get(team) ?? 0) + 1;
			this.consecutiveFailures.set(team, failures);
			if (failures >= 3) {
				tracker.clear();
				this.report(team, undefined);
			}
			return;
		}
		this.consecutiveFailures.set(team, 0);
		const derived = deriveFromPeek(peek);
		if (!derived) return; // container-logs (pre-pane) frame: nothing to derive yet
		const confirmed = tracker.observe(derived.hash, derived.value);
		if (confirmed) this.report(team, confirmed);
	}
}
