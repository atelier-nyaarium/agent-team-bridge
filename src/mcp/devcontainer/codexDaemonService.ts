import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import {
	CODEX_DEFAULT_MODEL,
	CodexAppServerThreadReadResultSchema,
	type CodexDaemonCommand,
	CodexDaemonCommandSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	type CodexDaemonReceipt,
	CodexDaemonReceiptSchema,
	isReliableCodexMessage,
	sanitizeCodexErrorText,
} from "../../shared/codex-thinking.js";
import { AgentDaemonCore, type AgentEventAck } from "./agentDaemonCore.js";
import { resolveAgentTarget } from "./agentTargetResolve.js";
import type { AppServerSession } from "./codexAppServerSession.js";
import { defaultOpenClient } from "./codexAppServerSession.js";
import type { CodexDaemonDeps, TargetSession, TurnBinding } from "./codexDaemonTypes.js";
import type { TargetLease } from "./codexTargets.js";
import type { ReadOutcome, TerminalOutcome } from "./codexTurnOutcome.js";
import { outcomeFromRead, terminalOf } from "./codexTurnOutcome.js";
import { CodexTurnTracker } from "./codexTurnTracker.js";

export { agentTargetIdFor, resolveAgentTarget } from "./agentTargetResolve.js";
export type { AppServerSession } from "./codexAppServerSession.js";
export type { CodexDaemonDeps } from "./codexDaemonTypes.js";
export type { CodexDaemonEvent, CodexDaemonReceipt };

////////////////////////////////
//  Functions & Helpers

function describe(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return sanitizeCodexErrorText(text) || "codex command failed";
}

////////////////////////////////
//  Class

/**
 * One supervised App Server per target, and the reliable stream back to the gateway.
 *
 * Owns no policy: every guardrail is in the prompt, and every access decision was the gateway's.
 */
export class CodexDaemonService {
	private readonly core: AgentDaemonCore<TargetSession>;

	constructor(private readonly deps: CodexDaemonDeps) {
		this.core = new AgentDaemonCore({
			backendId: "codex",
			daemonInstanceId: deps.daemonInstanceId,
			targets: deps.targets,
			send: deps.send,
			isReliable: isReliableCodexMessage,
		});
	}

	/** What this daemon is and which children are live. The gateway decides what needs reconciling. */
	hello(): Record<string, unknown> {
		return this.core.hello();
	}

	/** Oldest first, so an ordering the reducer depends on survives the reconnect. */
	replay(): void {
		this.core.replay();
	}

	/** Retire everything the gateway has durably committed for one generation. */
	acknowledge(ack: AgentEventAck): void {
		this.core.acknowledge(ack);
	}

	/** Serialized per agent: a racing steer and interrupt each read state the other is changing. */
	handleCommand(raw: unknown): void {
		const parsed = CodexDaemonCommandSchema.safeParse(raw);
		if (!parsed.success) return;
		const command = parsed.data;
		this.core.enqueue(
			command,
			(next) => this.dispatch(next),
			(next, error) => this.reject(next, error),
			describe,
		);
	}

	shutdown(): void {
		this.core.shutdown();
	}

	private async dispatch(command: CodexDaemonCommand): Promise<void> {
		switch (command.kind) {
			case "start":
				return this.runStart(command);
			case "message":
				return this.runMessage(command);
			case "interrupt":
				return this.runInterrupt(command);
			case "reconcile":
				return this.runReconcile(command);
			default:
				// An unmodelled kind must not reach a branch that starts work.
				return this.reject(command as CodexDaemonCommand, "unsupported command");
		}
	}

	private async runStart(command: Extract<CodexDaemonCommand, { kind: "start" }>): Promise<void> {
		const resolved = resolveAgentTarget(command.target, this.deps.resolveHostCwd);
		const session = await this.session(resolved);
		if (!session) return this.reject(command, "execution target is unavailable");

		// startThread checks the model against the server's own list.
		const threadId = await session.client.startThread({ cwd: resolved.cwd, model: command.model });
		const binding: TurnBinding = { ownerKey: command.ownerKey, agentId: command.agentId, threadId };
		session.threads.set(threadId, binding);
		const turnId = await this.beginTurn(session, binding, command.prompt);
		// A refusal marks the agent unavailable with nothing to reconcile, so it is only reached after
		// asking App Server whether a turn exists.
		if (!turnId) return this.reject(command, "codex thread produced no turn");
		this.emitReceipt(session, {
			kind: "accepted",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			operationId: command.operationId,
			resolvedTarget: resolved,
			threadId,
			turnId,
			delivery: "started",
		});
	}

