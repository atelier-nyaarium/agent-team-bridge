import {
	CodexAppServerTurnCompletedSchema,
	type CodexDaemonCommand,
	CodexDaemonCommandSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	CodexDaemonHelloSchema,
	type CodexDaemonReceipt,
	CodexDaemonReceiptSchema,
	isReliableCodexMessage,
	sanitizeCodexErrorText,
} from "../../shared/codex-agent.js";
import { AgentDaemonCore, type AgentEventAck } from "./agentDaemonCore.js";
import { type CommandDispatchHost, describe, dispatchCodexCommand } from "./codexCommandDispatch.js";
import type { CodexDaemonDeps, TargetSession, TurnBinding } from "./codexDaemonTypes.js";
import { CodexSessionLifecycle, type SessionLifecycleHost } from "./codexSessionLifecycle.js";
import { outcomeFromRead, type ReadOutcome, type TerminalOutcome, terminalOf } from "./codexTurnOutcome.js";
import { CodexWatchdog, type WatchdogHost } from "./codexWatchdog.js";

export { agentTargetIdFor, resolveAgentTarget } from "./agentTargetResolve.js";
export type { AppServerSession } from "./codexAppServerSession.js";
export type { CodexDaemonDeps } from "./codexDaemonTypes.js";
export type { CodexDaemonEvent, CodexDaemonReceipt };

const FRAME_GAP_LOG_MS = 60_000;

function heldTurn(message: unknown): { threadId: string; turnId: string } | null {
	const parsed = CodexAppServerTurnCompletedSchema.safeParse(message);
	if (!parsed.success) return null;
	return { threadId: parsed.data.params.threadId, turnId: parsed.data.params.turn.id };
}

function framedTurn(message: { params?: unknown }): { threadId: string; turnId: string } | null {
	// Track named turn frames.
	if (typeof message.params !== "object" || message.params === null) return null;
	const params = message.params as { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } };
	const turnId = typeof params.turnId === "string" ? params.turnId : params.turn?.id;
	if (typeof params.threadId !== "string" || typeof turnId !== "string") return null;
	return { threadId: params.threadId, turnId };
}

export class CodexDaemonService {
	private readonly core: AgentDaemonCore<TargetSession>;
	private readonly sessions: CodexSessionLifecycle;
	private readonly watchdog: CodexWatchdog;
	private readonly dispatchHost: CommandDispatchHost;
	private stopped = false;
	private inFlight = 0;
	// Track daemon-level quiet time.
	private quietSince = 0;

