import {
	CODEX_DEFAULT_MODEL,
	CODEX_HOST_TARGET_ID,
	CodexAppServerThreadReadResultSchema,
	type CodexDaemonCommand,
	CodexDaemonCommandSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	type CodexDaemonReceipt,
	CodexDaemonReceiptSchema,
	type CodexEventAck,
	type CodexExecutionTarget,
	type CodexResolvedTarget,
	CodexResolvedTargetSchema,
	codexContainerTargetId,
	isReliableCodexMessage,
	sanitizeCodexErrorText,
} from "../../shared/codex-thinking.js";
import { CodexAppServerClient, createJsonlTransport } from "./codexAppServer.js";
import type { CodexChild, TargetLease, TargetSupervisor } from "./codexTargets.js";
import { CodexTurnTracker, type TurnOutcome } from "./codexTurnTracker.js";

////////////////////////////////
//  Interfaces & Types

/** The App Server calls this service makes. Named separately from the client class so a test can
 * stand in for a child process without one. */
export interface AppServerSession {
	onEvent(listener: (message: { method: string; params?: unknown }) => void): void;
	startThread(settings: { cwd: string; model?: string }): Promise<string>;
	resumeThread(threadId: string): Promise<void>;
	readThread(threadId: string): Promise<unknown>;
	startTurn(threadId: string, text: string): Promise<string>;
	steerTurn(threadId: string, turnId: string, text: string): Promise<void>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	close(): void;
}

export interface CodexDaemonDeps {
	targets: TargetSupervisor;
	daemonInstanceId: string;
	send(message: Record<string, unknown>): void;
	openClient?(child: CodexChild, model: string): Promise<AppServerSession>;
	/** Turns a host session's workdir HINT into a real directory. Injected because the rule lives in
	 * the host daemon, and a hint may be a console-picked path or a bare human label. */
	resolveHostCwd(hint: string | undefined): string;
	model?: string;
	now?(): number;
}

/** Which agent a native turn belongs to. The App Server knows nothing of agents, so every event it
 * emits is correlated back through this. */
interface TurnBinding {
	ownerKey: string;
	agentId: string;
	threadId: string;
}

interface TargetSession {
	targetId: string;
	generation: number;
	client: AppServerSession;
	tracker: CodexTurnTracker;
	nextEventId: number;
	turns: Map<string, TurnBinding>;
	threads: Map<string, TurnBinding>;
}

////////////////////////////////
//  Functions & Helpers

// Enough retained receipts to survive a long gateway outage without letting one wedged target grow
// without bound. Overflow drops the OLDEST, since the newest carry the state a reconcile would
// otherwise have to rediscover.
const OUTBOX_MAX_ENTRIES = 1_000;

export function codexTargetIdFor(target: CodexExecutionTarget): string {
	return target.kind === "host" ? CODEX_HOST_TARGET_ID : codexContainerTargetId(target.project);
}

/**
 * A requested target resolved to the one a child actually runs under. The cwd rides the thread, so
 * it is the only per-agent part of this.
 *
 * A host session's hint is NOT a path. It may be a console-picked directory or a bare human label,
 * and `resolveHostWorkdir` is the one place that knows which is which. Passing the hint through as a
 * cwd made every host start fail its own schema and be refused as an unavailable target.
 */
export function resolveCodexTarget(
	target: CodexExecutionTarget,
	resolveHostCwd: (hint: string | undefined) => string,
): CodexResolvedTarget {
	return CodexResolvedTargetSchema.parse({
		kind: target.kind,
		targetId: codexTargetIdFor(target),
		cwd: target.kind === "host" ? resolveHostCwd(target.workdirHint) : `/workspace/${target.project}`,
	});
}

function describe(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return sanitizeCodexErrorText(text) || "codex command failed";
}

/** How a turn ended. The one shape both the live tracker and a post-restart `thread/read` produce, so
 * a rebuilt terminal and a witnessed one are the same message. */
type TerminalOutcome =
	| { status: "completed"; finalResponse?: string; finalItemId?: string }
	| { status: "failed"; error: string }
	| { status: "interrupted" };

/**
 * What App Server says about one turn.
 *
 * Three answers, not two. Collapsing `running` and `unknown` into a single absent outcome is what
 * lets a live turn be reported as a failed one: the caller cannot tell "App Server says it is still
 * going" from "App Server could not tell me", and the plan requires opposite handling for each.
 */
