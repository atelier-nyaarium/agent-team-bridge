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

////////////////////////////////
//  Constants

/** A frame this long after the last one is logged, since it is the silence the watchdog acts on. */
const FRAME_GAP_LOG_MS = 60_000;

////////////////////////////////
//  Functions & Helpers

/** A completed turn the tracker is holding for its final item, from the frame that announced it. */
function heldTurn(message: unknown): { threadId: string; turnId: string } | null {
	const parsed = CodexAppServerTurnCompletedSchema.safeParse(message);
	if (!parsed.success) return null;
	return { threadId: parsed.data.params.threadId, turnId: parsed.data.params.turn.id };
}

/**
 * The turn any frame names, whatever kind of frame it is.
 *
 * Deliberately not a schema: a turn that spends its life running commands emits no agent message, so
 * counting only the frames the tracker parses would interrupt work that is progressing perfectly.
 */
function framedTurn(message: { params?: unknown }): { threadId: string; turnId: string } | null {
	if (typeof message.params !== "object" || message.params === null) return null;
	const params = message.params as { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } };
	const turnId = typeof params.turnId === "string" ? params.turnId : params.turn?.id;
	if (typeof params.threadId !== "string" || typeof turnId !== "string") return null;
	return { threadId: params.threadId, turnId };
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
	private readonly sessions: CodexSessionLifecycle;
	private readonly watchdog: CodexWatchdog;
	private readonly dispatchHost: CommandDispatchHost;
	private stopped = false;
	private inFlight = 0;
	/** The DAEMON's quiet, stamped by commands alone. Not a session's `usedAt`; never merge them. */
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

	/**
	 * Held across every asynchronous stretch that touches a session, so a reap cannot land inside one.
	 *
	 * Counted for the daemon rather than per session: a lease taken after the session resolves leaves
	 * the acquire itself unguarded, which is the gap the local runtime already learned a reaper fires in.
	 */
	private async lease<T>(run: () => Promise<T>): Promise<T> {
		this.inFlight += 1;
		try {
			return await run();
		} finally {
			this.inFlight -= 1;
		}
	}

	/**
	 * A command under its lease, stamping the quiet clock the reaper measures from when it ends.
	 *
	 * Stamped at the END, since a command that outlasts the quiet period would otherwise leave its
	 * target reapable the instant it finished. The daemon's own sweeps do not stamp it: measuring
	 * from any leased work at all, the sweep resets the clock it is about to read and never reaps.
	 */
	private async serve(command: CodexDaemonCommand): Promise<void> {
		try {
			await this.lease(() => this.dispatch(command));
		} finally {
			this.quietSince = this.now();
		}
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
		// Dispatching would acquire a target and spawn the child a shutdown exists to stop spawning.
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

	/** Retired before the clients close, so nothing a close settles still counts as live. */
	shutdown(): void {
		this.stopped = true;
		this.watchdog.stop();
		this.sessions.shutdown();
		this.core.shutdown();
	}

	private dispatch(command: CodexDaemonCommand): Promise<void> {
		return dispatchCodexCommand(this.dispatchHost, command);
	}

	/** The thread id parks the thread whether a binding is held or not; `onTerminal` reaches the gateway. */
	private onServerEvent(session: TargetSession, message: { method: string; params?: unknown }): void {
		// A long gap is what the watchdog measures, so it is worth a line when it happens.
		const gap = this.now() - session.usedAt;
		if (gap > FRAME_GAP_LOG_MS) {
			const named = framedTurn(message);
			console.error(
				`[codex-daemon] ${session.targetId} frame after ${Math.round(gap / 1000)}s: ${message.method} turn=${named?.turnId ?? "-"}`,
			);
		}
		session.usedAt = this.now();
		const outcome = session.tracker.accept(message);
		// Named, so an interruption nobody here asked for is visible as such.
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
		// Any frame this turn produced is the progress the watchdog measures against.
		const named = framedTurn(message);
		if (named) session.turns.saw(named.threadId, named.turnId);
		const held = heldTurn(message);
		// Only a terminal actually waiting here; a redelivered one is already settled.
		if (held && session.tracker.holding(held.threadId, held.turnId)) {
			this.sessions.holdDeadline(session, held.threadId, held.turnId);
		}
	}

	/** One read decides it; only a read that says nothing settles on what the tracker holds. */
	private async settleHeld(session: TargetSession, threadId: string, turnId: string): Promise<void> {
		const observed = await this.readOutcome(session, threadId, turnId);
		// Replaced while the read was in flight.
		if (!this.core.live(session)) return;
		// A read still calling it in progress contradicts the terminal that armed this, so it is left
		// held rather than answered from a guess; the Step 5 watchdog owns that turn.
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

	/**
	 * The turn's own binding when its thread agrees, the thread's otherwise.
	 *
	 * A binding whose thread disagrees belongs to another thread's turn, so neither its agent nor its
	 * place among the live turns is this terminal's to take.
	 */
	private bindingFor(
		session: TargetSession,
		threadId: string,
		turnId: string,
	): { binding: TurnBinding | undefined; owned: boolean } {
		const bound = session.turns.bindingOn(threadId, turnId);
		return { binding: bound ?? session.threads.get(threadId), owned: bound !== undefined };
	}

	/** Retained before the lifecycle unloads anything. */
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

	/**
	 * A receipt carries this generation's fence, which the gateway drops once it has retired it.
	 *
	 * So a command whose generation died mid-flight is refused instead: a refusal carries no
	 * generation and is delivered, where an acceptance the gateway fences out hangs the caller.
	 */
	private emitReceipt(session: TargetSession, command: CodexDaemonCommand, receipt: Record<string, unknown>): void {
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
			error: sanitizeCodexErrorText(error) || `codex command failed`,
		};
		// Logged too: without it, an unavailable agent has no local trace of why.
		console.error(`[codex-daemon] refused ${command.kind} for ${command.agentId}: ${message.error}`);
		if (!CodexDaemonReceiptSchema.safeParse(message).success) return;
		this.deps.send(message);
	}
}
