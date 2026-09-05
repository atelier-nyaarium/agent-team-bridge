import type { CodexDaemonDeps, TargetSession } from "./codexDaemonTypes.js";
import type { ReadOutcome, TerminalOutcome } from "./codexTurnOutcome.js";

////////////////////////////////
//  Interfaces & Types

export interface WatchdogHost {
	deps: CodexDaemonDeps;
	now(): number;
	lease<T>(run: () => Promise<T>): Promise<T>;
	live(session: TargetSession): boolean;
	/** A fresh snapshot each call. */
	sessions(): TargetSession[];
	readOutcome(session: TargetSession, threadId: string, turnId: string): Promise<ReadOutcome>;
	dropDeadline(session: TargetSession, turnId: string): void;
	settle(session: TargetSession, threadId: string, turnId: string, terminal: TerminalOutcome): void;
	release(session: TargetSession, verb: string, cause: string): void;
	inFlight(): number;
	quietSince(): number;
}

////////////////////////////////
//  Constants

/** How long an active turn may go without progress before the watchdog asks App Server about it. */
// A reasoning stretch streams no frame; ten minutes tells that from a hang.
const NO_PROGRESS_MS = 600_000;

/** How often the watchdog and the reaper look. */
const SWEEP_MS = 30_000;

/** Quiet time before an idle target is released, past the 240s wait budget and 300s reconcile guard. */
const REAP_QUIET_MS = 600_000;

////////////////////////////////
//  Class

/** Silent-turn interrupts and idle-target reap. */
export class CodexWatchdog {
	private sweeper?: ReturnType<typeof setInterval>;
	private sweeping = false;
	private stopped = false;

	constructor(private readonly host: WatchdogHost) {}

	/** One timer for the daemon's life, started with its first session. */
	start(): void {
		if (this.sweeper !== undefined || this.stopped) return;
		const setSweep = this.host.deps.setSweep ?? ((run, ms) => setInterval(run, ms));
		this.sweeper = setSweep(() => void this.sweep(), SWEEP_MS);
		(this.sweeper as { unref?: () => void }).unref?.();
	}

	stop(): void {
		this.stopped = true;
		if (this.sweeper !== undefined) (this.host.deps.clearSweep ?? clearInterval)(this.sweeper);
		this.sweeper = undefined;
	}

	/** Overdue turns first, since settling one is what makes its target reapable. */
	private async sweep(): Promise<void> {
		// A sweep still reading when the next one fires would double every read it has not finished.
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			for (const session of this.host.sessions()) {
				if (this.host.live(session)) await this.host.lease(() => this.watchTurns(session));
			}
			this.reapIdle();
		} finally {
			this.sweeping = false;
		}
	}

	/**
	 * Ask App Server about a turn that has gone quiet, and act on the answer rather than the silence.
	 *
	 * Progress is a frame the turn produced. Another identical `inProgress` is not progress: a turn
	 * that hangs reports it forever, which is exactly the case this exists to end.
	 */
	private async watchTurns(session: TargetSession): Promise<void> {
		for (const { turnId, binding, warned } of session.turns.overdue(NO_PROGRESS_MS)) {
			const observed = await this.host.readOutcome(session, binding.threadId, turnId);
			if (!this.host.live(session)) return;
			// Settled or rebound while the read was in flight: that thread is not this turn's any more.
			if (session.turns.bindingOn(binding.threadId, turnId) === undefined) continue;
			if (observed.known === "settled") {
				this.host.dropDeadline(session, turnId);
				this.host.settle(session, binding.threadId, turnId, observed.outcome);
				continue;
			}
			if (!warned) {
				session.turns.warn(turnId);
				console.error(
					`[codex-daemon] ${session.targetId} interrupting turn ${turnId}: no frame from ${binding.threadId} in ${NO_PROGRESS_MS / 1000}s`,
				);
				void this.host
					.lease(() => session.client.interruptTurn(binding.threadId, turnId))
					.catch(() => undefined);
				continue;
			}
			// Interrupted once and still silent, so this child answers for nothing any more.
			this.host.release(session, `retiring`, `${binding.threadId} made no progress on ${turnId}`);
			return;
		}
	}

	/**
	 * Release a target nobody is using, which is the only thing that ends a codex child's life here.
	 *
	 * Every condition is checked at the instant of the reap: an in-flight lease anywhere, a turn this
	 * daemon still holds, a terminal still on its deadline, or a thread the owner has not parked.
	 */
	private reapIdle(): void {
		if (this.host.inFlight() > 0) return;
		const now = this.host.now();
		if (now - this.host.quietSince() < REAP_QUIET_MS) return;
		for (const session of this.host.sessions()) {
			if (!this.host.live(session)) continue;
			if (session.turns.size > 0 || session.held.size > 0) continue;
			if (now - session.usedAt < REAP_QUIET_MS) continue;
			// Mid-operation, not merely unparked: nothing parks a thread that never ran a turn, so
			// waiting for `parked` alone would leave an idle one blocking the reap for the daemon's life.
			const busy = [...session.threads.keys()].some((threadId) => {
				const phase = session.client.stateOf(threadId)?.phase;
				return phase === "active" || phase === "parking";
			});
			if (busy) continue;
			this.host.release(session, `reaping`, `idle for ${Math.round((now - session.usedAt) / 1_000)}s`);
		}
	}
}
