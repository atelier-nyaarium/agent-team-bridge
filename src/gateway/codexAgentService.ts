import { type AgentOperationIdentity, agentOperationFingerprintOf } from "../shared/agent-record.js";
import {
	type CodexAgentCatalog,
	CodexAgentIdSchema,
	type CodexDaemonEvent,
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
	codexOperationIdentity,
} from "../shared/codex-agent.js";
import { isHostSpawn } from "../shared/host-spawn.js";
import type { CodexCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import { type CodexReceiptApplier, createCodexReceiptApplier } from "./codexAgentApply.js";
import {
	type CodexCatalogDeps,
	codexAgentIndex,
	codexCatalogDurable,
	commitCodexTransition,
	readCodexCatalog,
	replayCodexTransition,
} from "./codexAgentPersistence.js";
import {
	decideAcceptance,
	hasPendingPrompt,
	indeterminate,
	replaceAt,
	validateTimestamp,
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

////////////////////////////////
//  Class

/** Session-owned gateway boundary for Codex access and state transitions. Route and daemon
 * adapters resolve through this service rather than receiving catalog authority directly. */
export class CodexAgentService {
	private readonly auth: SessionAuthority;
	private readonly sessionStore: SessionStore;
	private readonly offlineCatalog: ReadonlyMap<string, string>;
	private readonly catalogWriter: CodexCatalogWriter;
	private readonly persistenceDeps: CodexCatalogDeps;
	private readonly receiptApplier: CodexReceiptApplier;

	constructor(deps: CodexAgentServiceDeps) {
		this.auth = deps.auth;
		this.sessionStore = deps.sessionStore;
		this.offlineCatalog = deps.offlineCatalog;
		this.catalogWriter = deps.catalogWriter;
		this.persistenceDeps = { sessionStore: deps.sessionStore, catalogWriter: deps.catalogWriter };
		this.receiptApplier = createCodexReceiptApplier({
			...this.persistenceDeps,
			acceptDeliveryFromDaemon: (input) => this.acceptDeliveryFromDaemon(input),
		});
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
		if (isHostSpawn(owner.spawn)) {
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
		const identity = codexOperationIdentity({ kind: "start", agentId, prompt, model: input.model });
		const fingerprint = agentOperationFingerprintOf(identity);
		const replay = this.replay(owner, operationId, identity);
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
			...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
			exchanges: [
				{
					exchangeId: operationId,
					operationId,
					kind: "start",
					prompt,
					...(input.model === undefined ? {} : { model: input.model }),
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
		const identity = codexOperationIdentity({ kind: "message", agentId, prompt });
		const fingerprint = agentOperationFingerprintOf(identity);
		const replay = this.replay(owner, operationId, identity);
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
			// Absent leaves the agent on the tier it already has.
			...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
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
		const identity = codexOperationIdentity({ kind: "stop", agentId });
		const fingerprint = agentOperationFingerprintOf(identity);
		const replay = this.replay(owner, operationId, identity);
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
				return indeterminate(owner, current, operation, catalog.revision, true);
			case "conflict":
				throw new CodexTransitionError("operation_conflict", "accepted delivery does not match its receipt");
			case "replayed":
				if (!this.ensureCatalogDurable(owner, catalog.revision)) {
					return indeterminate(owner, current, operation, catalog.revision, true);
				}
				return { owner, agent: current, operation, disposition: "replayed", catalogRevision: catalog.revision };
			case "refuse":
				// A receipt the gateway refuses SETTLES its operation rather than leaving it requested:
				// nothing else ever transitions one, the daemon has been told it may retire the receipt,
				// and a requested prompt blocks every later message and stop for the agent's whole life.
				return this.refuseDelivery(owner, catalog, index, operationIndex, exchangeIndex, at);
			case "unresolved":
				return indeterminate(owner, current, operation, catalog.revision, true);
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
			return indeterminate(owner, current, operation, catalog.revision, true);
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
			return indeterminate(owner, current, operation, catalog.revision);
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
			return indeterminate(owner, current, operation, catalog.revision, true);
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
		return this.receiptApplier.applyEvent(event, at);
	}

	/** Fold one authenticated daemon receipt into the record it belongs to. */
	applyReceipt(receipt: CodexDaemonReceipt, at: number): CodexApplication {
		return this.receiptApplier.applyReceipt(receipt, at);
	}

	/** The daemon's own reason for refusing an operation, consumed once. */
	takeRefusalReason(operationId: string): string | undefined {
		return this.receiptApplier.takeRefusalReason(operationId);
	}

	private requireOwner(req: Request): SessionRecord {
		const owner = this.resolveOwner(req);
		if (!owner) throw new CodexTransitionError("not_found", "managed session was not found");
		return owner;
	}

	private catalog(owner: SessionRecord): CodexAgentCatalog {
		return readCodexCatalog(this.persistenceDeps, owner);
	}

	private agentIndex(catalog: CodexAgentCatalog, agentId: string): number {
		return codexAgentIndex(catalog, agentId);
	}

	private replay(
		owner: SessionRecord,
		operationId: string,
		identity: AgentOperationIdentity,
	): CodexTransitionResult | null {
		return replayCodexTransition(this.persistenceDeps, owner, operationId, identity);
	}

	private ensureCatalogDurable(owner: SessionRecord, revision: number): boolean {
		return codexCatalogDurable(this.persistenceDeps, owner, revision);
	}

	private commit(
		owner: SessionRecord,
		catalog: CodexAgentCatalog,
		agents: readonly CodexPersistedAgent[],
		agent: CodexPersistedAgent,
		operationId: string,
	): CodexTransitionResult {
		return commitCodexTransition(this.persistenceDeps, owner, catalog, agents, agent, operationId);
	}
}
