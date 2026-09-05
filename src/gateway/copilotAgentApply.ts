import { classifyAcceptanceFence, fenceOf } from "../shared/agent-fence.js";
import {
	type CopilotDaemonEvent,
	type CopilotDaemonFailureCode,
	type CopilotDaemonReceipt,
	CopilotDaemonReceiptSchema,
	type CopilotPersistedAgent,
	CopilotPersistedAgentSchema,
	type CopilotStoredTurn,
} from "../shared/copilot-agent.js";
import type { SessionRecord } from "../shared/session-store.js";
import { applyCopilotAgent, type CopilotCatalogDeps } from "./copilotAgentPersistence.js";
import { appendActivity, replaceAt, resolvedTargetMatchesRequest, sameResolvedTarget } from "./copilotAgentReducers.js";
import type { CopilotApplication } from "./copilotAgentTypes.js";

////////////////////////////////
//  Interfaces & Types

export interface CopilotReceiptApplier {
	applyReceipt: (receipt: CopilotDaemonReceipt, at: number) => CopilotApplication;
	applyEvent: (event: CopilotDaemonEvent, at: number) => CopilotApplication;
	takeRefusal: (operationId: string) => { code?: CopilotDaemonFailureCode; message: string } | undefined;
}

////////////////////////////////
//  Functions & Helpers

