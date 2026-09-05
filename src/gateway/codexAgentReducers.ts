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
import type { SessionRecord } from "../shared/session-store.js";
import { type CodexAcceptanceResult, type CodexApplication, CodexTransitionError } from "./codexAgentTypes.js";

export type CodexAcceptanceVerdict =
	| { kind: "replayed" }
	| { kind: "unplaceable" }
	| { kind: "conflict" }
	| { kind: "refuse" }
	| { kind: "unresolved" }
	| { kind: "accept"; steeredIntoSettledTurn: boolean };

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

// Count only requested operations or one refusal wedges the agent.
export function hasPendingPrompt(agent: CodexPersistedAgent): boolean {
	return agent.operations.some(
		(operation) => (operation.kind === "start" || operation.kind === "message") && operation.state === "requested",
	);
}

export function ignore(reason: string): CodexApplication {
	return { disposition: "ignored", reason };
}

export function failed(reason: string): CodexApplication {
	return { disposition: "failed", reason };
}

export function appendActivity(
	existing: readonly CodexStoredActivity[],
	itemId: string,
	text: string,
): CodexStoredActivity[] | null {
	return appendAgentActivity(existing, itemId, text, CODEX_ACTIVITY_MAX_ITEMS) as CodexStoredActivity[] | null;
}

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
		// Unfenced acceptance needs reconciliation before placement.
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

	const expectedTurn = operation.preDispatch.turnId
		? current.turns.find((turn) => turn.id === operation.preDispatch.turnId)
		: undefined;
	const expectedSettled =
		expectedTurn !== undefined && expectedTurn.state !== "inProgress" && current.activeTurnId !== expectedTurn.id;
	const afterSettlement =
		operation.kind === "message" && operation.preDispatch.agentState === "working" && expectedSettled;
	const startedAfterSettlement = afterSettlement && input.delivery === "started";
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
		// Do not acknowledge receipts from an older supervisor fence.
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

export function indeterminate(
	owner: SessionRecord,
	agent: CodexPersistedAgent,
	operation: CodexStoredOperation,
	catalogRevision: number,
	unresolved?: true,
): CodexAcceptanceResult {
	return { owner, agent, operation, disposition: "indeterminate", catalogRevision, unresolved };
}
