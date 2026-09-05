import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import { type CodexDaemonCommand, type CodexServiceTier, sanitizeCodexErrorText } from "../../shared/codex-agent.js";
import { resolveAgentTarget } from "./agentTargetResolve.js";
import type { TargetSession, TurnBinding } from "./codexDaemonTypes.js";
import { inspectRead } from "./codexThreadLifecycle.js";
import type { ReadOutcome, TerminalOutcome } from "./codexTurnOutcome.js";

////////////////////////////////
//  Interfaces & Types

export interface CommandDispatchHost {
	resolveHostCwd(hint: string | undefined): string;
	acquireSession(target: AgentResolvedTarget): Promise<TargetSession | null>;
	bindThread(session: TargetSession, threadId: string, binding: TurnBinding): void;
	readOutcome(session: TargetSession, threadId: string, turnId: string): Promise<ReadOutcome>;
	dropDeadline(session: TargetSession, turnId: string): void;
	settle(session: TargetSession, threadId: string, turnId: string, terminal: TerminalOutcome): void;
	emitReceipt(session: TargetSession, command: CodexDaemonCommand, receipt: Record<string, unknown>): void;
	reject(command: CodexDaemonCommand, error: string): void;
}

////////////////////////////////
//  Functions & Helpers

export function describe(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return sanitizeCodexErrorText(text) || `codex command failed`;
}

/** One command, routed to the run that knows its shape. */
export async function dispatchCodexCommand(host: CommandDispatchHost, command: CodexDaemonCommand): Promise<void> {
	switch (command.kind) {
		case "start":
			return runStart(host, command);
		case "message":
			return runMessage(host, command);
		case "interrupt":
			return runInterrupt(host, command);
		case "reconcile":
			return runReconcile(host, command);
		default:
			// An unmodelled kind must not reach a branch that starts work.
			return host.reject(command as CodexDaemonCommand, `unsupported command`);
	}
}

