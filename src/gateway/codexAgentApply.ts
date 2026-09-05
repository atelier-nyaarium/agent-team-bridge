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

////////////////////////////////
//  Interfaces & Types

export interface CodexReceiptApplierDeps extends CodexCatalogDeps {
	acceptDeliveryFromDaemon: (input: CodexDaemonDeliveryAcceptance) => CodexAcceptanceResult;
}

export interface CodexReceiptApplier {
	applyEvent: (event: CodexDaemonEvent, at: number) => CodexApplication;
	applyReceipt: (receipt: CodexDaemonReceipt, at: number) => CodexApplication;
	takeRefusalReason: (operationId: string) => string | undefined;
}

////////////////////////////////
//  Functions & Helpers

/** Session-owned folding of Codex daemon events and receipts into their agent records. */
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

	/** Fold one asynchronous App Server event into the record it belongs to. */
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
		// An event for a turn this record has never heard of is the one case that must not be dropped:
		// the acceptance that would have created it may simply have been refused, and only App Server
		// can say whether the turn is real.
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

	/** Why the daemon last refused an operation, so a caller learns the cause instead of a generic
	 * timeout. Bounded to the live operations it is about; an entry is dropped when its result is
	 * reported. Kept off the persisted record deliberately: it is a diagnostic, not agent state. */
	const refusals = new Map<string, string>();

	function applyRejection(receipt: Extract<CodexDaemonReceipt, { kind: "rejected" }>, at: number): CodexApplication {
		// The reason is the whole value of a refusal: without it, a caller sees only a generic
		// "delivery was not confirmed within the wait budget" in place of the actual cause (e.g. "model
		// not offered: <id>"), which is both useless and untrue - the daemon did explain, and that
		// explanation must reach the caller rather than being discarded here.
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
		// A refusal is proof of NON-delivery, so it only ever settles something still in flight. Anything
		// already accepted was delivered, whatever a late refusal says.
		if (operation.state !== "requested") return ignore("operation is no longer awaiting delivery");

		const at2 = Math.max(at, agent.updatedAt);
		const exchangeIndex = agent.exchanges.findIndex((exchange) => exchange.operationId === receipt.operationId);
		try {
			const next = CodexPersistedAgentSchema.parse({
				...agent,
				// A refused start has no thread to reuse and nothing to reconcile, so it is unavailable
				// rather than still being created. A refused MESSAGE does have a thread, and the daemon
				// only ever proves non-delivery as far as it could read: it goes to recovering so no
				// second prompt can be sent until reconciliation says what that thread is actually doing.
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
		try {
			const next = CodexPersistedAgentSchema.parse({
				...agent,
				// A delivered interrupt is not an ending. The turn is still running until its own terminal
				// lands, which is what clears this.
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
		// The one path a foreign fence is legitimate on: this IS what re-establishes which supervisor
		// and which child speak for this agent. Every other path refuses one.
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
				// A turn App Server no longer reports as running is over, but its outcome rides the terminal
				// event that follows under this freshly installed fence. Recovering is what the record says
				// in between; it is not a resting state.
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

	/** Fold one authenticated daemon receipt into the record it belongs to. */
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
					// A refusal settles the operation.
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

	/** The daemon's own reason for refusing an operation, consumed once. */
	function takeRefusalReason(operationId: string): string | undefined {
		const reason = refusals.get(operationId);
		refusals.delete(operationId);
		return reason;
	}

	return { applyEvent, applyReceipt, takeRefusalReason };
}
