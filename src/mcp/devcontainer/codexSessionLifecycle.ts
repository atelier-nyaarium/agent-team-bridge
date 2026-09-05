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

const HELD_TERMINAL_MS = 10_000;
const THREAD_MEMORY = 256;
function causeOf(reason: PoisonReason): string {
	return reason.kind === "failure" ? reason.failure.kind : `archive refused ${reason.attempts} times`;
}

export class CodexSessionLifecycle {
	private readonly deadlineSessions = new Set<TargetSession>();

	constructor(private readonly host: SessionLifecycleHost) {}

	liveSessions(): TargetSession[] {
		return [...this.deadlineSessions];
	}

	async acquire(target: AgentResolvedTarget): Promise<TargetSession | null> {
		const opened = await this.host.core.acquireSession(target, (resolved, lease) => this.open(resolved, lease));
		if (opened) opened.usedAt = this.host.now();
		return opened;
	}

	release(session: TargetSession, verb: string, cause: string): void {
		console.error(`[codex-daemon] ${verb} ${session.targetId} generation ${session.generation}: ${cause}`);
		this.host.core.retire(session);
		this.clearDeadlines(session);
		this.deadlineSessions.delete(session);
		this.host.deps.targets.release(session.targetId, session.generation);
	}

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

	bindThread(session: TargetSession, threadId: string, binding: TurnBinding): void {
		session.threads.delete(threadId);
		session.threads.set(threadId, binding);
		if (session.threads.size <= THREAD_MEMORY) return;
		for (const oldest of [...session.threads.keys()]) {
			if (session.threads.size <= THREAD_MEMORY) return;
			if (oldest === threadId) continue;
			const phase = session.client.stateOf(oldest)?.phase;
			if (phase === "active" || phase === "parking") continue;
			session.threads.delete(oldest);
		}
	}

	shutdown(): void {
		for (const session of this.deadlineSessions) this.clearDeadlines(session);
		this.deadlineSessions.clear();
	}

	private discard(client: AppServerSession, target: AgentResolvedTarget, lease: TargetLease, why: string): null {
		console.error(`[codex-daemon] discarding ${target.targetId} generation ${lease.generation}: ${why}`);
		try {
			client.close();
		} catch {
			// Release the lease even when client.close() throws.
		}
		this.host.deps.targets.release(target.targetId, lease.generation);
		return null;
	}

	private async open(target: AgentResolvedTarget, lease: TargetLease): Promise<TargetSession | null> {
		const opened = this.host.deps.openClient ?? defaultOpenClient;
		let client: AppServerSession;
		let session: TargetSession | undefined;
		const early: Array<{ threadId: string; reason: PoisonReason }> = [];
		try {
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
		if (this.host.isStopped()) return this.discard(client, target, lease, `daemon shut down`);

		session = {
			targetId: target.targetId,
			generation: lease.generation,
			client,
			tracker: new CodexTurnTracker((item) => {
				if (session) this.host.onCommentary(session, item);
			}),
			nextEventId: 0,
			turns: new CodexLiveTurns(() => this.host.now()),
			threads: new Map(),
			held: new Map(),
			usedAt: this.host.now(),
		};
		const opening = session;
		client.onEvent((message) => this.host.onServerEvent(opening, message));
		this.host.startSweeping();
		for (const previous of this.deadlineSessions) {
			if (previous.targetId !== opening.targetId) continue;
			if (previous.generation > opening.generation) continue;
			this.clearDeadlines(previous);
			this.deadlineSessions.delete(previous);
		}
		this.deadlineSessions.add(opening);
		return session;
	}

	private retireGeneration(session: TargetSession, threadId: string, reason: PoisonReason): void {
		this.release(session, `retiring`, `${threadId} ${causeOf(reason)}`);
	}

	private clearDeadlines(session: TargetSession): void {
		for (const timer of session.held.values()) (this.host.deps.clearTimer ?? clearTimeout)(timer);
		session.held.clear();
	}
}
