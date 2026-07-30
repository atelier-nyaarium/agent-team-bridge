import { isAgentWorking, isLoggedOut, limitNotice } from "../../shared/agent-screen.js";
import type { HostPeekResult, TmuxTarget } from "../../shared/host-op.js";

////////////////////////////////
//  Interfaces & Types

export interface DerivedState {
	working: boolean;
	needsLogin: boolean;
	/** Holding an unanswered usage-limit dialog. */
	limitBlocked: boolean;
	/** Text after the limit headline's middle dot, e.g. "resets 5pm". Undefined when not blocked, or
	 * when the headline carried no dot. */
	limitDetail?: string;
}

/** One watched session: the peek target, and how often to peek it (the max over every intent
 * currently declaring interest in it, computed elsewhere; this module only consumes the resolved
 * cadence, it does not compute the intent union itself). */
export interface WatchEntry {
	team: string;
	target: TmuxTarget;
	cadenceMs: number;
}

/** Peeks a target WITHOUT the terminal view's resize side effect,
 * injected so this module stays testable without a real tmux process. */
export type NoResizePeek = (target: TmuxTarget) => Promise<HostPeekResult>;

////////////////////////////////
//  Functions & Helpers

////////////////////////////////
//  Class

/**
 * Per-team 2-peek hysteresis: a derived value only lands after two CONSECUTIVE peeks agree on it,
 * so one transient footer state (a flicker mid-render) cannot become a confirmed flip.
 *
 * Agreement is on the derived VALUE, never on frame identity. An unchanged pane is the single most
 * important thing this tracker has to be able to confirm: an idle claude pane is byte-identical
 * capture after capture (measured - eight consecutive idle captures of a live session all hashed
 * the same, while every working capture differed), so requiring two DISTINCT frames made the flip
 * back to not-working unreachable. The pane would sit still, the pending window would never close,
 * and the board tile would pulse until something unrelated perturbed the pane - opening the
 * terminal view, whose peek resizes and reflows it. A value that survives two consecutive peeks has
 * persisted for a full cadence interval, which is exactly the evidence hysteresis is asking for,
 * whether or not the pixels moved.
 *
 * Pure state machine, no I/O - the scheduler feeds it observations and asks whether the confirmed
 * value changed.
 */
class HysteresisTracker {
	private pending: DerivedState | undefined;
	private confirmed: DerivedState | undefined;

	/** Feed one derived observation from a freshly-captured frame. Returns the confirmed value if
	 * this observation just caused a confirmation (a genuine change to report), else undefined. */
	observe(value: DerivedState): DerivedState | undefined {
		if (sameValue(value, this.confirmed)) {
			// Already the confirmed state - a fresh frame reaffirming it resets any pending flip
			// attempt (the transient blip settled back before hysteresis could confirm it).
			this.pending = undefined;
			return undefined;
		}
		if (this.pending !== undefined && sameValue(value, this.pending)) {
			// Second consecutive peek agreeing with the pending value: confirmed.
			this.confirmed = value;
			this.pending = undefined;
			return value;
		}
		// First peek observing this (different-from-confirmed) value: start the pending window.
		this.pending = value;
		return undefined;
	}

	/** The daemon lost its only frame source for this session (disconnect, wake-failure, a peek-
	 * failure streak) - clears to unknown and resets hysteresis, so reconnection re-derives from
	 * scratch rather than resuming a stale pending window. */
	clear(): void {
		this.pending = undefined;
		this.confirmed = undefined;
	}
}

function sameValue(a: DerivedState, b: DerivedState | undefined): boolean {
	return (
		b !== undefined &&
		a.working === b.working &&
		a.needsLogin === b.needsLogin &&
		a.limitBlocked === b.limitBlocked &&
		a.limitDetail === b.limitDetail
	);
}

/** Derive {working, needsLogin} from a peek result. Regex runs ONLY on kind=tmux frames -
 * container-logs boot text must never false-positive (a stray "esc" or "Not logged in" string in
 * build output is not the agent's own footer). Returns undefined for a non-tmux frame, which
 * carries nothing to derive yet. */
export function deriveFromPeek(peek: HostPeekResult): DerivedState | undefined {
	if (peek.kind !== "tmux") return undefined;
	const limit = limitNotice(peek.ansi);
	return {
		working: isAgentWorking(peek.ansi),
		needsLogin: isLoggedOut(peek.ansi),
		limitBlocked: limit !== null,
		...(limit?.detail ? { limitDetail: limit.detail } : {}),
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
		 * itself becomes impossible for this team (a session-level clear). Never called for a mere
		 * unconfirmed pending observation. */
		report: (team: string, value: DerivedState | undefined) => void;
		now?: () => number;
	}) {
		this.peek = opts.peek;
		this.report = opts.report;
		this.now = opts.now ?? (() => Date.now());
	}

	/** Replace the full watch set: the gateway pushes the
	 * current live-session list + each one's resolved cadence whenever either changes. A team
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
		const fresh = !this.trackers.has(entry.team);
		if (fresh) this.trackers.set(entry.team, new HysteresisTracker());
		const timer = setInterval(() => void this.tick(entry.team), entry.cadenceMs);
		timer.unref?.();
		this.timers.set(entry.team, timer);
		// A newly-watched team peeks immediately rather than waiting out its first cadence. A team
		// already being watched does NOT: its cadence just changed, and an extra peek right now would
		// land inside hostOpRunner's cadence floor, which would hand back the very capture the
		// previous tick already consumed - one capture counted as two agreeing peeks.
		return fresh ? this.tick(entry.team) : Promise.resolve();
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
		const confirmed = tracker.observe(derived);
		if (confirmed) this.report(team, confirmed);
	}
}