	/**
	 * Start a turn, and if that call fails, ask App Server whether one started anyway.
	 *
	 * A lost reply looks identical to a write that never landed, and only the server can tell them
	 * apart. Reporting a live turn as a refusal strands it: a refused start is never reconciled.
	 */
	private async beginTurn(session: TargetSession, binding: TurnBinding, prompt: string): Promise<string | undefined> {
		try {
			const turnId = await session.client.startTurn(binding.threadId, prompt);
			session.turns.set(turnId, binding);
			return turnId;
		} catch {
			const running = await this.runningTurn(session, binding.threadId);
			if (running.known !== "running") return undefined;
			session.turns.set(running.turnId, binding);
			return running.turnId;
		}
	}

	/**
	 * Three answers, like `outcomeFromRead`. "There is no turn" and "I could not ask" send callers in
	 * opposite directions, and one of those starts a second turn on a thread still working.
	 */
	private async runningTurn(
		session: TargetSession,
		threadId: string,
	): Promise<{ known: "running"; turnId: string } | { known: "none" } | { known: "unknown" }> {
		try {
			const read = CodexAppServerThreadReadResultSchema.safeParse(await session.client.readThread(threadId));
			if (!read.success || read.data.thread.id !== threadId) return { known: "unknown" };
			const running = read.data.thread.turns.find((turn) => turn.status === "inProgress");
			return running ? { known: "running", turnId: running.id } : { known: "none" };
		} catch {
			return { known: "unknown" };
		}
	}

	private async runMessage(command: Extract<CodexDaemonCommand, { kind: "message" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, "execution target is unavailable");

		const binding: TurnBinding = {
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			threadId: command.threadId,
		};
		session.threads.set(command.threadId, binding);
		// A turn this session no longer holds has settled, which is the one case that becomes a new turn.
		const expectedTurnId = command.expectedTurnId;
		if (expectedTurnId !== undefined && session.turns.has(expectedTurnId)) {
			try {
				await session.client.steerTurn(command.threadId, expectedTurnId, command.prompt);
				this.emitReceipt(session, {
					kind: "accepted",
					requestId: command.requestId,
					ownerKey: command.ownerKey,
					agentId: command.agentId,
					operationId: command.operationId,
					resolvedTarget: command.target,
					threadId: command.threadId,
					turnId: expectedTurnId,
					delivery: "steered",
				});
				return;
			} catch (error) {
				// Only App Server saying the turn ended makes this a new turn. Otherwise the prompt could
				// run twice concurrently, with write and network access.
				const running = await this.runningTurn(session, command.threadId);
				if (running.known !== "none") return this.reject(command, describe(error));
				session.turns.delete(expectedTurnId);
			}
		}

		await session.client.resumeThread(command.threadId);
		const turnId = await this.beginTurn(session, binding, command.prompt);
		if (!turnId) return this.reject(command, "codex thread produced no turn");
		this.emitReceipt(session, {
			kind: "accepted",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			operationId: command.operationId,
			resolvedTarget: command.target,
			threadId: command.threadId,
			turnId,
			delivery: "started",
		});
	}

	private async runInterrupt(command: Extract<CodexDaemonCommand, { kind: "interrupt" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, "execution target is unavailable");
		const shared = {
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			operationId: command.operationId,
			threadId: command.threadId,
			turnId: command.turnId,
		};
		try {
			await session.client.interruptTurn(command.threadId, command.turnId);
		} catch (error) {
			this.emitReceipt(session, { kind: "interruptFailed", ...shared, ok: false, error: describe(error) });
			return;
		}
		// Delivered, not ended: the turn's own terminal says how it finished.
		this.emitReceipt(session, { kind: "interruptResult", ...shared, ok: true });
	}