	constructor(private readonly deps: CodexDaemonDeps) {
		this.core = new AgentDaemonCore({
			backendId: "codex",
			daemonInstanceId: deps.daemonInstanceId,
			targets: deps.targets,
			send: deps.send,
			isReliable: isReliableCodexMessage,
			helloSchema: CodexDaemonHelloSchema,
		});
		const sessionHost: SessionLifecycleHost = {
			deps: this.deps,
			core: this.core,
			now: () => this.now(),
			isStopped: () => this.stopped,
			startSweeping: () => this.watchdog.start(),
			lease: (run) => this.lease(run),
			onServerEvent: (session, message) => this.onServerEvent(session, message),
			onCommentary: (session, item) => this.onCommentary(session, item),
			publishTerminal: (session, threadId, turnId, terminal) =>
				this.publishTerminal(session, threadId, turnId, terminal),
			settleHeld: (session, threadId, turnId) => this.settleHeld(session, threadId, turnId),
		};
		this.sessions = new CodexSessionLifecycle(sessionHost);
		const watchdogHost: WatchdogHost = {
			deps: this.deps,
			now: () => this.now(),
			lease: (run) => this.lease(run),
			live: (session) => this.core.live(session),
			sessions: () => this.sessions.liveSessions(),
			readOutcome: (session, threadId, turnId) => this.readOutcome(session, threadId, turnId),
			dropDeadline: (session, turnId) => this.sessions.dropDeadline(session, turnId),
			settle: (session, threadId, turnId, terminal) => this.settle(session, threadId, turnId, terminal),
			release: (session, verb, cause) => this.sessions.release(session, verb, cause),
			inFlight: () => this.inFlight,
			quietSince: () => this.quietSince,
		};
		this.watchdog = new CodexWatchdog(watchdogHost);
		this.dispatchHost = {
			resolveHostCwd: (hint) => this.deps.resolveHostCwd(hint),
			acquireSession: (target) => this.sessions.acquire(target),
			bindThread: (session, threadId, binding) => this.sessions.bindThread(session, threadId, binding),
			readOutcome: (session, threadId, turnId) => this.readOutcome(session, threadId, turnId),
			dropDeadline: (session, turnId) => this.sessions.dropDeadline(session, turnId),
			settle: (session, threadId, turnId, terminal) => this.settle(session, threadId, turnId, terminal),
			emitReceipt: (session, command, receipt) => this.emitReceipt(session, command, receipt),
			reject: (command, error) => this.reject(command, error),
		};
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private async lease<T>(run: () => Promise<T>): Promise<T> {
		// Hold the lease across async operations.
		this.inFlight += 1;
		try {
			return await run();
		} finally {
			this.inFlight -= 1;
		}
	}

	private async serve(command: CodexDaemonCommand): Promise<void> {
		try {
			await this.lease(() => this.dispatch(command));
		} finally {
			// Refresh quiet time after work.
			this.quietSince = this.now();
		}
	}

	hello(): Record<string, unknown> {
		return this.core.hello();
	}

	replay(): void {
		this.core.replay();
	}

	acknowledge(ack: AgentEventAck): void {
		this.core.acknowledge(ack);
	}

	handleCommand(raw: unknown): void {
		const parsed = CodexDaemonCommandSchema.safeParse(raw);
		if (!parsed.success) return;
		const command = parsed.data;
		if (this.stopped) {
			this.reject(command, `codex daemon is shutting down`);
			return;
		}
		this.core.enqueue(
			command,
			(next) => this.serve(next),
			(next, error) => this.reject(next, error),
			describe,
		);
	}

	shutdown(): void {
		this.stopped = true;
		this.watchdog.stop();
		this.sessions.shutdown();
		this.core.shutdown();
	}

	private dispatch(command: CodexDaemonCommand): Promise<void> {
		return dispatchCodexCommand(this.dispatchHost, command);
	}

	private onServerEvent(session: TargetSession, message: { method: string; params?: unknown }): void {
		const gap = this.now() - session.usedAt;
		if (gap > FRAME_GAP_LOG_MS) {
			const named = framedTurn(message);
			console.error(
				`[codex-daemon] ${session.targetId} frame after ${Math.round(gap / 1000)}s: ${message.method} turn=${named?.turnId ?? "-"}`,
			);
		}
		session.usedAt = this.now();
		const outcome = session.tracker.accept(message);
		if (outcome?.status === "interrupted") {
			console.error(
				`[codex-daemon] ${session.targetId} turn ${outcome.turnId} interrupted (${message.method}, generation ${session.generation})`,
			);
		}
		if (outcome) {
			this.sessions.dropDeadline(session, outcome.turnId);
			this.settle(session, outcome.threadId, outcome.turnId, terminalOf(outcome));
			return;
		}
		const named = framedTurn(message);
		if (named) session.turns.saw(named.threadId, named.turnId);
		const held = heldTurn(message);
		if (held && session.tracker.holding(held.threadId, held.turnId)) {
			this.sessions.holdDeadline(session, held.threadId, held.turnId);
		}
	}

	private async settleHeld(session: TargetSession, threadId: string, turnId: string): Promise<void> {
		const observed = await this.readOutcome(session, threadId, turnId);
		if (!this.core.live(session)) return;
		// Running reads keep terminals held.
		if (observed.known === "running") return;
		const held = session.tracker.settlePending(threadId, turnId);
		const terminal = observed.known === "settled" ? observed.outcome : held === null ? undefined : terminalOf(held);
		if (!terminal) return;
		this.settle(session, threadId, turnId, terminal);
	}

	private async readOutcome(session: TargetSession, threadId: string, turnId: string): Promise<ReadOutcome> {
		try {
			return outcomeFromRead(await session.client.readThread(threadId), threadId, turnId);
		} catch {
			return { known: "unknown" };
		}
	}

	private settle(session: TargetSession, threadId: string, turnId: string, terminal: TerminalOutcome): void {
		void this.lease(() => session.client.settleTurn(threadId, turnId, terminal)).catch((error) => {
			console.error(`[codex-daemon] settling ${turnId} on ${threadId}: ${describe(error)}`);
		});
	}

	private bindingFor(
		session: TargetSession,
		threadId: string,
		turnId: string,
	): { binding: TurnBinding | undefined; owned: boolean } {
		// Mismatched bindings belong elsewhere.
		const bound = session.turns.bindingOn(threadId, turnId);
		return { binding: bound ?? session.threads.get(threadId), owned: bound !== undefined };
	}

	private publishTerminal(session: TargetSession, threadId: string, turnId: string, terminal: TerminalOutcome): void {
		if (!this.core.live(session)) return;
		const { binding, owned } = this.bindingFor(session, threadId, turnId);
		if (owned) session.turns.forget(turnId);
		if (!binding) return;
		this.emitTerminal(session, binding, turnId, terminal);
	}

	private onCommentary(
		session: TargetSession,
		item: { threadId: string; turnId: string; itemId: string; text: string },
	): void {
		if (!this.core.live(session)) return;
		const { binding } = this.bindingFor(session, item.threadId, item.turnId);
		if (!binding) return;
		this.emitEvent(session, {
			kind: "activity",
			ownerKey: binding.ownerKey,
			agentId: binding.agentId,
			threadId: item.threadId,
			turnId: item.turnId,
			itemId: item.itemId,
			text: item.text,
		});
	}

	private emitTerminal(session: TargetSession, binding: TurnBinding, turnId: string, outcome: TerminalOutcome): void {
		const base = {
			kind: "terminal" as const,
			ownerKey: binding.ownerKey,
			agentId: binding.agentId,
			threadId: binding.threadId,
			turnId,
		};
		switch (outcome.status) {
			case "completed":
				this.emitEvent(session, {
					...base,
					state: "completed",
					// Preserve completion for empty answers.
					finalResponse: outcome.finalResponse ?? "",
					finalItemId: outcome.finalItemId,
				});
				return;
			case "failed":
				this.emitEvent(session, { ...base, state: "failed", error: sanitizeCodexErrorText(outcome.error) });
				return;
			default:
				this.emitEvent(session, { ...base, state: "interrupted" });
		}
	}

	private emitEvent(session: TargetSession, event: Record<string, unknown>): void {
		this.core.publish(session, { type: "codex_event", ...event }, CodexDaemonEventSchema);
	}

	private emitReceipt(session: TargetSession, command: CodexDaemonCommand, receipt: Record<string, unknown>): void {
		// Retire generation fences from delivered refusals.
		if (!this.core.live(session)) {
			this.reject(command, `codex generation was retired mid-command`);
			return;
		}
		this.core.publish(
			session,
			{
				type: "codex_receipt",
				daemonInstanceId: this.deps.daemonInstanceId,
				targetId: session.targetId,
				generation: session.generation,
				...receipt,
			},
			CodexDaemonReceiptSchema,
		);
	}

	private reject(command: CodexDaemonCommand, error: string): void {
		const message = {
			type: "codex_receipt",
			kind: "rejected",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			daemonInstanceId: this.deps.daemonInstanceId,
			eventId: this.core.rejectionId(),
			agentId: command.agentId,
			operationId: command.kind === "reconcile" ? undefined : command.operationId,
			error: sanitizeCodexErrorText(error) || `codex command failed`,
		};
		console.error(`[codex-daemon] refused ${command.kind} for ${command.agentId}: ${message.error}`);
		if (!CodexDaemonReceiptSchema.safeParse(message).success) return;
		this.deps.send(message);
	}
}
