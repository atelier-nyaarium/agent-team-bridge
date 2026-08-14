import { isAgentWorking, isLoggedOut, limitNotice } from "../../shared/agent-screen.js";
import type { HostPeekResult, TmuxTarget } from "../../shared/host-op.js";

////////////////////////////////
//  Interfaces & Types

export interface DerivedState {
	working: boolean;
	/** Holding an unanswered usage-limit dialog. */
	needsLogin: boolean;
	limitBlocked: boolean;
	/** Text after the limit headline's middle dot. */
	limitDetail?: string;
}

/** One watched session. `cadenceMs` is the resolved max over every declared intent. */
export interface WatchEntry {
	team: string;
	target: TmuxTarget;
	cadenceMs: number;
}

/** Peeks without the resize side effect. Injected to stay testable. */
export type NoResizePeek = (target: TmuxTarget) => Promise<HostPeekResult>;

////////////////////////////////
//  Class

/**
 * Per-team 2-peek hysteresis, so one flicker cannot become a confirmed flip.
 *
 * Agreement is on the derived VALUE, never on frame identity. An idle pane is byte-identical capture
 * after capture, so requiring two distinct frames made the flip back to not-working unreachable.
 */
class HysteresisTracker {
	private pending: DerivedState | undefined;
	private confirmed: DerivedState | undefined;

	/** The confirmed value if this observation just confirmed it. */
	observe(value: DerivedState): DerivedState | undefined {
		if (sameValue(value, this.confirmed)) {
			// The blip settled back.
			this.pending = undefined;
			return undefined;
		}
		if (this.pending !== undefined && sameValue(value, this.pending)) {
			this.confirmed = value;
			this.pending = undefined;
			return value;
		}
		this.pending = value;
		return undefined;
	}

	/** Clear to unknown, so reconnection re-derives from scratch. */
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

/** Tmux frames only: boot text in container logs would false-positive. */
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

/** Peeks each watched session on its own timer and reports a confirmed change once per flip. */
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
		/** `undefined` means derivation became impossible, not a pending observation. */
		report: (team: string, value: DerivedState | undefined) => void;
		now?: () => number;
	}) {
		this.peek = opts.peek;
		this.report = opts.report;
		this.now = opts.now ?? (() => Date.now());
	}

	/** Replace the full watch set. A cadence change keeps its hysteresis history. Resolves once every
	 * rescheduled entry's first tick has run, which tests await. */
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

	/** Also called directly when a session's lifecycle ends. */
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

	/** Every frame source vanished at once. Watches are kept, so reconnect resumes peeking. */
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
		// Only a new team peeks now. An extra peek would land inside the cadence floor and hand back
		// the capture the last tick already consumed, counting one frame as two agreeing peeks.
		return fresh ? this.tick(entry.team) : Promise.resolve();
	}

	/** One peek-and-derive cycle, independent of the timer. Also the deterministic test entry. */
	async tick(team: string): Promise<void> {
		const entry = this.watches.get(team);
		const tracker = this.trackers.get(team);
		if (!entry || !tracker) return; // dropped between scheduling and firing
		let peek: HostPeekResult;
		try {
			peek = await this.peek(entry.target);
		} catch {
			// One blip keeps the last frame.
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
		if (!derived) return; // container-logs frame: nothing to derive yet
		const confirmed = tracker.observe(derived);
		if (confirmed) this.report(team, confirmed);
	}
}
