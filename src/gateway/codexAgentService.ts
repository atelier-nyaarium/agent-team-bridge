import {
	type CodexAgentCatalog,
	CodexAgentIdSchema,
	type CodexExecutionTarget,
	CodexExecutionTargetSchema,
	CodexOperationIdSchema,
	CodexOwnerKeySchema,
	type CodexPersistedAgent,
	CodexPersistedAgentSchema,
	CodexPromptSchema,
	type CodexReconciliationFence,
	CodexReconciliationFenceSchema,
	type CodexResolvedTarget,
	CodexResolvedTargetSchema,
	type CodexStoredOperation,
	codexOperationFingerprint,
} from "../shared/codex-thinking.js";
import type { CodexCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import type { SessionAuthority } from "./sessionAuthority.js";

export interface CodexAgentServiceDeps {
	auth: SessionAuthority;
	sessionStore: SessionStore;
	offlineCatalog: ReadonlyMap<string, string>;
	catalogWriter: CodexCatalogWriter;
}

export interface OwnedCodexAgent {
	owner: SessionRecord;
	agent: CodexPersistedAgent;
}

export interface OwnedCodexOperation extends OwnedCodexAgent {
	operation: CodexStoredOperation;
}

export interface CodexIntentInput {
	agentId: string;
	operationId: string;
	prompt: string;
	at: number;
}

export interface CodexExistingAgentIntentInput extends CodexIntentInput {
	agentId: string;
}

export interface CodexStopIntentInput {
	agentId: string;
	operationId: string;
	at: number;
}

export interface CodexDeliveryAcceptance {
	agentId: string;
	operationId: string;
	resolvedTarget: CodexResolvedTarget;
	threadId: string;
	turnId: string;
	delivery: "started" | "steered";
	fence: CodexReconciliationFence;
	at: number;
}

export interface CodexDaemonDeliveryAcceptance extends CodexDeliveryAcceptance {
	ownerKey: string;
}

export interface CodexTransitionResult extends OwnedCodexOperation {
	/** Only `committed` authorizes first dispatch. `indeterminate` is an existing unaccepted intent. */
	disposition: "committed" | "replayed" | "indeterminate";
	catalogRevision: number;
}

export type CodexAcceptanceResult =
	| CodexTransitionResult
	| (OwnedCodexOperation & { disposition: "indeterminate"; catalogRevision: number });

export type CodexTransitionErrorCode =
	| "invalid_input"
	| "not_found"
	| "operation_conflict"
	| "state_conflict"
	| "target_unavailable"
	| "persistence_failed";

export class CodexTransitionError extends Error {
	constructor(
		readonly code: CodexTransitionErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CodexTransitionError";
	}
}

function validateTimestamp(at: number): number {
	if (!Number.isSafeInteger(at) || at < 0) {
		throw new CodexTransitionError("invalid_input", "transition timestamp must be a nonnegative integer");
	}
	return at;
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
	return values.map((current, currentIndex) => (currentIndex === index ? value : current));
}

function sameTarget(left: CodexResolvedTarget | undefined, right: CodexResolvedTarget): boolean {
	return left?.kind === right.kind && left.targetId === right.targetId && left.cwd === right.cwd;
}

function sameFence(left: CodexReconciliationFence | undefined, right: CodexReconciliationFence | undefined): boolean {
	if (!left || !right) return left === right;
	return (
		left.daemonInstanceId === right.daemonInstanceId &&
		left.targetId === right.targetId &&
		left.generation === right.generation &&
		left.lastEventId === right.lastEventId
	);
}

function advancesFence(current: CodexReconciliationFence | undefined, next: CodexReconciliationFence): boolean {
	return (
		!current ||
		(current.daemonInstanceId === next.daemonInstanceId &&
			current.targetId === next.targetId &&
			current.generation === next.generation &&
			next.lastEventId > current.lastEventId)
	);
}

function hasPendingPrompt(agent: CodexPersistedAgent): boolean {
	return agent.operations.some(
		(operation) => (operation.kind === "start" || operation.kind === "message") && operation.state !== "accepted",
	);
}

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

	resolveExecutionTarget(owner: SessionRecord): CodexExecutionTarget | null {
		let target: CodexExecutionTarget;
		if (owner.spawn === "host") {
			target = { kind: "host", workdirHint: this.sessionStore.hostWorkdirHint(owner) };
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

	beginStart(req: Request, input: CodexIntentInput): CodexTransitionResult {
		const owner = this.requireOwner(req);
		const agentId = CodexAgentIdSchema.parse(input.agentId);
		const operationId = CodexOperationIdSchema.parse(input.operationId);
		const prompt = CodexPromptSchema.parse(input.prompt);
		const at = validateTimestamp(input.at);
		const fingerprint = codexOperationFingerprint("start", agentId, prompt);
		const replay = this.replay(owner, operationId, fingerprint);
		if (replay) return replay;
		const target = this.resolveExecutionTarget(owner);
		if (!target) throw new CodexTransitionError("target_unavailable", "trusted execution target is unavailable");
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

	/** Applies a receipt from the authenticated host channel without fabricating Claude authority. */
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
		if (operation.state === "accepted") {
			if (operation.acceptanceUnverified) {
				return this.indeterminate(owner, current, operation, catalog.revision);
			}
			if (
				operation.turnId !== input.turnId ||
				exchange.delivery !== input.delivery ||
				current.threadId !== input.threadId ||
				!sameTarget(current.resolvedTarget, resolvedTarget) ||
				!sameFence(operation.acceptanceFence, fence)
			) {
				throw new CodexTransitionError("operation_conflict", "accepted delivery does not match its receipt");
			}
			if (!this.ensureCatalogDurable(owner, catalog.revision)) {
				return this.indeterminate(owner, current, operation, catalog.revision);
			}
			return { owner, agent: current, operation, disposition: "replayed", catalogRevision: catalog.revision };
		}
		const indeterminate = () => this.indeterminate(owner, current, operation, catalog.revision);
		if (operation.kind === "stop" || exchange.kind !== operation.kind) return indeterminate();
		if (operation.state !== "requested" || exchange.status !== "requested") return indeterminate();
		if (operation.kind === "start" && input.delivery !== "started") return indeterminate();
		if (
			operation.kind === "message" &&
			((operation.preDispatch.agentState === "working" && input.delivery !== "steered") ||
				(operation.preDispatch.agentState === "idle" && input.delivery !== "started"))
		) {
			return indeterminate();
		}
		if (current.requestedTarget.kind !== resolvedTarget.kind) return indeterminate();
		if (
			(current.threadId && current.threadId !== input.threadId) ||
			(current.resolvedTarget && !sameTarget(current.resolvedTarget, resolvedTarget))
		) {
			return indeterminate();
		}
		if (
			current.agentState !== operation.preDispatch.agentState ||
			current.threadId !== operation.preDispatch.threadId ||
			current.activeTurnId !== operation.preDispatch.turnId ||
			!sameFence(current.fence, operation.preDispatch.fence) ||
			!advancesFence(operation.preDispatch.fence, fence)
		) {
			return indeterminate();
		}
		const existingTurn = current.turns.find((turn) => turn.id === input.turnId);
		if (input.delivery === "steered" && (current.activeTurnId !== input.turnId || !existingTurn)) {
			return indeterminate();
		}
		if (input.delivery === "started" && existingTurn) {
			return indeterminate();
		}
		try {
			const timestamp = Math.max(at, current.updatedAt);
			const turns = existingTurn
				? current.turns
				: [
						...current.turns,
						{ id: input.turnId, state: "inProgress" as const, activities: [], updatedAt: timestamp },
					];
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
				agentState: "working",
				resolvedTarget,
				threadId: input.threadId,
				activeTurnId: input.turnId,
				turns,
				exchanges: replaceAt(current.exchanges, exchangeIndex, acceptedExchange),
				operations: replaceAt(current.operations, operationIndex, acceptedOperation),
				fence,
				updatedAt: timestamp,
			});
			return this.commit(owner, catalog, replaceAt(catalog.agents, index, next), next, operationId);
		} catch {
			return indeterminate();
		}
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

	private indeterminate(
		owner: SessionRecord,
		agent: CodexPersistedAgent,
		operation: CodexStoredOperation,
		catalogRevision: number,
	): CodexAcceptanceResult {
		return { owner, agent, operation, disposition: "indeterminate", catalogRevision };
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
