import type { Clock } from "../shared/ambient.js";
import { MAX_POLL_HOLD_MS } from "../shared/schemas.js";

export interface FocusIntent {
	screen: "board" | "terminal" | "background";
	terminalTeam?: string;
	terminalRateMs?: number;
}

export interface WatchEntry {
	team: string;
	cadenceMs: number;
}

export const INTENT_TTL_MS = 3 * MAX_POLL_HOLD_MS;

// Board cadence preserves three missed held polls.
const BOARD_CADENCE_MS = 2_000;
const DEFAULT_TERMINAL_RATE_MS = 500;
const BACKGROUND_CADENCE_MS = 60_000;

export class IntentTracker {
	private readonly byDevice = new Map<string, { intent: FocusIntent; expiresAt: number }>();
	private readonly now: () => number;
	private readonly ttlMs: number;

	constructor(opts: { ambient: Clock; ttlMs?: number }) {
		this.now = () => opts.ambient.now();
		this.ttlMs = opts.ttlMs ?? INTENT_TTL_MS;
	}

	declare(deviceId: string, intent: FocusIntent): void {
		this.sweep();
		this.byDevice.set(deviceId, { intent, expiresAt: this.now() + this.ttlMs });
	}

	clear(deviceId: string): void {
		this.byDevice.delete(deviceId);
	}

	get size(): number {
		return this.byDevice.size;
	}

	private sweep(): void {
		const t = this.now();
		for (const [id, entry] of this.byDevice) {
			if (entry.expiresAt <= t) this.byDevice.delete(id);
		}
	}

	cadenceFor(team: string): number {
		// Expired intents are removed on every read.
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

	watchList(liveTeams: readonly string[]): WatchEntry[] {
		this.sweep();
		return liveTeams.map((team) => ({ team, cadenceMs: this.cadenceFor(team) }));
	}
}