async function runStart(
	host: CommandDispatchHost,
	command: Extract<CodexDaemonCommand, { kind: "start" }>,
): Promise<void> {
	const resolved = resolveAgentTarget(command.target, host.resolveHostCwd);
	const session = await host.acquireSession(resolved);
	if (!session) return host.reject(command, `execution target is unavailable`);

	// startThread checks both against the server's own list.
	const threadId = await session.client.startThread({
		cwd: resolved.cwd,
		model: command.model,
		serviceTier: command.serviceTier,
	});
	const binding: TurnBinding = { ownerKey: command.ownerKey, agentId: command.agentId, threadId };
	host.bindThread(session, threadId, binding);
	// The thread already carries the tier, so its first turn does not restate it.
	const turnId = await beginTurn(session, binding, command.prompt);
	// A refusal marks the agent unavailable with nothing to reconcile, so it is only reached after
	// asking App Server whether a turn exists.
	if (!turnId) return host.reject(command, `codex thread produced no turn`);
	host.emitReceipt(session, command, {
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
async function beginTurn(
	session: TargetSession,
	binding: TurnBinding,
	prompt: string,
	turn: { model?: string; serviceTier?: CodexServiceTier } = {},
): Promise<string | undefined> {
	let bound: string | undefined;
	try {
		// Bound from inside the start, before a terminal buffered for this turn can be published.
		return await session.client.startTurn(
			binding.threadId,
			prompt,
			(turnId) => {
				bound = turnId;
				session.turns.bind(turnId, binding);
			},
			turn,
		);
	} catch {
		// A start that failed after binding holds a turn that is not ours; whatever runs is below.
		if (bound !== undefined) session.turns.forget(bound);
		const running = await runningTurn(session, binding.threadId);
		if (running.known !== "running") return undefined;
		session.turns.bind(running.turnId, binding);
		return running.turnId;
	}
}

/**
 * Three answers, like `outcomeFromRead`. "There is no turn" and "I could not ask" send callers in
 * opposite directions, and one of those starts a second turn on a thread still working.
 */
async function runningTurn(
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

async function runMessage(
	host: CommandDispatchHost,
	command: Extract<CodexDaemonCommand, { kind: "message" }>,
): Promise<void> {
	const session = await host.acquireSession(command.target);
	if (!session) return host.reject(command, `execution target is unavailable`);

	const binding: TurnBinding = {
		ownerKey: command.ownerKey,
		agentId: command.agentId,
		threadId: command.threadId,
	};
	host.bindThread(session, command.threadId, binding);
	// A turn this session no longer holds has settled, which is the one case that becomes a new turn.
	const expectedTurnId = command.expectedTurnId;
	if (expectedTurnId !== undefined && session.turns.has(expectedTurnId)) {
		try {
			await session.client.steerTurn(command.threadId, expectedTurnId, command.prompt);
			// A "steered" receipt for a turn whose terminal published leaves the gateway waiting on a
			// turn that has already ended.
			if (session.turns.has(expectedTurnId)) {
				host.emitReceipt(session, command, {
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
			const ended = await runningTurn(session, command.threadId);
			if (ended.known !== "none") return host.reject(command, `codex could not account for the steered turn`);
		} catch (error) {
			// Only App Server saying the turn ended makes this a new turn. Otherwise the prompt could
			// run twice concurrently, with write and network access.
			const running = await runningTurn(session, command.threadId);
			if (running.known !== "none") return host.reject(command, describe(error));
			session.turns.forget(expectedTurnId);
		}
	}

	await session.client.resumeThread(command.threadId);
	const turnId = await beginTurn(session, binding, command.prompt, {
		model: command.model,
		serviceTier: command.serviceTier,
	});
	if (!turnId) return host.reject(command, `codex thread produced no turn`);
	host.emitReceipt(session, command, {
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

async function runInterrupt(
	host: CommandDispatchHost,
	command: Extract<CodexDaemonCommand, { kind: "interrupt" }>,
): Promise<void> {
	const session = await host.acquireSession(command.target);
	if (!session) return host.reject(command, `execution target is unavailable`);
	const shared = {
		requestId: command.requestId,
		ownerKey: command.ownerKey,
		agentId: command.agentId,
		operationId: command.operationId,
		threadId: command.threadId,
		turnId: command.turnId,
	};
	console.error(`[codex-daemon] interrupt requested for turn ${command.turnId} by ${command.agentId}`);
	try {
		await session.client.interruptTurn(command.threadId, command.turnId);
	} catch (error) {
		host.emitReceipt(session, command, {
			kind: "interruptFailed",
			...shared,
			ok: false,
			error: describe(error),
		});
		return;
	}
	// Delivered, not ended: the turn's own terminal says how it finished.
	host.emitReceipt(session, command, { kind: "interruptResult", ...shared, ok: true });
}

async function runReconcile(
	host: CommandDispatchHost,
	command: Extract<CodexDaemonCommand, { kind: "reconcile" }>,
): Promise<void> {
	const session = await host.acquireSession(command.target);
	if (!session) return host.reject(command, `execution target is unavailable`);
	const binding: TurnBinding = {
		ownerKey: command.ownerKey,
		agentId: command.agentId,
		threadId: command.threadId,
	};
	host.bindThread(session, command.threadId, binding);

	// Silence is reported as silence: no turn state on the receipt, so the record stays askable.
	let observed: ReadOutcome = { known: "unknown" };
	if (command.turnId) {
		try {
			const adopted = await session.client.adoptThread(command.threadId);
			if (adopted.known === "running" || adopted.known === "settled") {
				if (adopted.turnId !== command.turnId) {
					// The thread moved on to another turn; this one is asked about by name.
					observed = await host.readOutcome(session, command.threadId, command.turnId);
				} else if (adopted.known === "running") {
					observed = { known: "running" };
				} else {
					observed = { known: "settled", outcome: adopted.outcome };
				}
			}
		} catch {
			observed = { known: "unknown" };
		}
	}
	// Rebound, so its events correlate under the new generation.
	if (observed.known === "running" && command.turnId) session.turns.bind(command.turnId, binding);

	// The receipt installs the fence FIRST, so the terminal after it is measured against this
	// generation, not the dead one.
	host.emitReceipt(session, command, {
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
		host.dropDeadline(session, command.turnId);
		host.settle(session, command.threadId, command.turnId, observed.outcome);
	}
}
