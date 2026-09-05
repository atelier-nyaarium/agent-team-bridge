import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import { CODEX_DEFAULT_MODEL } from "../../shared/codex-agent.js";
import type { AgentDaemonCore } from "./agentDaemonCore.js";
import type { AppServerSession } from "./codexAppServerSession.js";
import { defaultOpenClient } from "./codexAppServerSession.js";
import type { CodexDaemonDeps, TargetSession, TurnBinding } from "./codexDaemonTypes.js";
import { CodexLiveTurns } from "./codexLiveTurns.js";
import type { TargetLease } from "./codexTargets.js";
import type { PoisonReason } from "./codexThreadLifecycle.js";
import type { TerminalOutcome } from "./codexTurnOutcome.js";
import { CodexTurnTracker } from "./codexTurnTracker.js";

////////////////////////////////
//  Interfaces & Types

export interface SessionLifecycleHost {
	deps: CodexDaemonDeps;
	core: AgentDaemonCore<TargetSession>;
	now(): number;
	isStopped(): boolean;
	startSweeping(): void;
	lease<T>(run: () => Promise<T>): Promise<T>;
	onServerEvent(session: TargetSession, message: { method: string; params?: unknown }): void;
	onCommentary(
		session: TargetSession,
		item: { threadId: string; turnId: string; itemId: string; text: string },
	): void;
	publishTerminal(session: TargetSession, threadId: string, turnId: string, terminal: TerminalOutcome): void;
	settleHeld(session: TargetSession, threadId: string, turnId: string): Promise<void>;
}

////////////////////////////////
//  Constants

/** How long a completed turn waits for the final item the tracker holds it for. */
const HELD_TERMINAL_MS = 10_000;

/** Bindings kept past the live ones. */
const THREAD_MEMORY = 256;

////////////////////////////////
//  Functions & Helpers

function causeOf(reason: PoisonReason): string {
	return reason.kind === "failure" ? reason.failure.kind : `archive refused ${reason.attempts} times`;
}

////////////////////////////////
//  Class

/** One target's session: open, retire, deadlines. */
export class CodexSessionLifecycle {
	/** Not a registry: whose deadlines to clear. `AgentDaemonCore` owns which generation serves. */
	private readonly deadlineSessions = new Set<TargetSession>();

	constructor(private readonly host: SessionLifecycleHost) {}

	/** A fresh snapshot each call. */
	liveSessions(): TargetSession[] {
		return [...this.deadlineSessions];
	}

	/**
	 * Opened on first use. Null means unreachable, which the caller reports as a refusal.
	 *
	 * Commands serialize per AGENT, so two agents sharing a target arrive concurrently. The open is
	 * shared per target: two clients over one child would give it two stdout readers, two colliding
	 * JSON-RPC id spaces, and two event counters both starting at zero on one fenced stream.
	 */
	async acquire(target: AgentResolvedTarget): Promise<TargetSession | null> {
		const opened = await this.host.core.acquireSession(target, (resolved, lease) => this.open(resolved, lease));
		// One place stamps the reaper's clock for a command, whichever command it was.
		if (opened) opened.usedAt = this.host.now();
		return opened;
	}

	/** The one way a generation ends here, whether it was condemned or merely finished. */
	release(session: TargetSession, verb: string, cause: string): void {
		console.error(`[codex-daemon] ${verb} ${session.targetId} generation ${session.generation}: ${cause}`);
		this.host.core.retire(session);
		this.clearDeadlines(session);
		this.deadlineSessions.delete(session);
		this.host.deps.targets.release(session.targetId, session.generation);
	}

	/** The tracker waits for a final item that may never arrive, so the wait is bounded. */
	holdDeadline(session: TargetSession, threadId: string, turnId: string): void {
		if (session.held.has(turnId)) return;
		const setTimer = this.host.deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
		session.held.set(
			turnId,
			setTimer(() => {
				session.held.delete(turnId);
				if (!this.host.core.live(session)) return;
				void this.host.lease(() => this.host.settleHeld(session, threadId, turnId));
			}, HELD_TERMINAL_MS),
		);
	}

	dropDeadline(session: TargetSession, turnId: string): void {
		const timer = session.held.get(turnId);
		if (timer === undefined) return;
		(this.host.deps.clearTimer ?? clearTimeout)(timer);
		session.held.delete(turnId);
	}

