import { advancesFence, sameFence } from "../shared/agent-fence.js";
import { appendAgentActivity } from "../shared/agent-record.js";
import {
	CODEX_ACTIVITY_MAX_ITEMS,
	type CodexDaemonEvent,
	type CodexPersistedAgent,
	CodexPersistedAgentSchema,
	type CodexReconciliationFence,
	type CodexResolvedTarget,
	type CodexStoredActivity,
	type CodexStoredExchange,
	type CodexStoredOperation,
	type CodexStoredTurn,
	sanitizeCodexErrorText,
} from "../shared/codex-agent.js";
import { type CodexApplication, CodexTransitionError } from "./codexAgentTypes.js";

////////////////////////////////
//  Interfaces & Types

/** What one delivery receipt means for its record, decided pure so the one decision that lets the
 * daemon retire its only copy is testable without a daemon. */
export type CodexAcceptanceVerdict =
	/** Already accepted and the receipt matches it byte for byte. */
	| { kind: "replayed" }
	/** Accepted but never fenced; only reconciliation can say which child that acceptance came from. */
	| { kind: "unplaceable" }
	/** Already accepted and the receipt CONTRADICTS it. */
	| { kind: "conflict" }
	/** The receipt will never apply to this record; settle it so the daemon may retire it. */
	| { kind: "refuse" }
	/** This gateway cannot place the receipt YET; hold it, never acknowledge it. */
	| { kind: "unresolved" }
	| { kind: "accept"; steeredIntoSettledTurn: boolean };

////////////////////////////////
//  Functions & Helpers

export function validateTimestamp(at: number): number {
	if (!Number.isSafeInteger(at) || at < 0) {
		throw new CodexTransitionError("invalid_input", "transition timestamp must be a nonnegative integer");
	}
	return at;
}

export function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
	return values.map((current, currentIndex) => (currentIndex === index ? value : current));
}

export function sameTarget(left: CodexResolvedTarget | undefined, right: CodexResolvedTarget): boolean {
	return left?.kind === right.kind && left.targetId === right.targetId && left.cwd === right.cwd;
}

/** Only a REQUESTED delivery blocks the next one. An indeterminate one is already settled as far as
 * this gateway is concerned, and counting it would wedge the agent permanently: nothing ever
 * transitions an indeterminate operation, so a single unprovable delivery would refuse every
 * follow-up for the agent's whole life. Reconciliation, not this guard, is what restores truth. */
export function hasPendingPrompt(agent: CodexPersistedAgent): boolean {
	return agent.operations.some(
		(operation) => (operation.kind === "start" || operation.kind === "message") && operation.state === "requested",
	);
}

/** The frame does not describe anything this gateway owns, and never will. Safe to retire. */
export function ignore(reason: string): CodexApplication {
	return { disposition: "ignored", reason };
}

/** The frame is fine; building a record from it failed. Never retired, because the failure is this
 * gateway's and a retry or a reconcile may still place it. */
export function failed(reason: string): CodexApplication {
	return { disposition: "failed", reason };
}

/** Codex's binding of the shared append rule. The window policy and the truncation marker live in
 * `appendAgentActivity`; only the cap is Codex's to name. */
export function appendActivity(
	existing: readonly CodexStoredActivity[],
	itemId: string,
	text: string,
): CodexStoredActivity[] | null {
	return appendAgentActivity(existing, itemId, text, CODEX_ACTIVITY_MAX_ITEMS) as CodexStoredActivity[] | null;
}

/** Clear the recovery flag Phase 2 sets on a delivery whose acceptance was never fenced. A
 * reconciled agent has a live fence again, which is exactly what the flag stood in for. */
export function refenceUnverified(
	operations: readonly CodexStoredOperation[],
	fence: CodexReconciliationFence,
): CodexStoredOperation[] {
	return operations.map((operation) =>
		operation.acceptanceUnverified
			? { ...operation, acceptanceUnverified: undefined, acceptanceFence: fence }
			: operation,
	);
}

/** What one delivery receipt means for its record. Every deny path picks between refuse (the
 * receipt will NEVER apply here, retire it) and unresolved (cannot place it YET, hold it). */
