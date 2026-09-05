import type { Ambient, TimerHandle } from "../shared/ambient.js";
import { sanitizeLabel } from "../shared/session-sanitize.js";

////////////////////////////////
//  Interfaces & Types

/** Mirrors HostOpResult's shape: `ok: false` alone means the host daemon gave a definitive answer
 * (an explicit wake_result failure); errorKind marks an outcome the daemon never actually settled -
 * this waiter gave up (timeout) or the host link dropped mid-wait (disconnected) - so the launch
 * itself may still be running or may already have succeeded independently of this waiter. */
export interface WakeResult {
	ok: boolean;
	errorKind?: "timeout" | "disconnected";
	// A specific reason for a definitive `ok: false` with no errorKind (e.g. a composite target with
	// no existing record and no displayLabel to mint one from) - the caller has nothing else to build
	// a message from, unlike a timeout/disconnected outcome which already has an established one.
	error?: string;
	// The record's actual composite team name, set only when it differs from the requested one - a
	// mint (no caller-supplied id to adopt) picked a fresh id rather than the typed segment, so the
	// caller must switch to addressing this name instead for everything downstream of the wake.
	resolvedTeam?: string;
}

/** What a send-triggered wake of a composite target should do about creating it, given only whether a
 * record already exists and whether a USABLE displayLabel was supplied - the pure decision `doWakeTeam`
 * acts on, split out so it is unit-testable independent of SessionStore/the host-wake side effects. A
 * displayLabel is IGNORED once a record already exists (the target is addressed, not (re)created),
 * regardless of whether one was supplied. */
export type WakeCreateDecision =
	| { kind: "reattach" }
	| { kind: "mint"; sessionLabel: string }
	| { kind: "refuse"; error: string };

export function decideWakeCreate(
	team: string,
	hasExistingRecord: boolean,
	displayLabel: string | undefined,
): WakeCreateDecision {
	if (hasExistingRecord) return { kind: "reattach" };
	// sanitizeLabel, not raw truthiness: a whitespace/punctuation/invisible-only label is not usable
	// either, and must refuse the same as an absent one rather than silently mint a session labeled
	// with its own opaque id (create()'s own sanitizeLabel(...) ?? id fallback would otherwise do
	// exactly that unnoticed - the same anti-pattern this whole feature exists to close off).
	const clean = sanitizeLabel(displayLabel);
	if (!clean)
		return { kind: "refuse", error: `"${team}" does not exist yet; retry with a displayLabel to create it` };
	return { kind: "mint", sessionLabel: clean };
}

interface WakeWaiter {
	resolve: (result: WakeResult) => void;
	timer: TimerHandle;
	/** When this wait must be over, whatever happens later. Kept so a re-arm can only bring the
	 * deadline in, never push it out. */
	deadlineAt: number;
}

////////////////////////////////
//  Class

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

	/** A positive wake_result proves the container started, but it is not deliverable until it
	 * registers. Shorten each in-flight waiter to the registration window so a started-but-never-
	 * registered team (Claude crashed on boot) fails fast instead of stalling the full WAKE_TIMEOUT_MS;
	 * the woken container's own register still resolves it true if it lands within the window. Still a
	 * timeout, not a definitive failure - the narrower window ran out, not the daemon reporting a
	 * failure - so a caller that treats a bare timeout as ambiguous must treat this one the same way. */
	ackReceived(team: string, registerWindowMs: number): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		const now = this.ambient.now();
		for (const entry of entries) {
			this.ambient.clearTimer(entry.timer);
			// Clamped to what was left. A bare re-arm EXTENDS the wait when the ack lands near the
			// original deadline, which is the opposite of this method's whole purpose.
			const remaining = Math.max(0, Math.min(registerWindowMs, entry.deadlineAt - now));
			entry.timer = this.ambient.setTimer(() => {
				this.removeWaiter(team, entry);
				entry.resolve({ ok: false, errorKind: "timeout" });
			}, remaining);
		}
	}

	/** Fail every in-flight wake now (the host daemon socket dropped, so no wake_result can arrive),
	 * resolving each waiter so a `/send` awaiting a wake returns at once instead of stalling the full
	 * WAKE_TIMEOUT_MS. Mirrors HostOpCoordinator.failAll, including the "disconnected" tag: the wake
	 * request already reached the host and may complete (or may already have completed) regardless of
	 * the WS drop that triggered this. */
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
