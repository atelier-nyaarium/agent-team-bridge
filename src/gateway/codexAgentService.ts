import { classifyEventFence, fenceOf } from "../shared/agent-fence.js";
import {
	type CodexAgentCatalog,
	CodexAgentIdSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	type CodexDaemonReceipt,
	type CodexExecutionTarget,
	CodexExecutionTargetSchema,
	CodexOperationIdSchema,
	CodexOwnerKeySchema,
	type CodexPersistedAgent,
	CodexPersistedAgentSchema,
	CodexPromptSchema,
	CodexReconciliationFenceSchema,
	CodexResolvedTargetSchema,
	type CodexStoredOperation,
	codexOperationFingerprint,
} from "../shared/codex-thinking.js";
import type { CodexCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import {
	decideAcceptance,
	failed,
	hasPendingPrompt,
	ignore,
	refenceUnverified,
	replaceAt,
	sameTarget,
	validateTimestamp,
	withActivity,
	withTerminal,
} from "./codexAgentReducers.js";
import {
	type CodexAcceptanceResult,
	type CodexAgentServiceDeps,
	type CodexApplication,
	type CodexDaemonDeliveryAcceptance,
	type CodexDeliveryAcceptance,
	type CodexExistingAgentIntentInput,
	type CodexStartIntentInput,
	type CodexStopIntentInput,
	CodexTransitionError,
	type CodexTransitionResult,
	type OwnedCodexAgent,
	type OwnedCodexOperation,
} from "./codexAgentTypes.js";
import type { SessionAuthority } from "./sessionAuthority.js";

export type {
	CodexAcceptanceResult,
	CodexAgentServiceDeps,
	CodexApplication,
	CodexDaemonDeliveryAcceptance,
	CodexDeliveryAcceptance,
	CodexExistingAgentIntentInput,
	CodexIntentInput,
	CodexStartIntentInput,
	CodexStopIntentInput,
	CodexTransitionErrorCode,
	CodexTransitionResult,
	OwnedCodexAgent,
	OwnedCodexOperation,
} from "./codexAgentTypes.js";
export { CodexTransitionError } from "./codexAgentTypes.js";

////////////////////////////////
//  Class

/** Session-owned gateway boundary for Codex access and state transitions. Route and daemon
 * adapters resolve through this service rather than receiving catalog authority directly. */
export class CodexAgentService {
	private readonly auth: SessionAuthority;
	private readonly sessionStore: SessionStore;
	private readonly offlineCatalog: ReadonlyMap<string, string>;
	private readonly catalogWriter: CodexCatalogWriter;

	constructor(deps: CodexAgentServiceDeps) {
		this.auth = deps.auth;
		this.sessionStore = deps.sessionStore;
		this.offlineCatalog = deps.offlineCatalog;
		this.catalogWriter = deps.catalogWriter;
	}

	resolveOwner(req: Request): SessionRecord | null {
		return this.auth.resolveConfirmedManagedSession(req);
	}

	/** The canonical key the daemon echoes on every command and receipt. Never accepted from a caller;
	 * this is the only place it is produced. */
	ownerKeyOf(owner: SessionRecord): string {
		return this.sessionStore.teamOf(owner);
	}

	listOwnedAgents(owner: SessionRecord): readonly CodexPersistedAgent[] {
		return this.sessionStore.listCodexAgents(owner);
	}

	/** `cwd` overrides the session's own workdir for a host target. The daemon still resolves it, so an
	 * unusable path lands in home rather than anywhere a caller named. */
	resolveExecutionTarget(owner: SessionRecord, cwd?: string): CodexExecutionTarget | null {
		let target: CodexExecutionTarget;
		if (owner.spawn === "host") {
			target = { kind: "host", workdirHint: cwd ?? this.sessionStore.hostWorkdirHint(owner) };
		} else {
			const hostProjectPath = this.offlineCatalog.get(owner.spawn);
			if (!hostProjectPath) return null;
			target = { kind: "devcontainer", project: owner.spawn, hostProjectPath };
		}
		const validated = CodexExecutionTargetSchema.safeParse(target);
		return validated.success ? validated.data : null;
	}

	resolveOwnedAgent(req: Request, agentId: string): OwnedCodexAgent | null {
		if (!CodexAgentIdSchema.safeParse(agentId).success) return null;
		const owner = this.resolveOwner(req);
		if (!owner) return null;
		const matches = this.sessionStore.listCodexAgents(owner).filter((agent) => agent.agentId === agentId);
		return matches.length === 1 ? { owner, agent: matches[0]! } : null;
	}

	resolveOwnedOperation(req: Request, agentId: string, operationId: string): OwnedCodexOperation | null {
		if (!CodexOperationIdSchema.safeParse(operationId).success) return null;
		const owned = this.resolveOwnedAgent(req, agentId);
		if (!owned) return null;
		const matches = owned.agent.operations.filter((operation) => operation.operationId === operationId);
		return matches.length === 1 ? { ...owned, operation: matches[0]! } : null;
	}

	beginStart(req: Request, input: CodexStartIntentInput): CodexTransitionResult {
		const owner = this.requireOwner(req);
		const agentId = CodexAgentIdSchema.parse(input.agentId);
		const operationId = CodexOperationIdSchema.parse(input.operationId);
		const prompt = CodexPromptSchema.parse(input.prompt);
		// Taken from the caller rather than re-resolved: the route resolves with the request's cwd,
		// and a second resolve here would persist a different target than the one dispatched.
		const target = CodexExecutionTargetSchema.parse(input.target);
		const at = validateTimestamp(input.at);
		const fingerprint = codexOperationFingerprint("start", agentId, prompt);
		const replay = this.replay(owner, operationId, fingerprint);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		if (catalog.agents.some((agent) => agent.agentId === agentId)) {
			throw new CodexTransitionError("operation_conflict", "agent ID is already in use");
		}
		const agent = CodexPersistedAgentSchema.parse({
			version: 1,
			agentId,
			agentState: "creating",
			requestedTarget: target,
			exchanges: [
				{
					exchangeId: operationId,
					operationId,
					kind: "start",
					prompt,
					status: "requested",
					createdAt: at,
				},
			],
			turns: [],
			operations: [
				{
					operationId,
					kind: "start",
					fingerprint,
					state: "requested",
					preDispatch: { agentState: "creating" },
					createdAt: at,
					updatedAt: at,
				},
			],
			createdAt: at,
			updatedAt: at,
		});
		return this.commit(owner, catalog, [...catalog.agents, agent], agent, operationId);
	}

	beginMessage(req: Request, input: CodexExistingAgentIntentInput): CodexTransitionResult {
		const owner = this.requireOwner(req);
		const agentId = CodexAgentIdSchema.parse(input.agentId);
		const operationId = CodexOperationIdSchema.parse(input.operationId);
		const prompt = CodexPromptSchema.parse(input.prompt);
		const at = validateTimestamp(input.at);
		const fingerprint = codexOperationFingerprint("message", agentId, prompt);
		const replay = this.replay(owner, operationId, fingerprint);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		const index = this.agentIndex(catalog, agentId);
		const current = catalog.agents[index]!;
		if (
			!current.threadId ||
			!current.fence ||
			(current.agentState !== "idle" && current.agentState !== "working")
		) {
			throw new CodexTransitionError("state_conflict", "agent cannot accept a follow-up in its current state");
		}
		if (current.pendingInterrupt) {
			throw new CodexTransitionError("state_conflict", "agent cannot accept a message while interrupting");
		}
		if (hasPendingPrompt(current)) {
			throw new CodexTransitionError("state_conflict", "agent already has an unresolved prompt delivery");
		}
		const timestamp = Math.max(at, current.updatedAt);
		const next = CodexPersistedAgentSchema.parse({
			...current,
			exchanges: [
				...current.exchanges,
				{
					exchangeId: operationId,
					operationId,
					kind: "message",
					prompt,
					status: "requested",
					createdAt: timestamp,
				},
			],
			operations: [
				...current.operations,
				{
					operationId,
					kind: "message",
					fingerprint,
					state: "requested",
					expectedTurnId: current.activeTurnId,
					preDispatch: {
						agentState: current.agentState,
						threadId: current.threadId,
						turnId: current.activeTurnId,
						fence: current.fence,
					},
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			],
			updatedAt: timestamp,
		});
		const agents = replaceAt(catalog.agents, index, next);
		return this.commit(owner, catalog, agents, next, operationId);
	}

	beginStop(req: Request, input: CodexStopIntentInput): CodexTransitionResult {
		const owner = this.requireOwner(req);
		const agentId = CodexAgentIdSchema.parse(input.agentId);
		const operationId = CodexOperationIdSchema.parse(input.operationId);
		const at = validateTimestamp(input.at);
		const fingerprint = codexOperationFingerprint("stop", agentId);
		const replay = this.replay(owner, operationId, fingerprint);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		const index = this.agentIndex(catalog, agentId);
		const current = catalog.agents[index]!;
		if (
			!current.threadId ||
			!current.fence ||
			(current.agentState !== "idle" && current.agentState !== "working")
		) {
			throw new CodexTransitionError("state_conflict", "agent cannot be stopped in its current state");
		}
		if (current.pendingInterrupt) {
			throw new CodexTransitionError("state_conflict", "an interrupt is already pending");
		}
		if (hasPendingPrompt(current)) {
			throw new CodexTransitionError("state_conflict", "agent has an unresolved prompt delivery");
		}
		const timestamp = Math.max(at, current.updatedAt);
		const noOp = current.agentState === "idle";
		const operation = {
			operationId,
			kind: "stop" as const,
			fingerprint,
			state: noOp ? ("accepted" as const) : ("requested" as const),
			turnId: current.activeTurnId,
			preDispatch: {
				agentState: current.agentState,
				threadId: current.threadId,
				turnId: current.activeTurnId,
				fence: current.fence,
			},
			noOp: noOp ? (true as const) : undefined,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const next = CodexPersistedAgentSchema.parse({
			...current,
			operations: [...current.operations, operation],
			pendingInterrupt: noOp ? undefined : { operationId, turnId: current.activeTurnId, requestedAt: timestamp },
			updatedAt: timestamp,
		});
		return this.commit(owner, catalog, replaceAt(catalog.agents, index, next), next, operationId);
	}

	acceptDelivery(req: Request, input: CodexDeliveryAcceptance): CodexAcceptanceResult {
		return this.acceptDeliveryForOwner(this.requireOwner(req), input);
	}

	/** Applies an authenticated host receipt after correlating it to one exact stored owner. */
	acceptDeliveryFromDaemon(input: CodexDaemonDeliveryAcceptance): CodexAcceptanceResult {
		const ownerKey = CodexOwnerKeySchema.parse(input.ownerKey);
		const agentId = CodexAgentIdSchema.parse(input.agentId);
		const operationId = CodexOperationIdSchema.parse(input.operationId);
		const owner = this.sessionStore.getByTeam(ownerKey);
		const matches = (owner ? this.sessionStore.listCodexAgents(owner) : []).filter(
			(agent) =>
				agent.agentId === agentId &&
				agent.operations.some((operation) => operation.operationId === operationId),
		);
		if (!owner || matches.length !== 1) {
			throw new CodexTransitionError("not_found", "receipt did not resolve to one managed operation");
		}
		return this.acceptDeliveryForOwner(owner, input);
	}

	private acceptDeliveryForOwner(owner: SessionRecord, input: CodexDeliveryAcceptance): CodexAcceptanceResult {
		const agentId = CodexAgentIdSchema.parse(input.agentId);
		const operationId = CodexOperationIdSchema.parse(input.operationId);
		const resolvedTarget = CodexResolvedTargetSchema.parse(input.resolvedTarget);
		const fence = CodexReconciliationFenceSchema.parse(input.fence);
		const at = validateTimestamp(input.at);
		const catalog = this.catalog(owner);
		const index = this.agentIndex(catalog, agentId);
		const current = catalog.agents[index]!;
		const operationIndex = current.operations.findIndex((operation) => operation.operationId === operationId);
		const exchangeIndex = current.exchanges.findIndex((exchange) => exchange.operationId === operationId);
		if (operationIndex < 0 || exchangeIndex < 0) {
			throw new CodexTransitionError("not_found", "operation was not found for this agent");
		}
		const operation = current.operations[operationIndex]!;
		const exchange = current.exchanges[exchangeIndex]!;
		const verdict = decideAcceptance({
			current,
			operation,
			exchange,
			input: { turnId: input.turnId, delivery: input.delivery, threadId: input.threadId },
			resolvedTarget,
			fence,
		});
		switch (verdict.kind) {
			case "unplaceable":
				return this.indeterminate(owner, current, operation, catalog.revision, true);
			case "conflict":
				throw new CodexTransitionError("operation_conflict", "accepted delivery does not match its receipt");
			case "replayed":
				if (!this.ensureCatalogDurable(owner, catalog.revision)) {
					return this.indeterminate(owner, current, operation, catalog.revision, true);
				}
				return { owner, agent: current, operation, disposition: "replayed", catalogRevision: catalog.revision };
			case "refuse":
				// A receipt the gateway refuses SETTLES its operation rather than leaving it requested:
				// nothing else ever transitions one, the daemon has been told it may retire the receipt,
				// and a requested prompt blocks every later message and stop for the agent's whole life.
				return this.refuseDelivery(owner, catalog, index, operationIndex, exchangeIndex, at);
			case "unresolved":
				return this.indeterminate(owner, current, operation, catalog.revision, true);
		}
		const { steeredIntoSettledTurn } = verdict;
		const existingTurn = current.turns.find((turn) => turn.id === input.turnId);
		try {
			const timestamp = Math.max(at, current.updatedAt);
			const turns = !existingTurn
				? [
						...current.turns,
						{ id: input.turnId, state: "inProgress" as const, activities: [], updatedAt: timestamp },
					]
				: steeredIntoSettledTurn
					? // The turn settled before this delivery was recorded against it, and a turn may not
						// predate its own accepted delivery. Touching it keeps the ordering invariant true
						// without changing what the turn is or what it answered.
						current.turns.map((turn) =>
							turn.id === input.turnId ? { ...turn, updatedAt: timestamp } : turn,
						)
					: current.turns;
			const acceptedOperation = {
				...operation,
				state: "accepted" as const,
				turnId: input.turnId,
				acceptanceFence: fence,
				updatedAt: timestamp,
			};
			const acceptedExchange = {
				...exchange,
				status: "accepted" as const,
				delivery: input.delivery,
				turnId: input.turnId,
				acceptedAt: timestamp,
			};
			const next = CodexPersistedAgentSchema.parse({
				...current,
				// A steer into an already-settled turn records the delivery and nothing else. Reopening
				// that turn would resurrect a finished one as the agent's active work.
				agentState: steeredIntoSettledTurn ? current.agentState : "working",
				resolvedTarget,
				threadId: input.threadId,
				activeTurnId: steeredIntoSettledTurn ? current.activeTurnId : input.turnId,
				turns,
				exchanges: replaceAt(current.exchanges, exchangeIndex, acceptedExchange),
				operations: replaceAt(current.operations, operationIndex, acceptedOperation),
				fence,
				updatedAt: timestamp,
			});
			return this.commit(owner, catalog, replaceAt(catalog.agents, index, next), next, operationId);
		} catch {
			// The record could not be written. Nothing about the receipt was wrong, so it must stay with
			// the daemon rather than being acknowledged away on a disk error.
			return this.indeterminate(owner, current, operation, catalog.revision, true);
		}
	}

	/**
	 * Settle a delivery this gateway will not accept.
	 *
	 * The operation and its exchange become indeterminate, and the agent enters recovery so no second
	 * prompt goes out on a thread whose state is now in doubt. A write failure here is reported as
	 * unresolved, since an unpersisted refusal must not be acknowledged away either.
	 */
	private refuseDelivery(
		owner: SessionRecord,
		catalog: CodexAgentCatalog,
		index: number,
		operationIndex: number,
		exchangeIndex: number,
		at: number,
	): CodexAcceptanceResult {
		const current = catalog.agents[index]!;
		const operation = current.operations[operationIndex]!;
		if (operation.state !== "requested") {
			return this.indeterminate(owner, current, operation, catalog.revision);
		}
		const timestamp = Math.max(at, current.updatedAt);
		try {
			const next = CodexPersistedAgentSchema.parse({
				...current,
				agentState: operation.kind === "start" ? "unavailable" : "recovering",
				operations: replaceAt(current.operations, operationIndex, {
					...operation,
					state: "indeterminate" as const,
					updatedAt: timestamp,
				}),
				exchanges: replaceAt(current.exchanges, exchangeIndex, {
					...current.exchanges[exchangeIndex]!,
					status: "indeterminate" as const,
				}),
				updatedAt: timestamp,
			});
			const committed = this.commit(
				owner,
				catalog,
				replaceAt(catalog.agents, index, next),
				next,
				operation.operationId,
			);
			return { ...committed, disposition: "indeterminate" };
		} catch {
			return this.indeterminate(owner, current, operation, catalog.revision, true);
		}
	}

	/**
	 * Give up on a delivery whose acceptance never arrived, settling it the way a refusal would.
	 *
	 * A caller that has spent its whole wait budget with nothing proven is in the same position as one
	 * holding a refusal: the prompt may or may not have landed. Leaving the operation `requested` would
	 * block every later message and stop for the agent with nothing able to clear it.
	 */
	abandonDelivery(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		at: number,
	): CodexPersistedAgent | undefined {
		const catalog = this.catalog(owner);
		const index = catalog.agents.findIndex((agent) => agent.agentId === agentId);
		if (index < 0) return undefined;
		const agent = catalog.agents[index]!;
		const operationIndex = agent.operations.findIndex((operation) => operation.operationId === operationId);
		const exchangeIndex = agent.exchanges.findIndex((exchange) => exchange.operationId === operationId);
		if (operationIndex < 0 || exchangeIndex < 0) return agent;
		const result = this.refuseDelivery(owner, catalog, index, operationIndex, exchangeIndex, at);
		return result.agent;
	}

	/** Fold one asynchronous App Server event into the record it belongs to. */
	applyEvent(event: CodexDaemonEvent, at: number): CodexApplication {
		const parsed = CodexDaemonEventSchema.safeParse(event);
		if (!parsed.success) return ignore("event failed validation");
		const located = this.locate(parsed.data.ownerKey, parsed.data.agentId);
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
		return this.applyAgent(owner, catalog, index, next);
	}

	/** Fold one authenticated daemon receipt into the record it belongs to. */
	applyReceipt(receipt: CodexDaemonReceipt, at: number): CodexApplication {
		switch (receipt.kind) {
			case "accepted": {
				try {
					const result = this.acceptDeliveryFromDaemon({ ...receipt, fence: fenceOf(receipt), at });
					if (result.disposition !== "indeterminate") {
						return {
							disposition: "applied",
							owner: result.owner,
							agent: result.agent,
							catalogRevision: result.catalogRevision,
						};
					}
					return result.unresolved
						? { disposition: "reconcile", owner: result.owner, agent: result.agent }
						: ignore("delivery could not be verified against its record");
				} catch {
					return ignore("delivery receipt did not resolve to one managed operation");
				}
			}
			case "rejected":
				return this.applyRejection(receipt, at);
			case "interruptResult":
			case "interruptFailed":
				return this.applyInterruptOutcome(receipt, at);
			case "reconciled":
				return this.applyReconciliation(receipt, at);
			default:
				return ignore("unsupported receipt kind");
		}
	}

	/** Why the daemon last refused an operation, so a caller learns the cause instead of a generic
	 * timeout. Bounded to the live operations it is about; an entry is dropped when its result is
	 * reported. Kept off the persisted record deliberately: it is a diagnostic, not agent state. */
	private readonly refusals = new Map<string, string>();

	/** The daemon's own reason for refusing an operation, consumed once. */
	takeRefusalReason(operationId: string): string | undefined {
		const reason = this.refusals.get(operationId);
		this.refusals.delete(operationId);
		return reason;
	}

	private applyRejection(receipt: Extract<CodexDaemonReceipt, { kind: "rejected" }>, at: number): CodexApplication {
		// The reason is the whole value of a refusal: without it, a caller sees only a generic
		// "delivery was not confirmed within the wait budget" in place of the actual cause (e.g. "model
		// not offered: <id>"), which is both useless and untrue - the daemon did explain, and that
		// explanation must reach the caller rather than being discarded here.
		if (receipt.operationId) {
			this.refusals.set(receipt.operationId, receipt.error);
			if (this.refusals.size > 256) this.refusals.delete(this.refusals.keys().next().value as string);
		}
		const located = this.locate(receipt.ownerKey, receipt.agentId);
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
			return this.applyAgent(owner, catalog, index, next);
		} catch {
			return failed("rejection did not produce a valid record");
		}
	}

	private applyInterruptOutcome(
		receipt: Extract<CodexDaemonReceipt, { kind: "interruptResult" | "interruptFailed" }>,
		at: number,
	): CodexApplication {
		const located = this.locate(receipt.ownerKey, receipt.agentId);
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
			return this.applyAgent(owner, catalog, index, next);
		} catch {
			return failed("interrupt result did not produce a valid record");
		}
	}

	private applyReconciliation(
		receipt: Extract<CodexDaemonReceipt, { kind: "reconciled" }>,
		at: number,
	): CodexApplication {
		const located = this.locate(receipt.ownerKey, receipt.agentId);
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
			return this.applyAgent(owner, catalog, index, next);
		} catch {
			return failed("reconciliation did not produce a valid record");
		}
	}

	private locate(
		ownerKey: string,
		agentId: string,
	): { owner: SessionRecord; catalog: CodexAgentCatalog; index: number; agent: CodexPersistedAgent } | null {
		if (!CodexOwnerKeySchema.safeParse(ownerKey).success) return null;
		if (!CodexAgentIdSchema.safeParse(agentId).success) return null;
		const owner = this.sessionStore.getByTeam(ownerKey);
		if (!owner) return null;
		const catalog = this.catalog(owner);
		const matches = catalog.agents.flatMap((agent, index) => (agent.agentId === agentId ? [index] : []));
		if (matches.length !== 1) return null;
		return { owner, catalog, index: matches[0]!, agent: catalog.agents[matches[0]!]! };
	}

	private applyAgent(
		owner: SessionRecord,
		catalog: CodexAgentCatalog,
		index: number,
		next: CodexPersistedAgent,
	): CodexApplication {
		let committed;
		try {
			committed = this.catalogWriter.commit(owner, catalog.revision, replaceAt(catalog.agents, index, next));
		} catch {
			// Deliberately NOT ignored: an unpersisted event must not be acknowledged, or the daemon
			// retires the only copy of it.
			return { disposition: "reconcile", owner, agent: next };
		}
		if (!committed.committed) return { disposition: "reconcile", owner, agent: next };
		const agent = committed.catalog.agents.find((candidate) => candidate.agentId === next.agentId)!;
		return { disposition: "applied", owner, agent, catalogRevision: committed.catalog.revision };
	}

	private requireOwner(req: Request): SessionRecord {
		const owner = this.resolveOwner(req);
		if (!owner) throw new CodexTransitionError("not_found", "managed session was not found");
		return owner;
	}

	private catalog(owner: SessionRecord): CodexAgentCatalog {
		return this.sessionStore.codexCatalog(owner) ?? { version: 1, revision: 0, agents: [] };
	}

	private agentIndex(catalog: CodexAgentCatalog, agentId: string): number {
		const matches = catalog.agents.flatMap((agent, index) => (agent.agentId === agentId ? [index] : []));
		if (matches.length !== 1) throw new CodexTransitionError("not_found", "agent was not found");
		return matches[0]!;
	}

	/** `unresolved` marks the ones reconciliation could still make sense of, as opposed to a receipt
	 * that genuinely does not describe this record. Only the first may withhold an acknowledgement. */
	private indeterminate(
		owner: SessionRecord,
		agent: CodexPersistedAgent,
		operation: CodexStoredOperation,
		catalogRevision: number,
		unresolved?: true,
	): CodexAcceptanceResult {
		return { owner, agent, operation, disposition: "indeterminate", catalogRevision, unresolved };
	}

	private replay(owner: SessionRecord, operationId: string, fingerprint: string): CodexTransitionResult | null {
		const catalog = this.catalog(owner);
		const matches = catalog.agents.flatMap((agent) =>
			agent.operations.flatMap((operation) =>
				operation.operationId === operationId ? [{ agent, operation }] : [],
			),
		);
		if (matches.length === 0) return null;
		if (matches.length !== 1 || matches[0]!.operation.fingerprint !== fingerprint) {
			throw new CodexTransitionError("operation_conflict", "operation ID was reused with different input");
		}
		const replayable =
			matches[0]!.operation.state === "accepted" &&
			!matches[0]!.operation.acceptanceUnverified &&
			this.ensureCatalogDurable(owner, catalog.revision);
		return {
			owner,
			agent: matches[0]!.agent,
			operation: matches[0]!.operation,
			disposition: replayable ? "replayed" : "indeterminate",
			catalogRevision: catalog.revision,
			// Not a mismatch: the operation exists and matches, the gateway just cannot confirm it is
			// durable or fenced. Reconciliation is what settles it.
			unresolved: replayable ? undefined : true,
		};
	}

	private ensureCatalogDurable(owner: SessionRecord, revision: number): boolean {
		if (this.catalogWriter.isDurable(owner, revision)) return true;
		try {
			return this.catalogWriter.checkpoint(owner, revision).confirmed;
		} catch {
			return false;
		}
	}

	private commit(
		owner: SessionRecord,
		catalog: CodexAgentCatalog,
		agents: readonly CodexPersistedAgent[],
		agent: CodexPersistedAgent,
		operationId: string,
	): CodexTransitionResult {
		let committed;
		try {
			committed = this.catalogWriter.commit(owner, catalog.revision, agents);
		} catch (error) {
			throw new CodexTransitionError("persistence_failed", "Codex transition could not be persisted", {
				cause: error,
			});
		}
		if (!committed.committed) {
			throw new CodexTransitionError("state_conflict", `catalog commit failed: ${committed.reason}`);
		}
		const storedAgent = committed.catalog.agents.find((candidate) => candidate.agentId === agent.agentId)!;
		const operation = storedAgent.operations.find((candidate) => candidate.operationId === operationId)!;
		return {
			owner,
			agent: storedAgent,
			operation,
			disposition: "committed",
			catalogRevision: committed.catalog.revision,
		};
	}
}