export function decideAcceptance(args: {
	current: CodexPersistedAgent;
	operation: CodexStoredOperation;
	exchange: CodexStoredExchange;
	input: { turnId: string; delivery: string; threadId: string };
	resolvedTarget: CodexResolvedTarget;
	fence: CodexReconciliationFence;
}): CodexAcceptanceVerdict {
	const { current, operation, exchange, input, resolvedTarget, fence } = args;
	if (operation.state === "accepted") {
		// Accepted, but never fenced. Only reconciliation can say which child that acceptance came
		// from, so this receipt is unplaceable rather than wrong.
		if (operation.acceptanceUnverified) return { kind: "unplaceable" };
		if (
			operation.turnId !== input.turnId ||
			exchange.delivery !== input.delivery ||
			current.threadId !== input.threadId ||
			!sameTarget(current.resolvedTarget, resolvedTarget) ||
			!sameFence(operation.acceptanceFence, fence)
		) {
			return { kind: "conflict" };
		}
		return { kind: "replayed" };
	}
	const refuse = { kind: "refuse" } as const;
	if (operation.kind === "stop" || exchange.kind !== operation.kind) return refuse;
	if (operation.state !== "requested" || exchange.status !== "requested") return refuse;
	if (operation.kind === "start" && input.delivery !== "started") return refuse;

	// The turn this delivery was aimed at finished while the daemon was working on it. Both
	// deliveries reach here: the daemon may have started a fresh turn after seeing the old one end,
	// or it may have steered successfully and had its receipt overtaken by that turn's terminal.
	const expectedTurn = operation.preDispatch.turnId
		? current.turns.find((turn) => turn.id === operation.preDispatch.turnId)
		: undefined;
	const expectedSettled =
		expectedTurn !== undefined && expectedTurn.state !== "inProgress" && current.activeTurnId !== expectedTurn.id;
	const afterSettlement =
		operation.kind === "message" && operation.preDispatch.agentState === "working" && expectedSettled;
	const startedAfterSettlement = afterSettlement && input.delivery === "started";
	// A steer that landed in the settled turn IS a delivery: the prompt reached Codex and that
	// turn's answer is its answer. It must not reopen the turn, which is the one way recording it
	// could do damage.
	const steeredIntoSettledTurn = afterSettlement && input.delivery === "steered" && input.turnId === expectedTurn?.id;

	if (
		operation.kind === "message" &&
		((operation.preDispatch.agentState === "working" && input.delivery !== "steered" && !startedAfterSettlement) ||
			(operation.preDispatch.agentState === "idle" && input.delivery !== "started"))
	) {
		return refuse;
	}
	if (current.requestedTarget.kind !== resolvedTarget.kind) return refuse;
	if (
		(current.threadId && current.threadId !== input.threadId) ||
		(current.resolvedTarget && !sameTarget(current.resolvedTarget, resolvedTarget))
	) {
		return refuse;
	}
	if (startedAfterSettlement || steeredIntoSettledTurn) {
		// The record has necessarily moved: the terminal that settled the expected turn cleared the
		// active turn and advanced the fence. Requiring nothing to have changed would refuse the very
		// case these branches exist for, so the test is what the settlement itself must have produced.
		if (
			current.agentState !== "idle" ||
			current.activeTurnId !== undefined ||
			current.threadId !== operation.preDispatch.threadId ||
			!advancesFence(current.fence, fence)
		) {
			return refuse;
		}
	} else if (
		current.agentState !== operation.preDispatch.agentState ||
		current.threadId !== operation.preDispatch.threadId ||
		current.activeTurnId !== operation.preDispatch.turnId ||
		!sameFence(current.fence, operation.preDispatch.fence)
	) {
		return refuse;
	} else if (!advancesFence(operation.preDispatch.fence, fence)) {
		// A receipt from a different supervisor or generation is not a mismatch; it is a receipt this
		// gateway cannot place yet. Acknowledging it would retire the daemon's only copy.
		return { kind: "unresolved" };
	}
	const existingTurn = current.turns.find((turn) => turn.id === input.turnId);
	if (
		input.delivery === "steered" &&
		!steeredIntoSettledTurn &&
		(current.activeTurnId !== input.turnId || !existingTurn)
	) {
		return refuse;
	}
	if (input.delivery === "started" && existingTurn) {
		return refuse;
	}
	return { kind: "accept", steeredIntoSettledTurn };
}

/** The agent with one more commentary item folded into an in-progress turn; unchanged when the
 * item is already held. */
export function withActivity(
	agent: CodexPersistedAgent,
	turnIndex: number,
	itemId: string,
	text: string,
	at: number,
	fence: CodexReconciliationFence,
): CodexPersistedAgent {
	const turn = agent.turns[turnIndex]!;
	const activities = appendActivity(turn.activities, itemId, text);
	if (!activities) return agent;
	return CodexPersistedAgentSchema.parse({
		...agent,
		turns: replaceAt(agent.turns, turnIndex, { ...turn, activities, updatedAt: at }),
		fence,
		updatedAt: at,
	});
}

/** The agent with a turn settled by its terminal, idle again with the fence advanced. */
export function withTerminal(
	agent: CodexPersistedAgent,
	turnIndex: number,
	event: Extract<CodexDaemonEvent, { kind: "terminal" }>,
	at: number,
	fence: CodexReconciliationFence,
): CodexPersistedAgent {
	const turn = agent.turns[turnIndex]!;
	const base = { id: turn.id, activities: turn.activities, updatedAt: at };
	let settled: CodexStoredTurn;
	switch (event.state) {
		case "completed":
			settled = {
				...base,
				state: "completed",
				finalItemId: event.finalItemId,
				finalResponse: event.finalResponse,
			};
			break;
		case "failed":
			settled = { ...base, state: "failed", error: sanitizeCodexErrorText(event.error) };
			break;
		default:
			settled = { ...base, state: "interrupted" };
	}
	// An interrupt that lost the race to completion is still a finished stop, so the ending the turn
	// actually had settles it either way rather than only the interrupted one.
	const operations = agent.operations.map((operation) =>
		operation.kind === "stop" && operation.state === "requested" && operation.turnId === turn.id
			? { ...operation, state: "accepted" as const, acceptanceFence: fence, updatedAt: at }
			: operation,
	);
	return CodexPersistedAgentSchema.parse({
		...agent,
		agentState: "idle",
		activeTurnId: undefined,
		pendingInterrupt: undefined,
		turns: replaceAt(agent.turns, turnIndex, settled),
		operations,
		fence,
		updatedAt: at,
	});
}
