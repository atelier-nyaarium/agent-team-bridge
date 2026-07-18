////////////////////////////////
//  Interfaces & Types

export interface FocusIntent {
	screen: "board" | "terminal" | "background";
	terminalTeam?: string;
	terminalRateMs?: number;
}

export interface WatchEntry {
	team: string;
	cadenceMs: number;
}

////////////////////////////////
//  Functions & Helpers

// A killed foreground app degrades to background within this window without needing a goodbye -
// "3 missed polls at the current cadence" (plan item 5), pinned to a concrete wall-clock value: a
// visible console re-polls near-continuously (LONG_POLL_HOLD_MS holds, then re-fires), so 15s is
// comfortably a few missed cycles without being so short that ordinary network jitter flaps intent.
const INTENT_TTL_MS = 15_000;
const BOARD_CADENCE_MS = 2_000;
const DEFAULT_TERMINAL_RATE_MS = 500;
const BACKGROUND_CADENCE_MS = 60_000;

////////////////////////////////
//  Class

/**
 * Resolves the peek cadence every live session should derive at, from the union of every device's
 * currently-declared focus intent - the interest-management scheduler the plan calls for: intent
 * only ever RAMPS UP the floor (background), never turns derivation off, so a session nobody is
 * watching still eventually reflects reality instead of freezing.
 *
 * Declared per DEVICE (a stable per-poll-connection id, not per-team), so multiple consoles' own
 * intents union correctly - one console viewing the board and another viewing a specific
 * terminal both ramp their respective sessions independently. A device's intent expires on its
 * own TTL; the resolver sweeps expired entries on every read rather than on a separate timer, so
 * "3 missed polls" is enforced exactly where it is measured (the query itself), never stale.
 */
export class IntentTracker {
	private readonly byDevice = new Map<string, { intent: FocusIntent; expiresAt: number }>();
	private readonly now: () => number;
	private readonly ttlMs: number;

	constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
		this.now = opts.now ?? (() => Date.now());
		this.ttlMs = opts.ttlMs ?? INTENT_TTL_MS;
	}

	/** Declare (or refresh) one device's current focus. Called on every poll that carries a
	 * `focus` field - the declaration itself IS the TTL refresh, so a live console's repeated
	 * polling keeps its intent alive with no separate heartbeat. */
	declare(deviceId: string, intent: FocusIntent): void {
		this.byDevice.set(deviceId, { intent, expiresAt: this.now() + this.ttlMs });
	}

	/** A device stopped polling with a clean signal (rare - most exits rely on the TTL) - drops
	 * its intent immediately rather than waiting out the window. */
	clear(deviceId: string): void {
		this.byDevice.delete(deviceId);
	}

	private sweep(): void {
		const t = this.now();
		for (const [id, entry] of this.byDevice) {
			if (entry.expiresAt <= t) this.byDevice.delete(id);
		}
	}

	/** The resolved cadence for one team: the fastest (minimum) interval implied by any
	 * non-expired device intent, floored at the always-present background tier. Board intent
	 * applies to every live team uniformly; terminal intent applies only to its own team. */
	cadenceFor(team: string): number {
		this.sweep();
		let best = BACKGROUND_CADENCE_MS;
		for (const { intent } of this.byDevice.values()) {
			if (intent.screen === "board") best = Math.min(best, BOARD_CADENCE_MS);
			if (intent.screen === "terminal" && intent.terminalTeam === team) {
				best = Math.min(best, intent.terminalRateMs ?? DEFAULT_TERMINAL_RATE_MS);
			}
		}
		return best;
	}

	/** The full watch-list for the daemon: every currently-live team paired with its resolved
	 * cadence. The zero-watcher floor is implicit - every team gets AT LEAST the background
	 * cadence regardless of whether any device has declared any intent at all. */
	watchList(liveTeams: readonly string[]): WatchEntry[] {
		this.sweep();
		return liveTeams.map((team) => ({ team, cadenceMs: this.cadenceFor(team) }));
	}
}
