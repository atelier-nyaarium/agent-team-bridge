import type { CodexDaemonDeps, TargetSession } from "./codexDaemonTypes.js";
import type { ReadOutcome, TerminalOutcome } from "./codexTurnOutcome.js";

export interface WatchdogHost {
	deps: CodexDaemonDeps;
	now(): number;
	lease<T>(run: () => Promise<T>): Promise<T>;
	live(session: TargetSession): boolean;
	sessions(): TargetSession[];
	readOutcome(session: TargetSession, threadId: string, turnId: string): Promise<ReadOutcome>;
	dropDeadline(session: TargetSession, turnId: string): void;
	settle(session: TargetSession, threadId: string, turnId: string, terminal: TerminalOutcome): void;
	release(session: TargetSession, verb: string, cause: string): void;
	inFlight(): number;
	quietSince(): number;
}

/** Reasoning may be silent; this threshold bounds hangs. */
const NO_PROGRESS_MS = 600_000;

const SWEEP_MS = 30_000;

const REAP_QUIET_MS = 600_000;

export class CodexWatchdog {
	private sweeper?: ReturnType<typeof setInterval>;
	private sweeping = false;
	private stopped = false;

	constructor(private readonly host: WatchdogHost) {}

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

	/** Process overdue turns before idle targets. */
	private async sweep(): Promise<void> {
		// Prevent overlapping sweeps.
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

	private async watchTurns(session: TargetSession): Promise<void> {
		for (const { turnId, binding, warned } of session.turns.overdue(NO_PROGRESS_MS)) {
			const observed = await this.host.readOutcome(session, binding.threadId, turnId);
			if (!this.host.live(session)) return;
			// Ignore results for rebound turns.
			if (session.turns.bindingOn(binding.threadId, turnId) === undefined) continue;
			// Repeated in-progress responses do not reset the silence deadline.
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
			// Release a turn interrupted twice.
			this.host.release(session, `retiring`, `${binding.threadId} made no progress on ${turnId}`);
			return;
		}
	}

	private reapIdle(): void {
		if (this.host.inFlight() > 0) return;
		const now = this.host.now();
		if (now - this.host.quietSince() < REAP_QUIET_MS) return;
		for (const session of this.host.sessions()) {
			if (!this.host.live(session)) continue;
			if (session.turns.size > 0 || session.held.size > 0) continue;
			if (now - session.usedAt < REAP_QUIET_MS) continue;
			// Reap only threads that are not mid-operation.
			const busy = [...session.threads.keys()].some((threadId) => {
				const phase = session.client.stateOf(threadId)?.phase;
				return phase === "active" || phase === "parking";
			});
			if (busy) continue;
			this.host.release(session, `reaping`, `idle for ${Math.round((now - session.usedAt) / 1_000)}s`);
		}
	}
}