type ReadOutcome = { known: "settled"; outcome: TerminalOutcome } | { known: "running" } | { known: "unknown" };

/** The outcome a settled turn had, rebuilt from what `thread/read` still holds. Nothing is invented:
 * a turn whose items are gone reports completed with no answer rather than a guessed one. */
function outcomeFromRead(result: unknown, threadId: string, turnId: string): ReadOutcome {
	const parsed = CodexAppServerThreadReadResultSchema.safeParse(result);
	if (!parsed.success || parsed.data.thread.id !== threadId) return { known: "unknown" };
	const turn = parsed.data.thread.turns.find((candidate) => candidate.id === turnId);
	if (!turn) return { known: "unknown" };
	if (turn.status === "inProgress") return { known: "running" };
	if (turn.status === "interrupted") return { known: "settled", outcome: { status: "interrupted" } };
	// A read carries no error text, so a failure recovered this way says only that it failed.
	if (turn.status === "failed") return { known: "settled", outcome: { status: "failed", error: "turn failed" } };
	const answers = turn.items.filter(
		(item): item is { type: "agentMessage"; id: string; text: string; phase?: unknown } =>
			item.type === "agentMessage",
	);
	const final = answers.findLast((item) => item.phase === "final_answer") ?? answers.at(-1);
	return {
		known: "settled",
		outcome: { status: "completed", finalResponse: final?.text, finalItemId: final?.id },
	};
}

////////////////////////////////
//  Class

/**
 * The daemon's half of Codex delegation: one supervised App Server per target, and the reliable
 * stream back to the gateway.
 *
 * It owns no policy. Every guardrail a caller wanted is in the prompt, and every decision about what
 * an owner is allowed to reach was already made by the gateway before a command arrived here.
 */
export class CodexDaemonService {
	private readonly sessions = new Map<string, TargetSession>();
	private readonly opening = new Map<string, Promise<TargetSession | null>>();
	private readonly outbox: Array<{ targetId: string; generation: number; eventId: number; message: object }> = [];
	private readonly inflight = new Map<string, Promise<void>>();

	constructor(private readonly deps: CodexDaemonDeps) {}

	/** What this daemon is and which children are live, sent on every authenticated reconnect. The
	 * gateway decides from it what still needs reconciling; the daemon never asks on its own. */
	hello(): Record<string, unknown> {
		return {
			type: "codex_hello",
			daemonInstanceId: this.deps.daemonInstanceId,
			targets: [...this.sessions.values()].map((session) => ({
				targetId: session.targetId,
				generation: session.generation,
			})),
		};
	}

	/** Re-send everything the gateway has not committed, oldest first, so an ordering the reducer
	 * depends on survives the reconnect that interrupted it. */
	replay(): void {
		for (const entry of [...this.outbox].sort((left, right) => left.eventId - right.eventId)) {
			this.deps.send(entry.message as Record<string, unknown>);
		}
	}

