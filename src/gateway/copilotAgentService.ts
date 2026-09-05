import { type AgentOperationIdentity, agentOperationFingerprintOf } from "../shared/agent-record.js";
import {
	type CopilotAgentCatalog,
	CopilotAgentIdSchema,
	type CopilotDaemonEvent,
	type CopilotDaemonFailureCode,
	type CopilotDaemonReceipt,
	CopilotExecutionTargetSchema,
	CopilotOperationIdSchema,
	type CopilotPersistedAgent,
	CopilotPersistedAgentSchema,
	CopilotPromptSchema,
	copilotOperationIdentity,
} from "../shared/copilot-agent.js";
import { isHostSpawn } from "../shared/host-spawn.js";
import type { SessionRecord } from "../shared/session-store.js";
import { type CopilotReceiptApplier, createCopilotReceiptApplier } from "./copilotAgentApply.js";
import {
	applyCopilotAgent,
	type CopilotCatalogDeps,
	commitCopilotTransition,
	copilotAgentIndex,
	readCopilotCatalog,
	replayCopilotTransition,
} from "./copilotAgentPersistence.js";
import { replaceAt, validateTimestamp } from "./copilotAgentReducers.js";
import {
	type CopilotAgentServiceDeps,
	type CopilotApplication,
	type CopilotExistingAgentIntentInput,
	type CopilotIntentInput,
	type CopilotStopIntentInput,
	CopilotTransitionError,
	type CopilotTransitionResult,
	type OwnedCopilotAgent,
} from "./copilotAgentTypes.js";

export class CopilotAgentService {
	private readonly persistenceDeps: CopilotCatalogDeps;
	private readonly receiptApplier: CopilotReceiptApplier;

	constructor(private readonly deps: CopilotAgentServiceDeps) {
		this.persistenceDeps = { sessionStore: deps.sessionStore, catalogWriter: deps.catalogWriter };
		this.receiptApplier = createCopilotReceiptApplier(this.persistenceDeps);
	}

	resolveOwner(req: Request): SessionRecord | null {
		return this.deps.auth.resolveConfirmedManagedSession(req);
	}

	ownerKeyOf(owner: SessionRecord): string {
		return this.deps.sessionStore.teamOf(owner);
	}

	listOwnedAgents(owner: SessionRecord): readonly CopilotPersistedAgent[] {
		return this.deps.sessionStore.listCopilotAgents(owner);
	}

	resolveExecutionTarget(owner: SessionRecord, cwd?: string) {
		const target = isHostSpawn(owner.spawn)
			? { kind: "host" as const, workdirHint: cwd ?? this.deps.sessionStore.hostWorkdirHint(owner) }
			: (() => {
					const hostProjectPath = this.deps.offlineCatalog.get(owner.spawn);
					return hostProjectPath
						? { kind: "devcontainer" as const, project: owner.spawn, hostProjectPath }
						: null;
				})();
		const parsed = target ? CopilotExecutionTargetSchema.safeParse(target) : null;
		return parsed?.success ? parsed.data : null;
	}

	resolveOwnedAgent(req: Request, agentId: string): OwnedCopilotAgent | null {
		if (!CopilotAgentIdSchema.safeParse(agentId).success) return null;
		const owner = this.resolveOwner(req);
		if (!owner) return null;
		const matches = this.listOwnedAgents(owner).filter((agent) => agent.agentId === agentId);
		return matches.length === 1 ? { owner, agent: matches[0]! } : null;
	}

	beginStart(req: Request, input: CopilotIntentInput): CopilotTransitionResult {
		const owner = this.requireOwner(req);
		const agentId = CopilotAgentIdSchema.parse(input.agentId);
		const operationId = CopilotOperationIdSchema.parse(input.operationId);
		const prompt = CopilotPromptSchema.parse(input.prompt);
		const target = CopilotExecutionTargetSchema.parse(input.target);
		const at = validateTimestamp(input.at);
		const identity = copilotOperationIdentity({ kind: "start", agentId, prompt, model: input.model });
		const fingerprint = agentOperationFingerprintOf(identity);
		const replay = this.replay(owner, operationId, identity);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		if (catalog.agents.some((agent) => agent.agentId === agentId))
			throw new CopilotTransitionError("operation_conflict", "agent ID is already in use");
		const agent = CopilotPersistedAgentSchema.parse({
			version: 1,
			agentId,
			agentState: "creating",
			requestedTarget: target,
			operations: [
				{
					operationId,
					kind: "start",
					prompt,
					...(input.model === undefined ? {} : { model: input.model }),
					fingerprint,
					state: "requested",
					createdAt: at,
					updatedAt: at,
				},
			],
			turns: [],
			createdAt: at,
			updatedAt: at,
		});
		return this.commit(owner, catalog, [...catalog.agents, agent], agent, operationId);
	}

