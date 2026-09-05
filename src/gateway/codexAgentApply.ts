import { classifyEventFence, fenceOf } from "../shared/agent-fence.js";
import {
	type CodexAgentCatalog,
	CodexAgentIdSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	type CodexDaemonReceipt,
	CodexOwnerKeySchema,
	type CodexPersistedAgent,
	CodexPersistedAgentSchema,
} from "../shared/codex-agent.js";
import type { SessionRecord } from "../shared/session-store.js";
import { applyCodexAgent, type CodexCatalogDeps, readCodexCatalog } from "./codexAgentPersistence.js";
import {
	failed,
	ignore,
	refenceUnverified,
	replaceAt,
	sameTarget,
	withActivity,
	withTerminal,
} from "./codexAgentReducers.js";
import type { CodexAcceptanceResult, CodexApplication, CodexDaemonDeliveryAcceptance } from "./codexAgentTypes.js";

export interface CodexReceiptApplierDeps extends CodexCatalogDeps {
	acceptDeliveryFromDaemon: (input: CodexDaemonDeliveryAcceptance) => CodexAcceptanceResult;
}

export interface CodexReceiptApplier {
	applyEvent: (event: CodexDaemonEvent, at: number) => CodexApplication;
	applyReceipt: (receipt: CodexDaemonReceipt, at: number) => CodexApplication;
	takeRefusalReason: (operationId: string) => string | undefined;
}