	/** Binds a thread, evicting oldest settled bindings past the bound. */
	bindThread(session: TargetSession, threadId: string, binding: TurnBinding): void {
		session.threads.delete(threadId);
		session.threads.set(threadId, binding);
		if (session.threads.size <= THREAD_MEMORY) return;
		// Never the binding just made.
		for (const oldest of [...session.threads.keys()]) {
			if (session.threads.size <= THREAD_MEMORY) return;
			if (oldest === threadId) continue;
			const phase = session.client.stateOf(oldest)?.phase;
			if (phase === "active" || phase === "parking") continue;
			session.threads.delete(oldest);
		}
	}

	/** Retired before the clients close, so nothing a close settles still counts as live. */
	shutdown(): void {
		for (const session of this.deadlineSessions) this.clearDeadlines(session);
		this.deadlineSessions.clear();
	}

	/** A client that will never serve: closed, its lease handed back, and the reason named. */
	private discard(client: AppServerSession, target: AgentResolvedTarget, lease: TargetLease, why: string): null {
		console.error(`[codex-daemon] discarding ${target.targetId} generation ${lease.generation}: ${why}`);
		try {
			client.close();
		} catch {
			// The lease release is what retires this child; a close that throws must not skip it.
		}
		this.host.deps.targets.release(target.targetId, lease.generation);
		return null;
	}

	private async open(target: AgentResolvedTarget, lease: TargetLease): Promise<TargetSession | null> {
		// A new generation is a different child, so nothing is carried over.
		const opened = this.host.deps.openClient ?? defaultOpenClient;
		let client: AppServerSession;
		// Named before it exists: the hooks serve the session built from the client they open.
		let session: TargetSession | undefined;
		// A poison this early has no session to retire, and losing it would leak the child it condemns.
		const early: Array<{ threadId: string; reason: PoisonReason }> = [];
		try {
			// Used only when a start names no model. One child serves threads that may each want a
			// different one, so the choice belongs on the call.
			client = await opened(lease.child, CODEX_DEFAULT_MODEL, {
				onTerminal: (threadId, turnId, terminal) => {
					if (session) this.host.publishTerminal(session, threadId, turnId, terminal);
				},
				onPoisoned: (threadId, reason) => {
					if (session) this.retireGeneration(session, threadId, reason);
					else early.push({ threadId, reason });
				},
			});
		} catch {
			this.host.deps.targets.release(target.targetId, lease.generation);
			return null;
		}

		const poisoned = early[0];
		if (poisoned) return this.discard(client, target, lease, `${poisoned.threadId} ${causeOf(poisoned.reason)}`);
		// A shutdown that landed while this was opening owns no ledger this child could be added to.
		if (this.host.isStopped()) return this.discard(client, target, lease, `daemon shut down`);

		session = {
			targetId: target.targetId,
			generation: lease.generation,
			client,
			tracker: new CodexTurnTracker((item) => {
				if (session) this.host.onCommentary(session, item);
			}),
			// Restarts from zero with the child, hence the generation on every fence.
			nextEventId: 0,
			turns: new CodexLiveTurns(() => this.host.now()),
			threads: new Map(),
			held: new Map(),
			usedAt: this.host.now(),
		};
		const opening = session;
		client.onEvent((message) => this.host.onServerEvent(opening, message));
		this.host.startSweeping();
		// Older generations of this target keep no deadline running. A newer one outranks this open.
		for (const previous of this.deadlineSessions) {
			if (previous.targetId !== opening.targetId) continue;
			if (previous.generation > opening.generation) continue;
			this.clearDeadlines(previous);
			this.deadlineSessions.delete(previous);
		}
		this.deadlineSessions.add(opening);
		return session;
	}

	/**
	 * A request whose fate is unknown may still land, so this child is never asked again.
	 *
	 * The release IS the retirement: the next command acquires a new generation, and the gateway
	 * reconciles its own stale records against that one.
	 */
	private retireGeneration(session: TargetSession, threadId: string, reason: PoisonReason): void {
		this.release(session, `retiring`, `${threadId} ${causeOf(reason)}`);
	}

	private clearDeadlines(session: TargetSession): void {
		for (const timer of session.held.values()) (this.host.deps.clearTimer ?? clearTimeout)(timer);
		session.held.clear();
	}
}