	private async runReconcile(command: Extract<CodexDaemonCommand, { kind: "reconcile" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, "execution target is unavailable");
		const binding: TurnBinding = {
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			threadId: command.threadId,
		};
		session.threads.set(command.threadId, binding);

		// Silence is reported as silence: no turn state on the receipt, so the record stays askable.
		let observed: ReadOutcome = { known: "unknown" };
		if (command.turnId) {
			try {
				await session.client.resumeThread(command.threadId);
				observed = outcomeFromRead(
					await session.client.readThread(command.threadId),
					command.threadId,
					command.turnId,
				);
			} catch {
				observed = { known: "unknown" };
			}
		}
		// Rebound, so its events correlate under the new generation.
		if (observed.known === "running" && command.turnId) session.turns.set(command.turnId, binding);

		// The receipt installs the fence FIRST, so the terminal after it is measured against this
		// generation, not the dead one.
		this.emitReceipt(session, {
			kind: "reconciled",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			resolvedTarget: command.target,
			threadId: command.threadId,
			turnId: command.turnId,
			turnState:
				observed.known === "running"
					? "inProgress"
					: observed.known === "settled"
						? observed.outcome.status
						: undefined,
		});
		if (observed.known === "settled" && command.turnId) {
			this.emitTerminal(session, binding, command.turnId, observed.outcome);
		}
	}

	/**
	 * Opened on first use. Null means unreachable, which the caller reports as a refusal.
	 *
	 * Commands serialize per AGENT, so two agents sharing a target arrive concurrently. The open is
	 * shared per target: two clients over one child would give it two stdout readers, two colliding
	 * JSON-RPC id spaces, and two event counters both starting at zero on one fenced stream.
	 */
	private session(target: AgentResolvedTarget): Promise<TargetSession | null> {
		return this.core.acquireSession(target, (resolved, lease) => this.open(resolved, lease));
	}

	private async open(target: AgentResolvedTarget, lease: TargetLease): Promise<TargetSession | null> {
		// A new generation is a different child, so nothing is carried over.
		const opened = this.deps.openClient ?? defaultOpenClient;
		let client: AppServerSession;
		try {
			// Used only when a start names no model. One child serves threads that may each want a
			// different one, so the choice belongs on the call.
			client = await opened(lease.child, CODEX_DEFAULT_MODEL);
		} catch {
			this.deps.targets.release(target.targetId);
			return null;
		}

		const session: TargetSession = {
			targetId: target.targetId,
			generation: lease.generation,
			client,
			tracker: new CodexTurnTracker((item) => this.onCommentary(target.targetId, item)),
			// Restarts from zero with the child, hence the generation on every fence.
			nextEventId: 0,
			turns: new Map(),
			threads: new Map(),
		};
		client.onEvent((message) => this.onServerEvent(session, message));
		return session;
	}

	private onServerEvent(session: TargetSession, message: { method: string; params?: unknown }): void {
		const outcome = session.tracker.accept(message);
		if (!outcome) return;
		const binding = session.turns.get(outcome.turnId) ?? session.threads.get(outcome.threadId);
		session.turns.delete(outcome.turnId);
		if (!binding) return;
		this.emitTerminal(session, binding, outcome.turnId, terminalOf(outcome));
	}

	private onCommentary(
		targetId: string,
		item: { threadId: string; turnId: string; itemId: string; text: string },
	): void {
		const session = this.core.getSession(targetId);
		const binding = session?.turns.get(item.turnId) ?? session?.threads.get(item.threadId);
		if (!session || !binding) return;
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
					// A turn that only acted has an empty answer. Omitting it loses the terminal.
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

	private emitReceipt(session: TargetSession, receipt: Record<string, unknown>): void {
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

	/** No generation, so it is sent once. A lost refusal leaves the operation unproven. */
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
			error: sanitizeCodexErrorText(error) || "codex command failed",
		};
		// Logged too: without it, an unavailable agent has no local trace of why.
		console.error(`[codex-daemon] refused ${command.kind} for ${command.agentId}: ${message.error}`);
		if (!CodexDaemonReceiptSchema.safeParse(message).success) return;
		this.deps.send(message);
	}
}
