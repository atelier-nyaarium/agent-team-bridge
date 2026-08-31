import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import {
	CODEX_DEFAULT_MODEL,
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
import { resolveAgentTarget } from "./agentTargetResolve.js";
import type { AppServerSession } from "./codexAppServerSession.js";
import { defaultOpenClient } from "./codexAppServerSession.js";
import type { CodexDaemonDeps, TargetSession, TurnBinding } from "./codexDaemonTypes.js";
import type { TargetLease } from "./codexTargets.js";
import { inspectRead, type PoisonReason } from "./codexThreadLifecycle.js";
import type { ReadOutcome, TerminalOutcome } from "./codexTurnOutcome.js";
import { outcomeFromRead, terminalOf } from "./codexTurnOutcome.js";
import { CodexTurnTracker } from "./codexTurnTracker.js";

export { agentTargetIdFor, resolveAgentTarget } from "./agentTargetResolve.js";
export type { AppServerSession } from "./codexAppServerSession.js";
export type { CodexDaemonDeps } from "./codexDaemonTypes.js";
export type { CodexDaemonEvent, CodexDaemonReceipt };

////////////////////////////////
//  Constants

/** How long a completed turn waits for the final item the tracker holds it for. */
const HELD_TERMINAL_MS = 10_000;

/** How long an active turn may go without progress before the watchdog asks App Server about it. */
const NO_PROGRESS_MS = 120_000;

/** How often the watchdog and the reaper look. */
const SWEEP_MS = 30_000;

/** Quiet time before an idle target is released, past the 240s wait budget and 300s reconcile guard. */
const REAP_QUIET_MS = 600_000;

////////////////////////////////
//  Functions & Helpers

function describe(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return sanitizeCodexErrorText(text) || `codex command failed`;
}

function causeOf(reason: PoisonReason): string {
	return reason.kind === "failure" ? reason.failure.kind : `archive refused ${reason.attempts} times`;
}

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
	/** Not a registry: whose deadlines to clear. `AgentDaemonCore` owns which generation serves. */
	private readonly deadlineSessions = new Set<TargetSession>();
	private stopped = false;
	private sweeper?: ReturnType<typeof setInterval>;
	private inFlight = 0;
	private sweeping = false;
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
		if (this.sweeper !== undefined) (this.deps.clearSweep ?? clearInterval)(this.sweeper);
		this.sweeper = undefined;
		for (const session of this.deadlineSessions) this.clearDeadlines(session);
		this.deadlineSessions.clear();
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
				return this.reject(command as CodexDaemonCommand, `unsupported command`);
		}
	}

	private async runStart(command: Extract<CodexDaemonCommand, { kind: "start" }>): Promise<void> {
		const resolved = resolveAgentTarget(command.target, this.deps.resolveHostCwd);
		const session = await this.session(resolved);
		if (!session) return this.reject(command, `execution target is unavailable`);

		// startThread checks the model against the server's own list.
		const threadId = await session.client.startThread({ cwd: resolved.cwd, model: command.model });
		const binding: TurnBinding = { ownerKey: command.ownerKey, agentId: command.agentId, threadId };
		session.threads.set(threadId, binding);
		const turnId = await this.beginTurn(session, binding, command.prompt);
		// A refusal marks the agent unavailable with nothing to reconcile, so it is only reached after
		// asking App Server whether a turn exists.
		if (!turnId) return this.reject(command, `codex thread produced no turn`);
		this.emitReceipt(session, command, {
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
		let bound: string | undefined;
		try {
			// Bound from inside the start, before a terminal buffered for this turn can be published.
			return await session.client.startTurn(binding.threadId, prompt, (turnId) => {
				bound = turnId;
				this.bindTurn(session, turnId, binding);
			});
		} catch {
			// A start that failed after binding holds a turn that is not ours; whatever runs is below.
			if (bound !== undefined) session.turns.delete(bound);
			const running = await this.runningTurn(session, binding.threadId);
			if (running.known !== "running") return undefined;
			this.bindTurn(session, running.turnId, binding);
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
			// `inspectRead` owns what a thread read means; this asks only whether work is still going.
			const seen = inspectRead(await session.client.readThread(threadId), threadId);
			if (seen.known === "running") return { known: "running", turnId: seen.turnId };
			return seen.known === "unknown" ? { known: "unknown" } : { known: "none" };
		} catch {
			return { known: "unknown" };
		}
	}

	private async runMessage(command: Extract<CodexDaemonCommand, { kind: "message" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, `execution target is unavailable`);

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
				// A "steered" receipt for a turn whose terminal published leaves the gateway waiting on a
				// turn that has already ended.
				if (session.turns.has(expectedTurnId)) {
					this.emitReceipt(session, command, {
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
				}
				// That terminal may have carried this prompt with it, so the same rule as a failed steer
				// applies: only App Server saying nothing runs makes it a new turn.
				const ended = await this.runningTurn(session, command.threadId);
				if (ended.known !== "none") return this.reject(command, `codex could not account for the steered turn`);
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
		if (!turnId) return this.reject(command, `codex thread produced no turn`);
		this.emitReceipt(session, command, {
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
		if (!session) return this.reject(command, `execution target is unavailable`);
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
			this.emitReceipt(session, command, {
				kind: "interruptFailed",
				...shared,
				ok: false,
				error: describe(error),
			});
			return;
		}
		// Delivered, not ended: the turn's own terminal says how it finished.
		this.emitReceipt(session, command, { kind: "interruptResult", ...shared, ok: true });
	}

	private async runReconcile(command: Extract<CodexDaemonCommand, { kind: "reconcile" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, `execution target is unavailable`);
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
		if (observed.known === "running" && command.turnId) this.bindTurn(session, command.turnId, binding);

		// The receipt installs the fence FIRST, so the terminal after it is measured against this
		// generation, not the dead one.
		this.emitReceipt(session, command, {
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
			this.dropDeadline(session, command.turnId);
			this.settle(session, command.threadId, command.turnId, observed.outcome);
		}
	}

	/**
	 * Opened on first use. Null means unreachable, which the caller reports as a refusal.
	 *
	 * Commands serialize per AGENT, so two agents sharing a target arrive concurrently. The open is
	 * shared per target: two clients over one child would give it two stdout readers, two colliding
	 * JSON-RPC id spaces, and two event counters both starting at zero on one fenced stream.
	 */
	private async session(target: AgentResolvedTarget): Promise<TargetSession | null> {
		const opened = await this.core.acquireSession(target, (resolved, lease) => this.open(resolved, lease));
		// One place stamps the reaper's clock for a command, whichever command it was.
		if (opened) opened.usedAt = this.now();
		return opened;
	}

	/** A client that will never serve: closed, its lease handed back, and the reason named. */
	private discard(client: AppServerSession, target: AgentResolvedTarget, lease: TargetLease, why: string): null {
		console.error(`[codex-daemon] discarding ${target.targetId} generation ${lease.generation}: ${why}`);
		try {
			client.close();
		} catch {
			// The lease release is what retires this child; a close that throws must not skip it.
		}
		this.deps.targets.release(target.targetId, lease.generation);
		return null;
	}

	private async open(target: AgentResolvedTarget, lease: TargetLease): Promise<TargetSession | null> {
		// A new generation is a different child, so nothing is carried over.
		const opened = this.deps.openClient ?? defaultOpenClient;
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
					if (session) this.publishTerminal(session, threadId, turnId, terminal);
				},
				onPoisoned: (threadId, reason) => {
					if (session) this.retireGeneration(session, threadId, reason);
					else early.push({ threadId, reason });
				},
			});
		} catch {
			this.deps.targets.release(target.targetId, lease.generation);
			return null;
		}

		const poisoned = early[0];
		if (poisoned) return this.discard(client, target, lease, `${poisoned.threadId} ${causeOf(poisoned.reason)}`);
		// A shutdown that landed while this was opening owns no ledger this child could be added to.
		if (this.stopped) return this.discard(client, target, lease, `daemon shut down`);

		session = {
			targetId: target.targetId,
			generation: lease.generation,
			client,
			tracker: new CodexTurnTracker((item) => {
				if (session) this.onCommentary(session, item);
			}),
			// Restarts from zero with the child, hence the generation on every fence.
			nextEventId: 0,
			turns: new Map(),
			threads: new Map(),
			held: new Map(),
			watch: new Map(),
			usedAt: this.now(),
		};
		const opening = session;
		client.onEvent((message) => this.onServerEvent(opening, message));
		this.startSweeping();
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

	/** The thread id parks the thread whether a binding is held or not; `onTerminal` reaches the gateway. */
	private onServerEvent(session: TargetSession, message: { method: string; params?: unknown }): void {
		session.usedAt = this.now();
		const outcome = session.tracker.accept(message);
		if (outcome) {
			session.watch.delete(outcome.turnId);
			this.dropDeadline(session, outcome.turnId);
			this.settle(session, outcome.threadId, outcome.turnId, terminalOf(outcome));
			return;
		}
		// Any frame this turn produced is the progress the watchdog measures against, and only its own
		// thread's: a turn id carried by another thread's frame says nothing about this one.
		const named = framedTurn(message);
		if (named && session.turns.get(named.turnId)?.threadId === named.threadId) {
			session.watch.set(named.turnId, { at: session.usedAt, strikes: 0 });
		}
		const held = heldTurn(message);
		// Only a terminal actually waiting here; a redelivered one is already settled.
		if (held && session.tracker.holding(held.threadId, held.turnId)) {
			this.holdDeadline(session, held.threadId, held.turnId);
		}
	}

	/** The tracker waits for a final item that may never arrive, so the wait is bounded. */
	private holdDeadline(session: TargetSession, threadId: string, turnId: string): void {
		if (session.held.has(turnId)) return;
		const setTimer = this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
		session.held.set(
			turnId,
			setTimer(() => {
				session.held.delete(turnId);
				if (!this.core.live(session)) return;
				void this.lease(() => this.settleHeld(session, threadId, turnId));
			}, HELD_TERMINAL_MS),
		);
	}

	private dropDeadline(session: TargetSession, turnId: string): void {
		const timer = session.held.get(turnId);
		if (timer === undefined) return;
		(this.deps.clearTimer ?? clearTimeout)(timer);
		session.held.delete(turnId);
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

	/** One timer for the daemon's life, started with its first session. */
	private startSweeping(): void {
		if (this.sweeper !== undefined || this.stopped) return;
		const setSweep = this.deps.setSweep ?? ((run, ms) => setInterval(run, ms));
		this.sweeper = setSweep(() => void this.sweep(), SWEEP_MS);
		(this.sweeper as { unref?: () => void }).unref?.();
	}

	/** Overdue turns first, since settling one is what makes its target reapable. */
	private async sweep(): Promise<void> {
		// A sweep still reading when the next one fires would double every read it has not finished.
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			for (const session of [...this.deadlineSessions]) {
				if (this.core.live(session)) await this.lease(() => this.watchTurns(session));
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
		for (const [turnId, binding] of [...session.turns]) {
			const seen = session.watch.get(turnId);
			// Seeded rather than measured from the session, whose clock another turn's frames refresh.
			if (!seen) {
				session.watch.set(turnId, { at: this.now(), strikes: 0 });
				continue;
			}
			if (this.now() - seen.at < NO_PROGRESS_MS) continue;
			const observed = await this.readOutcome(session, binding.threadId, turnId);
			if (!this.core.live(session) || !session.turns.has(turnId)) return;
			if (observed.known === "settled") {
				this.dropDeadline(session, turnId);
				this.settle(session, binding.threadId, turnId, observed.outcome);
				continue;
			}
			if (seen.strikes === 0) {
				session.watch.set(turnId, { at: this.now(), strikes: 1 });
				void this.lease(() => session.client.interruptTurn(binding.threadId, turnId)).catch(() => undefined);
				continue;
			}
			// Interrupted once and still silent, so this child answers for nothing any more.
			this.release(session, `retiring`, `${binding.threadId} made no progress on ${turnId}`);
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
		if (this.inFlight > 0) return;
		const now = this.now();
		if (now - this.quietSince < REAP_QUIET_MS) return;
		for (const session of [...this.deadlineSessions]) {
			if (!this.core.live(session)) continue;
			if (session.turns.size > 0 || session.held.size > 0) continue;
			if (now - session.usedAt < REAP_QUIET_MS) continue;
			// Mid-operation, not merely unparked: nothing parks a thread that never ran a turn, so
			// waiting for `parked` alone would leave an idle one blocking the reap for the daemon's life.
			const busy = [...session.threads.keys()].some((threadId) => {
				const phase = session.client.stateOf(threadId)?.phase;
				return phase === "active" || phase === "parking";
			});
			if (busy) continue;
			this.release(session, `reaping`, `idle for ${Math.round((now - session.usedAt) / 1_000)}s`);
		}
	}

	private async readOutcome(session: TargetSession, threadId: string, turnId: string): Promise<ReadOutcome> {
		try {
			return outcomeFromRead(await session.client.readThread(threadId), threadId, turnId);
		} catch {
			return { known: "unknown" };
		}
	}

	private settle(session: TargetSession, threadId: string, turnId: string, terminal: TerminalOutcome): void {
		session.watch.delete(turnId);
		void this.lease(() => session.client.settleTurn(threadId, turnId, terminal)).catch((error) => {
			console.error(`[codex-daemon] settling ${turnId} on ${threadId}: ${describe(error)}`);
		});
	}

	/** A turn and the clock the watchdog measures it by, so neither can exist without the other. */
	private bindTurn(session: TargetSession, turnId: string, binding: TurnBinding): void {
		session.turns.set(turnId, binding);
		// Rebinding is the gateway asking again, not the turn working, so it keeps the strikes it has.
		if (!session.watch.has(turnId)) session.watch.set(turnId, { at: this.now(), strikes: 0 });
	}

	/**
	 * The turn's own binding when its thread agrees, the thread's otherwise.
	 *
	 * A binding whose thread disagrees belongs to another thread's turn, so neither its agent nor its
	 * entry in `turns` is this terminal's to take.
	 */
	private bindingFor(
		session: TargetSession,
		threadId: string,
		turnId: string,
	): { binding: TurnBinding | undefined; owned: boolean } {
		const bound = session.turns.get(turnId);
		const owned = bound !== undefined && bound.threadId === threadId;
		return { binding: owned ? bound : session.threads.get(threadId), owned };
	}

	/** Retained before the lifecycle unloads anything. */
	private publishTerminal(session: TargetSession, threadId: string, turnId: string, terminal: TerminalOutcome): void {
		if (!this.core.live(session)) return;
		const { binding, owned } = this.bindingFor(session, threadId, turnId);
		if (owned) session.turns.delete(turnId);
		if (!binding) return;
		this.emitTerminal(session, binding, turnId, terminal);
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

	/** The one way a generation ends here, whether it was condemned or merely finished. */
	private release(session: TargetSession, verb: string, cause: string): void {
		console.error(`[codex-daemon] ${verb} ${session.targetId} generation ${session.generation}: ${cause}`);
		this.core.retire(session);
		this.clearDeadlines(session);
		this.deadlineSessions.delete(session);
		this.deps.targets.release(session.targetId, session.generation);
	}

	private clearDeadlines(session: TargetSession): void {
		for (const timer of session.held.values()) (this.deps.clearTimer ?? clearTimeout)(timer);
		session.held.clear();
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
