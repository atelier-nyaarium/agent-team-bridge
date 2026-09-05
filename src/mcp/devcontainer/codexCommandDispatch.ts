import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import { type CodexDaemonCommand, type CodexServiceTier, sanitizeCodexErrorText } from "../../shared/codex-agent.js";
import { resolveAgentTarget } from "./agentTargetResolve.js";
import type { TargetSession, TurnBinding } from "./codexDaemonTypes.js";
import { inspectRead } from "./codexThreadLifecycle.js";
import type { ReadOutcome, TerminalOutcome } from "./codexTurnOutcome.js";

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
			// Unknown commands must not start work.
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

	const threadId = await session.client.startThread({
		cwd: resolved.cwd,
		model: command.model,
		serviceTier: command.serviceTier,
	});
	const binding: TurnBinding = { ownerKey: command.ownerKey, agentId: command.agentId, threadId };
	host.bindThread(session, threadId, binding);
	const turnId = await beginTurn(session, binding, command.prompt);
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

async function beginTurn(
	session: TargetSession,
	binding: TurnBinding,
	prompt: string,
	turn: { model?: string; serviceTier?: CodexServiceTier } = {},
): Promise<string | undefined> {
	let bound: string | undefined;
	try {
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
		// A failed start is retried only after App Server confirms no running turn.
		if (bound !== undefined) session.turns.forget(bound);
		const running = await runningTurn(session, binding.threadId);
		if (running.known !== "running") return undefined;
		session.turns.bind(running.turnId, binding);
		return running.turnId;
	}
}

async function runningTurn(
	session: TargetSession,
	threadId: string,
): Promise<{ known: "running"; turnId: string } | { known: "none" } | { known: "unknown" }> {
	try {
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
	const expectedTurnId = command.expectedTurnId;
	if (expectedTurnId !== undefined && session.turns.has(expectedTurnId)) {
		try {
			await session.client.steerTurn(command.threadId, expectedTurnId, command.prompt);
			// Do not wait on a turn whose terminal already published.
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
			const ended = await runningTurn(session, command.threadId);
			if (ended.known !== "none") return host.reject(command, `codex could not account for the steered turn`);
		} catch (error) {
			// Only a confirmed end permits a new turn.
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

	let observed: ReadOutcome = { known: "unknown" };
	if (command.turnId) {
		try {
			const adopted = await session.client.adoptThread(command.threadId);
			if (adopted.known === "running" || adopted.known === "settled") {
				if (adopted.turnId !== command.turnId) {
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
	if (observed.known === "running" && command.turnId) session.turns.bind(command.turnId, binding);

	// Install the fence before later terminal events.
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