export function createCodexReceiptApplier(deps: CodexReceiptApplierDeps): CodexReceiptApplier {
	function locate(
		ownerKey: string,
		agentId: string,
	): { owner: SessionRecord; catalog: CodexAgentCatalog; index: number; agent: CodexPersistedAgent } | null {
		if (!CodexOwnerKeySchema.safeParse(ownerKey).success) return null;
		if (!CodexAgentIdSchema.safeParse(agentId).success) return null;
		const owner = deps.sessionStore.getByTeam(ownerKey);
		if (!owner) return null;
		const catalog = readCodexCatalog(deps, owner);
		const matches = catalog.agents.flatMap((agent, index) => (agent.agentId === agentId ? [index] : []));
		if (matches.length !== 1) return null;
		return { owner, catalog, index: matches[0]!, agent: catalog.agents[matches[0]!]! };
	}

	function applyEvent(event: CodexDaemonEvent, at: number): CodexApplication {
		const parsed = CodexDaemonEventSchema.safeParse(event);
		if (!parsed.success) return ignore("event failed validation");
		const located = locate(parsed.data.ownerKey, parsed.data.agentId);
		if (!located) return ignore("event did not resolve to one managed agent");
		const { owner, catalog, index, agent } = located;
		if (agent.threadId !== parsed.data.threadId) return ignore("event names a different thread");

		const fence = fenceOf(parsed.data);
		const standing = classifyEventFence(agent.fence, fence);
		if (standing === "duplicate") return ignore("event was already applied");
		if (standing === "foreign") return { disposition: "reconcile", owner, agent };

		const turnIndex = agent.turns.findIndex((turn) => turn.id === parsed.data.turnId);
		const turn = turnIndex < 0 ? undefined : agent.turns[turnIndex]!;
		// Unknown App Server turns must be retained for reconciliation.
		if (!turn) return { disposition: "reconcile", owner, agent };
		if (turn.state !== "inProgress") return ignore("turn is already settled");
		if (agent.activeTurnId !== turn.id) return { disposition: "reconcile", owner, agent };

		const timestamp = Math.max(at, agent.updatedAt);
		let next: CodexPersistedAgent;
		try {
			next =
				parsed.data.kind === "activity"
					? withActivity(agent, turnIndex, parsed.data.itemId, parsed.data.text, timestamp, fence)
					: withTerminal(agent, turnIndex, parsed.data, timestamp, fence);
		} catch {
			return failed("event did not produce a valid record");
		}
		if (next === agent) return ignore("activity was already retained");
		return applyCodexAgent(deps, owner, catalog, index, next);
	}

	const refusals = new Map<string, string>();

	function applyRejection(receipt: Extract<CodexDaemonReceipt, { kind: "rejected" }>, at: number): CodexApplication {
		if (receipt.operationId) {
			refusals.set(receipt.operationId, receipt.error);
			if (refusals.size > 256) refusals.delete(refusals.keys().next().value as string);
		}
		const located = locate(receipt.ownerKey, receipt.agentId);
		if (!located) return ignore("rejection did not resolve to one managed agent");
		const { owner, catalog, index, agent } = located;
		const operationIndex = agent.operations.findIndex((operation) => operation.operationId === receipt.operationId);
		if (!receipt.operationId || operationIndex < 0) return ignore("rejection named no known operation");
		const operation = agent.operations[operationIndex]!;
		// A refusal settles only operations still awaiting delivery.
		if (operation.state !== "requested") return ignore("operation is no longer awaiting delivery");

		const at2 = Math.max(at, agent.updatedAt);
		const exchangeIndex = agent.exchanges.findIndex((exchange) => exchange.operationId === receipt.operationId);
		try {
			const next = CodexPersistedAgentSchema.parse({
				...agent,
				agentState:
					operation.kind === "start"
						? "unavailable"
						: operation.kind === "message"
							? "recovering"
							: agent.agentState,
				pendingInterrupt:
					agent.pendingInterrupt?.operationId === receipt.operationId ? undefined : agent.pendingInterrupt,
				exchanges:
					exchangeIndex < 0
						? agent.exchanges
						: replaceAt(agent.exchanges, exchangeIndex, {
								...agent.exchanges[exchangeIndex]!,
								status: "indeterminate" as const,
							}),
				operations: replaceAt(agent.operations, operationIndex, {
					...operation,
					state: "indeterminate" as const,
					updatedAt: at2,
				}),
				updatedAt: at2,
			});
			return applyCodexAgent(deps, owner, catalog, index, next);
		} catch {
			return failed("rejection did not produce a valid record");
		}
	}

	function applyInterruptOutcome(
		receipt: Extract<CodexDaemonReceipt, { kind: "interruptResult" | "interruptFailed" }>,
		at: number,
	): CodexApplication {
		const located = locate(receipt.ownerKey, receipt.agentId);
		if (!located) return ignore("interrupt result did not resolve to one managed agent");
		const { owner, catalog, index, agent } = located;
		if (agent.threadId !== receipt.threadId) return ignore("interrupt result names a different thread");
		const pending = agent.pendingInterrupt;
		if (!pending || pending.operationId !== receipt.operationId || pending.turnId !== receipt.turnId) {
			return ignore("interrupt result does not match the pending interrupt");
		}
		const fence = fenceOf(receipt);
		const standing = classifyEventFence(agent.fence, fence);
		if (standing === "duplicate") return ignore("interrupt result was already applied");
		if (standing === "foreign") return { disposition: "reconcile", owner, agent };

		const at2 = Math.max(at, agent.updatedAt);
		const operationIndex = agent.operations.findIndex((operation) => operation.operationId === receipt.operationId);
		if (operationIndex < 0) return ignore("interrupt result named no known operation");
		const delivered = receipt.kind === "interruptResult";
		// An accepted interrupt waits for the turn terminal.
		try {
			const next = CodexPersistedAgentSchema.parse({
				...agent,
				pendingInterrupt: delivered ? agent.pendingInterrupt : undefined,
				operations: replaceAt(agent.operations, operationIndex, {
					...agent.operations[operationIndex]!,
					state: delivered ? ("accepted" as const) : ("indeterminate" as const),
					acceptanceFence: delivered ? fence : undefined,
					updatedAt: at2,
				}),
				fence,
				updatedAt: at2,
			});
			return applyCodexAgent(deps, owner, catalog, index, next);
		} catch {
			return failed("interrupt result did not produce a valid record");
		}
	}

	function applyReconciliation(
		receipt: Extract<CodexDaemonReceipt, { kind: "reconciled" }>,
		at: number,
	): CodexApplication {
		const located = locate(receipt.ownerKey, receipt.agentId);
		if (!located) return ignore("reconciliation did not resolve to one managed agent");
		const { owner, catalog, index, agent } = located;
		if (agent.threadId !== receipt.threadId) return ignore("reconciliation names a different thread");
		if (!sameTarget(agent.resolvedTarget, receipt.resolvedTarget)) {
			return ignore("reconciliation names a different execution target");
		}
		const fence = fenceOf(receipt);
		if (classifyEventFence(agent.fence, fence) === "duplicate") return ignore("reconciliation was already applied");

		const active = agent.activeTurnId
			? agent.turns.find((turn) => turn.id === agent.activeTurnId && turn.state === "inProgress")
			: undefined;
		const survives = active !== undefined && receipt.turnId === active.id && receipt.turnState === "inProgress";
		const at2 = Math.max(at, agent.updatedAt);
		try {
			const next = CodexPersistedAgentSchema.parse({
				...agent,
				agentState: active ? (survives ? "working" : "recovering") : "idle",
				operations: refenceUnverified(agent.operations, fence),
				fence,
				updatedAt: at2,
			});
			return applyCodexAgent(deps, owner, catalog, index, next);
		} catch {
			return failed("reconciliation did not produce a valid record");
		}
	}

	function applyReceipt(receipt: CodexDaemonReceipt, at: number): CodexApplication {
		switch (receipt.kind) {
			case "accepted": {
				try {
					const result = deps.acceptDeliveryFromDaemon({ ...receipt, fence: fenceOf(receipt), at });
					if (result.disposition !== "indeterminate") {
						return {
							disposition: "applied",
							owner: result.owner,
							agent: result.agent,
							catalogRevision: result.catalogRevision,
						};
					}
					if (result.unresolved)
						return { disposition: "reconcile", owner: result.owner, agent: result.agent };
					return {
						disposition: "applied",
						owner: result.owner,
						agent: result.agent,
						catalogRevision: result.catalogRevision,
					};
				} catch {
					return ignore("delivery receipt did not resolve to one managed operation");
				}
			}
			case "rejected":
				return applyRejection(receipt, at);
			case "interruptResult":
			case "interruptFailed":
				return applyInterruptOutcome(receipt, at);
			case "reconciled":
				return applyReconciliation(receipt, at);
			default:
				return ignore("unsupported receipt kind");
		}
	}

	function takeRefusalReason(operationId: string): string | undefined {
		const reason = refusals.get(operationId);
		refusals.delete(operationId);
		return reason;
	}

	return { applyEvent, applyReceipt, takeRefusalReason };
}