	beginMessage(req: Request, input: CopilotExistingAgentIntentInput): CopilotTransitionResult {
		const owner = this.requireOwner(req);
		const agentId = CopilotAgentIdSchema.parse(input.agentId);
		const operationId = CopilotOperationIdSchema.parse(input.operationId);
		const prompt = CopilotPromptSchema.parse(input.prompt);
		const at = validateTimestamp(input.at);
		const identity = copilotOperationIdentity({ kind: "message", agentId, prompt });
		const fingerprint = agentOperationFingerprintOf(identity);
		const replay = this.replay(owner, operationId, identity);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		const index = this.indexOf(catalog, agentId);
		const current = catalog.agents[index]!;
		if (!current.sessionId || !current.resolvedTarget || current.agentState !== "idle")
			throw new CopilotTransitionError("state_conflict", "Copilot agent is not idle");
		if (current.operations.some((operation) => operation.state === "requested"))
			throw new CopilotTransitionError("state_conflict", "Copilot agent has an unresolved operation");
		const timestamp = Math.max(at, current.updatedAt);
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			operations: [
				...current.operations,
				{
					operationId,
					kind: "message",
					prompt,
					fingerprint,
					state: "requested",
					sessionId: current.sessionId,
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			],
			updatedAt: timestamp,
		});
		return this.commit(owner, catalog, replaceAt(catalog.agents, index, next), next, operationId);
	}

	beginStop(req: Request, input: CopilotStopIntentInput): CopilotTransitionResult {
		const owner = this.requireOwner(req);
		const agentId = CopilotAgentIdSchema.parse(input.agentId);
		const operationId = CopilotOperationIdSchema.parse(input.operationId);
		const at = validateTimestamp(input.at);
		const identity = copilotOperationIdentity({ kind: "stop", agentId });
		const fingerprint = agentOperationFingerprintOf(identity);
		const replay = this.replay(owner, operationId, identity);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		const index = this.indexOf(catalog, agentId);
		const current = catalog.agents[index]!;
		if (
			!current.sessionId ||
			!current.resolvedTarget ||
			(current.agentState !== "idle" && current.agentState !== "working")
		) {
			throw new CopilotTransitionError("state_conflict", "Copilot agent cannot be stopped now");
		}
		if (current.operations.some((operation) => operation.state === "requested"))
			throw new CopilotTransitionError("state_conflict", "Copilot agent has an unresolved operation");
		const timestamp = Math.max(at, current.updatedAt);
		const noOp = current.agentState === "idle";
		const operation = {
			operationId,
			kind: "stop" as const,
			fingerprint,
			state: noOp ? ("accepted" as const) : ("requested" as const),
			sessionId: current.sessionId,
			turnId: noOp ? undefined : current.activeTurnId,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			operations: [...current.operations, operation],
			updatedAt: timestamp,
		});
		return this.commit(owner, catalog, replaceAt(catalog.agents, index, next), next, operationId);
	}

	applyReceipt(receipt: CopilotDaemonReceipt, at: number): CopilotApplication {
		return this.receiptApplier.applyReceipt(receipt, at);
	}

	applyEvent(event: CopilotDaemonEvent, at: number): CopilotApplication {
		return this.receiptApplier.applyEvent(event, at);
	}

	abandonDelivery(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		at: number,
	): CopilotPersistedAgent | undefined {
		const current = this.listOwnedAgents(owner).find((agent) => agent.agentId === agentId);
		if (!current) return undefined;
		const operationIndex = current.operations.findIndex((operation) => operation.operationId === operationId);
		if (operationIndex < 0 || current.operations[operationIndex]!.state !== "requested") return current;
		const operation = {
			...current.operations[operationIndex]!,
			state: "indeterminate" as const,
			updatedAt: Math.max(at, current.updatedAt),
		};
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			agentState: current.agentState === "creating" ? "unavailable" : "recovering",
			operations: replaceAt(current.operations, operationIndex, operation),
			updatedAt: Math.max(at, current.updatedAt),
		});
		applyCopilotAgent(this.persistenceDeps, owner, current, next);
		return next;
	}

	takeRefusal(operationId: string): { code?: CopilotDaemonFailureCode; message: string } | undefined {
		return this.receiptApplier.takeRefusal(operationId);
	}

	private commit(
		owner: SessionRecord,
		catalog: CopilotAgentCatalog,
		agents: readonly CopilotPersistedAgent[],
		agent: CopilotPersistedAgent,
		operationId: string,
	): CopilotTransitionResult {
		return commitCopilotTransition(this.persistenceDeps, owner, catalog, agents, agent, operationId);
	}

	private replay(
		owner: SessionRecord,
		operationId: string,
		identity: AgentOperationIdentity,
	): CopilotTransitionResult | null {
		return replayCopilotTransition(this.persistenceDeps, owner, operationId, identity);
	}

	private requireOwner(req: Request): SessionRecord {
		const owner = this.resolveOwner(req);
		if (!owner) throw new CopilotTransitionError("not_found", "session was not found");
		return owner;
	}

	private catalog(owner: SessionRecord): CopilotAgentCatalog {
		return readCopilotCatalog(this.persistenceDeps, owner);
	}

	private indexOf(catalog: CopilotAgentCatalog, agentId: string): number {
		return copilotAgentIndex(catalog, agentId);
	}
}
