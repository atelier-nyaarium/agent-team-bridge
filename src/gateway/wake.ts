import type { Ambient, TimerHandle } from "../shared/ambient.js";
import { sanitizeLabel } from "../shared/session-sanitize.js";

// Timeout and disconnect are ambiguous host outcomes.
export interface WakeResult {
	ok: boolean;
	errorKind?: "timeout" | "disconnected";
	error?: string;
	resolvedTeam?: string;
}

export type WakeCreateDecision =
	| { kind: "reattach" }
	| { kind: "mint"; sessionLabel: string }
	| { kind: "refuse"; error: string };

// Existing records reattach. Usable labels permit minting.
export function decideWakeCreate(
	team: string,
	hasExistingRecord: boolean,
	displayLabel: string | undefined,
): WakeCreateDecision {
	if (hasExistingRecord) return { kind: "reattach" };
	const clean = sanitizeLabel(displayLabel);
	if (!clean)
		return { kind: "refuse", error: `"${team}" does not exist yet; retry with a displayLabel to create it` };
	return { kind: "mint", sessionLabel: clean };
}

interface WakeWaiter {
	resolve: (result: WakeResult) => void;
	timer: TimerHandle;
	deadlineAt: number;
}

export class WakeCoordinator {
	private waiters = new Map<string, WakeWaiter[]>();

	constructor(private readonly ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">) {}

	waitFor(team: string, timeoutMs: number): Promise<WakeResult> {
		return new Promise((resolve) => {
			const timer = this.ambient.setTimer(() => {
				this.removeWaiter(team, entry);
				resolve({ ok: false, errorKind: "timeout" });
			}, timeoutMs);
			const entry: WakeWaiter = { resolve, timer, deadlineAt: this.ambient.now() + timeoutMs };
			if (!this.waiters.has(team)) this.waiters.set(team, []);
			this.waiters.get(team)!.push(entry);
		});
	}

	notify(team: string, success = true): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		for (const entry of entries) {
			this.ambient.clearTimer(entry.timer);
			entry.resolve({ ok: success });
		}
		this.waiters.delete(team);
	}

	// Registration deadlines never extend the original wake timeout.
	ackReceived(team: string, registerWindowMs: number): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		const now = this.ambient.now();
		for (const entry of entries) {
			this.ambient.clearTimer(entry.timer);
			const remaining = Math.max(0, Math.min(registerWindowMs, entry.deadlineAt - now));
			entry.timer = this.ambient.setTimer(() => {
				this.removeWaiter(team, entry);
				entry.resolve({ ok: false, errorKind: "timeout" });
			}, remaining);
		}
	}

	// A dropped host link does not prove the wake failed.
	failAll(): void {
		for (const entries of this.waiters.values()) {
			for (const entry of entries) {
				this.ambient.clearTimer(entry.timer);
				entry.resolve({ ok: false, errorKind: "disconnected" });
			}
		}
		this.waiters.clear();
	}

	private removeWaiter(team: string, target: WakeWaiter): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		const idx = entries.indexOf(target);
		if (idx >= 0) entries.splice(idx, 1);
		if (entries.length === 0) this.waiters.delete(team);
	}
}
