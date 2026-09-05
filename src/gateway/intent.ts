import type { Clock } from "../shared/ambient.js";
import { MAX_POLL_HOLD_MS } from "../shared/schemas.js";

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
// "3 missed polls at the current cadence". declare() is the TTL refresh, and it fires once per
// poll REQUEST (consoleHandler.ts's poll case), at the top of that request, before any held wait
// begins - so the gap between two refreshes from a healthy, continuously-repolling device is
// bounded by ONE FULL held-poll cycle, up to the gateway's own MAX_POLL_HOLD_MS ceiling (the
// client's chosen holdMs for a not-yet-arrived poll is unknown in advance; this ceiling is the
// authoritative worst case). Deriving the TTL from that ceiling, not a guessed flat literal, is
// what keeps "3 missed polls" true regardless of how long a single held cycle runs - a flat 15s
// value undershoots a single normal ~40-45s hold entirely, which would flap the cadence down mid-
// hold on every ordinary healthy poll, not just on a genuinely gone client.
export const INTENT_TTL_MS = 3 * MAX_POLL_HOLD_MS;
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

	constructor(opts: { ambient: Clock; ttlMs?: number }) {
		this.now = () => opts.ambient.now();
		this.ttlMs = opts.ttlMs ?? INTENT_TTL_MS;
	}

	/** Declare (or refresh) one device's current focus. Called on every poll that carries a
	 * `focus` field - the declaration itself IS the TTL refresh, so a live console's repeated
	 * polling keeps its intent alive with no separate heartbeat. Also sweeps expired entries on
	 * this, its OWN write path - not relying solely on a read (cadenceFor/watchList) ever
	 * happening, since those are reached only through the host daemon's own watch-push, which is
	 * absent on a gateway with no host daemon connected. A poll's `focus` field arrives regardless
	 * of host-daemon state, so this is the one call site guaranteed to fire on every topology. */
	declare(deviceId: string, intent: FocusIntent): void {
		this.sweep();
		this.byDevice.set(deviceId, { intent, expiresAt: this.now() + this.ttlMs });
	}

	/** A device stopped polling with a clean signal (rare - most exits rely on the TTL) - drops
	 * its intent immediately rather than waiting out the window. */
	clear(deviceId: string): void {
		this.byDevice.delete(deviceId);
	}

	/** The number of devices currently tracked (expired-but-not-yet-swept entries included) - for
	 * tests asserting this stays bounded, not a production read path. */
	get size(): number {
		return this.byDevice.size;
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