	/** Retire everything the gateway has durably committed for one generation. */
	acknowledge(ack: CodexEventAck): void {
		for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
			const entry = this.outbox[index]!;
			if (
				entry.targetId === ack.targetId &&
				entry.generation === ack.generation &&
				entry.eventId <= ack.throughEventId
			) {
				this.outbox.splice(index, 1);
			}
		}
	}

	/**
	 * Run one gateway command.
	 *
	 * Commands for one agent are serialized: a steer and an interrupt for the same thread racing each
	 * other would each read a turn state the other is about to change.
	 */
	handleCommand(raw: unknown): void {
		const parsed = CodexDaemonCommandSchema.safeParse(raw);
		if (!parsed.success) return;
		const command = parsed.data;
		// Separated, not concatenated: a bare join lets one owner/agent pair collide with another that
		// merely splits at a different point, and colliding here serializes two unrelated agents.
		const key = `${command.ownerKey} ${command.agentId}`;
		const previous = this.inflight.get(key) ?? Promise.resolve();
		const next = previous
			.then(() => this.dispatch(command))
			.catch((error) => this.reject(command, describe(error)))
			.finally(() => {
				if (this.inflight.get(key) === next) this.inflight.delete(key);
			});
		this.inflight.set(key, next);
	}

	shutdown(): void {
		for (const session of this.sessions.values()) session.client.close();
		this.sessions.clear();
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
				// An unmodelled kind must not reach a branch that starts work. Nothing here is safe to
				// guess at, so it is refused in the shape the gateway already handles.
				return this.reject(command as CodexDaemonCommand, "unsupported command");
		}
	}

	private async runStart(command: Extract<CodexDaemonCommand, { kind: "start" }>): Promise<void> {
		const resolved = resolveCodexTarget(command.target, this.deps.resolveHostCwd);
		const session = await this.session(resolved);
		if (!session) return this.reject(command, "execution target is unavailable");

		const threadId = await session.client.startThread({ cwd: resolved.cwd });
		const binding: TurnBinding = { ownerKey: command.ownerKey, agentId: command.agentId, threadId };
		session.threads.set(threadId, binding);
		const turnId = await this.beginTurn(session, binding, command.prompt);
		// A refusal tells the gateway the start never reached an App Server, which is what lets it mark
		// the agent unavailable with nothing to reconcile. That is only true while no turn exists, so
		// this branch is taken ONLY after asking App Server whether one does.
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
	 * A write that reached the server but whose reply did not reach here looks identical to a write
	 * that never landed. Only the server can tell them apart, and reporting a live turn as a refusal
	 * would strand it: the gateway marks a refused start unavailable, which is excluded from
	 * reconciliation, so nothing would ever come looking for it again.
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
	 * What App Server says is running on a thread. Three answers, like `outcomeFromRead`, and for the
	 * same reason: "there is no turn" and "I could not ask" send the callers in opposite directions,
	 * and one of those directions starts a second turn on a thread that is still working.
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
		// A steer needs the exact turn the gateway believed was running. A turn this session no longer
		// holds has already settled, which is the one case that legitimately becomes a new turn.
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
				// The turn finishing mid-steer is the ONLY failure that becomes a new turn, and only App
				// Server saying so makes it that. A read that could not answer is refused along with every
				// other unexplained error: starting a turn against a thread that may still be working
				// would run the prompt twice, with write and network access, concurrently.
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
		// Delivered, not ended. The turn's own terminal is what says how it actually finished, which
		// may still be a completion that won the race.
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

		// App Server is the authority on what this turn is doing. Its silence is reported as silence:
		// an unreadable thread leaves the turn state OFF the receipt, which lands the record on
		// recovering and leaves it eligible to be asked again, rather than inventing a failure.
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
		// A turn App Server reports as running is bound again, so its own events correlate back to this
		// agent under the new generation.
		if (observed.known === "running" && command.turnId) session.turns.set(command.turnId, binding);

		// The receipt installs the fence FIRST, so the terminal that follows is measured against this
		// generation instead of the dead one the gateway was still holding.
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
	 * The target's session, opened on first use. Null means the target could not be reached, which the
	 * caller reports as a refusal rather than retrying here.
	 *
	 * Commands serialize per AGENT, so two agents sharing a target arrive here concurrently. The open
	 * is therefore shared through a per-target promise: without it both would build a client over the
	 * same child, giving one process two readers of its stdout, two JSON-RPC id spaces that can settle
	 * each other's requests, and two event counters both starting at zero on one fenced stream.
	 */
	private async session(target: CodexResolvedTarget): Promise<TargetSession | null> {
		const availability = this.deps.targets.acquire(target);
		if (availability.state !== "running") return null;
		const generation = availability.lease.generation;
		const existing = this.sessions.get(target.targetId);
		if (existing && existing.generation === generation) return existing;

		const key = `${target.targetId} ${generation}`;
		const inflight = this.opening.get(key);
		if (inflight) return inflight;
		const opening = this.open(target, availability.lease).finally(() => {
			if (this.opening.get(key) === opening) this.opening.delete(key);
		});
		this.opening.set(key, opening);
		return opening;
	}

	private async open(target: CodexResolvedTarget, lease: TargetLease): Promise<TargetSession | null> {
		// A new generation is a different child. Nothing the old one knew about threads or turns
		// survives it, so the session is rebuilt rather than carried over.
		this.sessions.get(target.targetId)?.client.close();

		const opened = this.deps.openClient ?? defaultOpenClient;
		let client: AppServerSession;
		try {
			client = await opened(lease.child, this.deps.model ?? CODEX_DEFAULT_MODEL);
		} catch {
			this.deps.targets.release(target.targetId);
			return null;
		}

		const session: TargetSession = {
			targetId: target.targetId,
			generation: lease.generation,
			client,
			tracker: new CodexTurnTracker((item) => this.onCommentary(target.targetId, item)),
			// Restarts from zero with the child, which is why every fence carries the generation that
			// numbered it.
			nextEventId: 0,
			turns: new Map(),
			threads: new Map(),
		};
		client.onEvent((message) => this.onServerEvent(session, message));
		this.sessions.set(target.targetId, session);
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
		const session = this.sessions.get(targetId);
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
					// An empty answer is a real outcome for a turn that only acted. Omitting the field would
					// make the event unparseable and lose the terminal entirely.
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
		this.publish(session, { type: "codex_event", ...event }, CodexDaemonEventSchema);
	}

	private emitReceipt(session: TargetSession, receipt: Record<string, unknown>): void {
		this.publish(
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

	/** Number, validate, retain if it matters, send. The schema's own parsed value is what decides
	 * whether to retain, so the reliability table is consulted against the real union rather than
	 * against an untyped draft. */
	private publish(
		session: TargetSession,
		partial: Record<string, unknown>,
		schema: {
			safeParse(
				value: unknown,
			): { success: true; data: CodexDaemonEvent | CodexDaemonReceipt } | { success: false };
		},
	): void {
		const eventId = session.nextEventId;
		session.nextEventId += 1;
		const message = {
			daemonInstanceId: this.deps.daemonInstanceId,
			targetId: session.targetId,
			generation: session.generation,
			...partial,
			eventId,
		};
		// Validated before it can be retained. An unparseable message would be replayed forever and
		// refused every time, which reads to an owner as a permanently stuck agent.
		const parsed = schema.safeParse(message);
		if (!parsed.success) return;
		if (isReliableCodexMessage(parsed.data)) this.retain(session.targetId, session.generation, eventId, message);
		this.deps.send(message);
	}

	private retain(targetId: string, generation: number, eventId: number, message: object): void {
		this.outbox.push({ targetId, generation, eventId, message });
		// Counted PER generation, not across the whole outbox. A shared cap would let one wedged target
		// evict another target's receipts, which is the opposite of what bounding it is for.
		const sameStream = (entry: { targetId: string; generation: number }) =>
			entry.targetId === targetId && entry.generation === generation;
		while (this.outbox.filter(sameStream).length > OUTBOX_MAX_ENTRIES) {
			const [dropped] = this.outbox.splice(this.outbox.findIndex(sameStream), 1);
			console.error(`[codex-daemon] outbox overflow, dropped event ${dropped?.eventId} on ${targetId}`);
		}
	}

	/** A refusal carries no generation, so it is sent once. An owner whose refusal is lost sees the
	 * operation stay unproven, which is what its wait budget already means. */
	private reject(command: CodexDaemonCommand, error: string): void {
		const message = {
			type: "codex_receipt",
			kind: "rejected",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			daemonInstanceId: this.deps.daemonInstanceId,
			eventId: this.rejectionId(),
			agentId: command.agentId,
			operationId: command.kind === "reconcile" ? undefined : command.operationId,
			error: sanitizeCodexErrorText(error) || "codex command failed",
		};
		// Logged as well as sent. A refusal is the daemon's whole explanation for why an owner's agent
		// went unavailable, and without a local trace the only symptom is a result envelope naming no
		// cause; that cost a full debugging round the first time it fired.
		console.error(`[codex-daemon] refused ${command.kind} for ${command.agentId}: ${message.error}`);
		if (!CodexDaemonReceiptSchema.safeParse(message).success) return;
		this.deps.send(message);
	}

	// Refusals are not fenced by a generation, so they number off their own monotonic counter purely
	// so two refusals are distinguishable.
	private rejections = 0;
	private rejectionId(): number {
		this.rejections += 1;
		return this.rejections;
	}
}

////////////////////////////////
//  Functions & Helpers

function terminalOf(outcome: TurnOutcome): TerminalOutcome {
	switch (outcome.status) {
		case "completed":
			return { status: "completed", finalResponse: outcome.finalResponse };
		case "failed":
			return { status: "failed", error: outcome.error ?? "turn failed" };
		default:
			return { status: "interrupted" };
	}
}

async function defaultOpenClient(child: CodexChild, model: string): Promise<CodexAppServerClient> {
	return CodexAppServerClient.open(createJsonlTransport(child), model);
}

export type { CodexDaemonEvent, CodexDaemonReceipt };