/** Session-owned folding of Copilot daemon events and receipts into their agent records. */
export function createCopilotReceiptApplier(deps: CopilotCatalogDeps): CopilotReceiptApplier {
	function applyAccepted(
		owner: SessionRecord,
		current: CopilotPersistedAgent,
		receipt: Extract<CopilotDaemonReceipt, { kind: "accepted" }>,
		at: number,
	): CopilotApplication {
		const operationIndex = current.operations.findIndex(
			(operation) => operation.operationId === receipt.operationId,
		);
		if (operationIndex < 0) return { disposition: "ignored", reason: "operation not found" };
		const operation = current.operations[operationIndex]!;
		if (operation.state === "accepted") return { disposition: "ignored", reason: "duplicate acceptance" };
		if (operation.state !== "requested") return { disposition: "ignored", reason: "operation already settled" };
		if (operation.kind === "stop") return { disposition: "ignored", reason: "stop cannot accept a prompt" };
		if (current.turns.some((turn) => turn.id === receipt.turnId))
			return { disposition: "reconcile", owner, agent: current };
		const fence = fenceOf(receipt);
		const fencePosition = classifyAcceptanceFence(current.fence, fence);
		if (fencePosition === "duplicate") return { disposition: "ignored", reason: "duplicate acceptance fence" };
		if (fencePosition === "foreign") return { disposition: "reconcile", owner, agent: current };
		if (
			(operation.kind === "start" &&
				(receipt.delivery !== "started" ||
					!resolvedTargetMatchesRequest(current.requestedTarget, receipt.resolvedTarget))) ||
			(operation.kind === "message" &&
				(receipt.delivery !== "followup" ||
					receipt.sessionId !== operation.sessionId ||
					!current.resolvedTarget ||
					!sameResolvedTarget(current.resolvedTarget, receipt.resolvedTarget)))
		)
			return { disposition: "reconcile", owner, agent: current };
		const timestamp = Math.max(at, current.updatedAt);
		const turn: CopilotStoredTurn = {
			id: receipt.turnId,
			state: "inProgress",
			activities: [],
			updatedAt: timestamp,
		};
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			agentState: "working",
			resolvedTarget: receipt.resolvedTarget,
			sessionId: receipt.sessionId,
			activeTurnId: receipt.turnId,
			turns: [...current.turns, turn],
			fence,
			operations: replaceAt(current.operations, operationIndex, {
				...operation,
				state: "accepted",
				turnId: receipt.turnId,
				sessionId: receipt.sessionId,
				updatedAt: timestamp,
			}),
			updatedAt: timestamp,
		});
		return applyCopilotAgent(deps, owner, current, next);
	}

	function applyInterrupt(
		owner: SessionRecord,
		current: CopilotPersistedAgent,
		receipt: Extract<CopilotDaemonReceipt, { kind: "interruptResult" }>,
		at: number,
	): CopilotApplication {
		const operationId = receipt.operationId;
		const index = current.operations.findIndex((operation) => operation.operationId === operationId);
		if (index < 0) return { disposition: "ignored", reason: "operation not found" };
		const operation = current.operations[index]!;
		if (operation.state === "accepted") return { disposition: "ignored", reason: "duplicate interrupt acceptance" };
		if (operation.state !== "requested" || operation.kind !== "stop")
			return { disposition: "ignored", reason: "interrupt operation already settled" };
		const fence = fenceOf(receipt);
		const fencePosition = classifyAcceptanceFence(current.fence, fence);
		if (fencePosition === "duplicate") return { disposition: "ignored", reason: "duplicate interrupt fence" };
		if (fencePosition === "foreign") return { disposition: "reconcile", owner, agent: current };
		if (current.activeTurnId !== receipt.turnId) return { disposition: "reconcile", owner, agent: current };
		if (operation.sessionId !== receipt.sessionId || operation.turnId !== receipt.turnId)
			return { disposition: "reconcile", owner, agent: current };
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			operations: replaceAt(current.operations, index, {
				...operation,
				state: "accepted",
				updatedAt: Math.max(at, current.updatedAt),
			}),
			updatedAt: Math.max(at, current.updatedAt),
		});
		return applyCopilotAgent(deps, owner, current, next);
	}

	function applyReconciled(
		owner: SessionRecord,
		current: CopilotPersistedAgent,
		receipt: Extract<CopilotDaemonReceipt, { kind: "reconciled" }>,
		at: number,
	): CopilotApplication {
		const timestamp = Math.max(at, current.updatedAt);
		if (
			!current.sessionId ||
			!current.resolvedTarget ||
			current.sessionId !== receipt.sessionId ||
			current.resolvedTarget.targetId !== receipt.targetId
		)
			return { disposition: "ignored", reason: "reconciliation names a different session" };
		const fence = fenceOf(receipt);
		if (classifyAcceptanceFence(current.fence, fence) === "duplicate")
			return { disposition: "ignored", reason: "duplicate reconciliation" };
		const activeTurn = receipt.active && receipt.turnId ? receipt.turnId : undefined;
		if (current.activeTurnId && activeTurn && current.activeTurnId !== activeTurn)
			return { disposition: "reconcile", owner, agent: current };
		// ACP session/load can prove that the session exists, but it does not return a turn status. Keep a
		// previously active turn recovering rather than translating that absence of proof into idle.
		const knownActiveTurn = current.activeTurnId;
		const nextTurns =
			activeTurn && !current.turns.some((turn) => turn.id === activeTurn)
				? [
						...current.turns,
						{ id: activeTurn, state: "inProgress" as const, activities: [], updatedAt: timestamp },
					]
				: current.turns;
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			agentState: activeTurn ? "working" : knownActiveTurn ? "recovering" : "idle",
			activeTurnId: activeTurn ?? knownActiveTurn,
			turns: nextTurns,
			fence,
			updatedAt: timestamp,
		});
		return applyCopilotAgent(deps, owner, current, next);
	}

	/** Bounded to the live operations it is about; an entry is dropped when its result is reported.
	 * Kept off the persisted record deliberately: it is a diagnostic, not agent state. */
	const refusalReasons = new Map<string, string>();
	const refusalCodes = new Map<string, CopilotDaemonFailureCode>();

	function applyRejected(
		owner: SessionRecord,
		current: CopilotPersistedAgent,
		operationId: string | undefined,
		error: string,
		failureCode: CopilotDaemonFailureCode | undefined,
		at: number,
	): CopilotApplication {
		if (!operationId) return { disposition: "ignored", reason: "rejected reconcile" };
		const index = current.operations.findIndex((operation) => operation.operationId === operationId);
		if (index < 0) return { disposition: "ignored", reason: "operation not found" };
		if (current.operations[index]!.state !== "requested")
			return { disposition: "ignored", reason: "rejection arrived after settlement" };
		refusalReasons.set(operationId, error);
		if (failureCode) refusalCodes.set(operationId, failureCode);
		const timestamp = Math.max(at, current.updatedAt);
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			agentState: current.agentState === "creating" ? "unavailable" : "recovering",
			operations: replaceAt(current.operations, index, {
				...current.operations[index]!,
				state: "indeterminate",
				updatedAt: timestamp,
			}),
			updatedAt: timestamp,
		});
		return applyCopilotAgent(deps, owner, current, next);
	}

	function applyReceipt(receipt: CopilotDaemonReceipt, at: number): CopilotApplication {
		const parsed = CopilotDaemonReceiptSchema.safeParse(receipt);
		if (!parsed.success) return { disposition: "failed", reason: "invalid Copilot receipt" };
		const owner = deps.sessionStore.getByTeam(parsed.data.ownerKey);
		if (!owner) return { disposition: "ignored", reason: "owner not found" };
		const current = deps.sessionStore
			.listCopilotAgents(owner)
			.find((agent) => agent.agentId === parsed.data.agentId);
		if (!current) return { disposition: "ignored", reason: "agent not found" };
		if (parsed.data.kind === "rejected")
			return applyRejected(
				owner,
				current,
				parsed.data.operationId,
				parsed.data.error,
				parsed.data.failureCode,
				at,
			);
		if (parsed.data.kind === "accepted") return applyAccepted(owner, current, parsed.data, at);
		if (parsed.data.kind === "interruptResult") return applyInterrupt(owner, current, parsed.data, at);
		return applyReconciled(owner, current, parsed.data, at);
	}

	function applyEvent(event: CopilotDaemonEvent, at: number): CopilotApplication {
		const owner = deps.sessionStore.getByTeam(event.ownerKey);
		if (!owner) return { disposition: "ignored", reason: "owner not found" };
		const current = deps.sessionStore.listCopilotAgents(owner).find((agent) => agent.agentId === event.agentId);
		if (!current) return { disposition: "ignored", reason: "agent not found" };
		if (
			!current.sessionId ||
			!current.resolvedTarget ||
			current.sessionId !== event.sessionId ||
			current.resolvedTarget.targetId !== event.targetId
		)
			return { disposition: "reconcile", owner, agent: current };
		const fence = fenceOf(event);
		const position = classifyAcceptanceFence(current.fence, fence);
		if (position === "duplicate") return { disposition: "ignored", reason: "duplicate event" };
		if (position === "foreign") return { disposition: "reconcile", owner, agent: current };
		const turnIndex = current.turns.findIndex((turn) => turn.id === event.turnId);
		if (turnIndex < 0) return { disposition: "reconcile", owner, agent: current };
		if (current.activeTurnId !== event.turnId) return { disposition: "reconcile", owner, agent: current };
		const turn = current.turns[turnIndex]!;
		if (event.kind === "activity") {
			if (turn.state !== "inProgress") return { disposition: "ignored", reason: "activity after terminal" };
			const nextTurn = {
				...turn,
				activities: appendActivity(turn.activities, event.itemId, event.text),
				updatedAt: Math.max(at, turn.updatedAt),
			};
			const next = CopilotPersistedAgentSchema.parse({
				...current,
				turns: replaceAt(current.turns, turnIndex, nextTurn),
				fence,
				updatedAt: Math.max(at, current.updatedAt),
			});
			return applyCopilotAgent(deps, owner, current, next);
		}
		if (turn.state !== "inProgress") return { disposition: "ignored", reason: "duplicate terminal" };
		const timestamp = Math.max(at, current.updatedAt);
		const terminal: CopilotStoredTurn =
			event.state === "completed"
				? { ...turn, state: "completed", finalResponse: event.finalResponse ?? "", updatedAt: timestamp }
				: event.state === "failed"
					? { ...turn, state: "failed", error: event.error ?? "Copilot turn failed", updatedAt: timestamp }
					: { ...turn, state: "interrupted", updatedAt: timestamp };
		const operations = current.operations.map((operation) =>
			operation.kind === "stop" && operation.state === "requested" && operation.turnId === event.turnId
				? { ...operation, state: "accepted" as const, updatedAt: timestamp }
				: operation,
		);
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			agentState: "idle",
			activeTurnId: undefined,
			operations,
			turns: replaceAt(current.turns, turnIndex, terminal),
			fence,
			updatedAt: timestamp,
		});
		return applyCopilotAgent(deps, owner, current, next);
	}

	function takeRefusal(operationId: string): { code?: CopilotDaemonFailureCode; message: string } | undefined {
		const reason = refusalReasons.get(operationId);
		const code = refusalCodes.get(operationId);
		refusalReasons.delete(operationId);
		refusalCodes.delete(operationId);
		return reason ? { ...(code ? { code } : {}), message: reason } : undefined;
	}

	return { applyReceipt, applyEvent, takeRefusal };
}
