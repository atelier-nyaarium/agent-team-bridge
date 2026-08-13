import { classifyAcceptanceFence, fenceOf } from "../shared/agent-fence.js";
import {
	type CopilotAgentCatalog,
	CopilotAgentIdSchema,
	type CopilotDaemonEvent,
	type CopilotDaemonFailureCode,
	type CopilotDaemonReceipt,
	CopilotDaemonReceiptSchema,
	CopilotExecutionTargetSchema,
	CopilotOperationIdSchema,
	type CopilotPersistedAgent,
	CopilotPersistedAgentSchema,
	CopilotPromptSchema,
	type CopilotResolvedTarget,
	type CopilotStoredOperation,
	type CopilotStoredTurn,
	copilotOperationFingerprint,
} from "../shared/copilot-thinking.js";
import type { CopilotCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import type { AgentTransitionErrorCode } from "./agentRouteEnvelope.js";
import type { SessionAuthority } from "./sessionAuthority.js";

////////////////////////////////
//  Interfaces & Types

export interface CopilotAgentServiceDeps {
	auth: SessionAuthority;
	sessionStore: SessionStore;
	offlineCatalog: ReadonlyMap<string, string>;
	catalogWriter: CopilotCatalogWriter;
}

export interface CopilotIntentInput {
	agentId: string;
	operationId: string;
	prompt: string;
	target: unknown;
	model?: string;
	at: number;
}

export interface CopilotExistingAgentIntentInput {
	agentId: string;
	operationId: string;
	prompt: string;
	at: number;
}

export interface CopilotStopIntentInput {
	agentId: string;
	operationId: string;
	at: number;
}

export interface OwnedCopilotAgent {
	owner: SessionRecord;
	agent: CopilotPersistedAgent;
}

export interface OwnedCopilotOperation extends OwnedCopilotAgent {
	operation: CopilotStoredOperation;
}

export interface CopilotTransitionResult extends OwnedCopilotOperation {
	disposition: "committed" | "replayed" | "indeterminate";
	catalogRevision: number;
}

export type CopilotTransitionErrorCode = AgentTransitionErrorCode;

export class CopilotTransitionError extends Error {
	constructor(
		readonly code: CopilotTransitionErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CopilotTransitionError";
	}
}

export type CopilotApplication =
	| { disposition: "applied"; owner: SessionRecord; agent: CopilotPersistedAgent; catalogRevision: number }
	| { disposition: "ignored"; reason: string }
	| { disposition: "reconcile"; owner: SessionRecord; agent: CopilotPersistedAgent }
	| { disposition: "failed"; reason: string };

////////////////////////////////
//  Functions & Helpers

function validateTimestamp(at: number): number {
	if (!Number.isSafeInteger(at) || at < 0)
		throw new CopilotTransitionError("invalid_input", "invalid transition timestamp");
	return at;
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
	return values.map((current, currentIndex) => (currentIndex === index ? value : current));
}

function sameResolvedTarget(left: CopilotResolvedTarget, right: CopilotResolvedTarget): boolean {
	return left.kind === right.kind && left.targetId === right.targetId && left.cwd === right.cwd;
}

function resolvedTargetMatchesRequest(
	requested: CopilotPersistedAgent["requestedTarget"],
	resolved: CopilotResolvedTarget,
): boolean {
	if (requested.kind !== resolved.kind) return false;
	if (requested.kind === "host") return resolved.targetId === "host";
	return resolved.targetId === `container:${requested.project}` && resolved.cwd === `/workspace/${requested.project}`;
}

function appendActivity(
	activities: CopilotPersistedAgent["turns"][number]["activities"],
	itemId: string,
	text: string,
) {
	if (activities.some((activity) => activity.kind === "commentary" && activity.itemId === itemId)) return activities;
	const commentary = activities.filter((activity) => activity.kind === "commentary");
	if (commentary.length >= 32) {
		const omitted = activities.find((activity) => activity.kind === "truncated")?.omitted ?? 0;
		return [...commentary, { kind: "truncated" as const, omitted: omitted + 1 }];
	}
	return [...commentary, { kind: "commentary" as const, itemId, text }];
}

////////////////////////////////
//  Class

export class CopilotAgentService {
	private readonly refusalReasons = new Map<string, string>();
	private readonly refusalCodes = new Map<string, CopilotDaemonFailureCode>();

	constructor(private readonly deps: CopilotAgentServiceDeps) {}

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
		const target =
			owner.spawn === "host"
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
		const fingerprint = copilotOperationFingerprint("start", agentId, `${prompt}\n${input.model ?? ""}`);
		const replay = this.replay(owner, operationId, fingerprint);
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
				{ operationId, kind: "start", prompt, fingerprint, state: "requested", createdAt: at, updatedAt: at },
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
		const fingerprint = copilotOperationFingerprint("message", agentId, prompt);
		const replay = this.replay(owner, operationId, fingerprint);
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
		const fingerprint = copilotOperationFingerprint("stop", agentId);
		const replay = this.replay(owner, operationId, fingerprint);
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
		const parsed = CopilotDaemonReceiptSchema.safeParse(receipt);
		if (!parsed.success) return { disposition: "failed", reason: "invalid Copilot receipt" };
		const owner = this.deps.sessionStore.getByTeam(parsed.data.ownerKey);
		if (!owner) return { disposition: "ignored", reason: "owner not found" };
		const current = this.listOwnedAgents(owner).find((agent) => agent.agentId === parsed.data.agentId);
		if (!current) return { disposition: "ignored", reason: "agent not found" };
		if (parsed.data.kind === "rejected")
			return this.applyRejected(
				owner,
				current,
				parsed.data.operationId,
				parsed.data.error,
				parsed.data.failureCode,
				at,
			);
		if (parsed.data.kind === "accepted") return this.applyAccepted(owner, current, parsed.data, at);
		if (parsed.data.kind === "interruptResult") return this.applyInterrupt(owner, current, parsed.data, at);
		return this.applyReconciled(owner, current, parsed.data, at);
	}

	applyEvent(event: CopilotDaemonEvent, at: number): CopilotApplication {
		const owner = this.deps.sessionStore.getByTeam(event.ownerKey);
		if (!owner) return { disposition: "ignored", reason: "owner not found" };
		const current = this.listOwnedAgents(owner).find((agent) => agent.agentId === event.agentId);
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
			return this.commitApplication(owner, current, next);
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
		return this.commitApplication(owner, current, next);
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
		this.commitApplication(owner, current, next);
		return next;
	}

	takeRefusal(operationId: string): { code?: CopilotDaemonFailureCode; message: string } | undefined {
		const reason = this.refusalReasons.get(operationId);
		const code = this.refusalCodes.get(operationId);
		this.refusalReasons.delete(operationId);
		this.refusalCodes.delete(operationId);
		return reason ? { ...(code ? { code } : {}), message: reason } : undefined;
	}

	private applyAccepted(
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
		return this.commitApplication(owner, current, next);
	}

	private applyInterrupt(
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
		return this.commitApplication(owner, current, next);
	}

	private applyReconciled(
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
		return this.commitApplication(owner, current, next);
	}

	private applyRejected(
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
		this.refusalReasons.set(operationId, error);
		if (failureCode) this.refusalCodes.set(operationId, failureCode);
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
		return this.commitApplication(owner, current, next);
	}

	private commitApplication(
		owner: SessionRecord,
		previous: CopilotPersistedAgent,
		next: CopilotPersistedAgent,
	): CopilotApplication {
		const catalog = this.catalog(owner);
		const index = this.indexOf(catalog, previous.agentId);
		let committed;
		try {
			committed = this.deps.catalogWriter.commit(owner, catalog.revision, replaceAt(catalog.agents, index, next));
		} catch {
			// Deliberately NOT ignored: an unpersisted event must not be acknowledged, or the daemon
			// retires the only copy of it. Reconcile rather than fail, so the record self-heals.
			return { disposition: "reconcile", owner, agent: next };
		}
		if (!committed.committed) return { disposition: "reconcile", owner, agent: next };
		return {
			disposition: "applied",
			owner,
			agent: committed.catalog.agents.find((agent) => agent.agentId === next.agentId)!,
			catalogRevision: committed.catalog.revision,
		};
	}

	private commit(
		owner: SessionRecord,
		catalog: CopilotAgentCatalog,
		agents: readonly CopilotPersistedAgent[],
		agent: CopilotPersistedAgent,
		operationId: string,
	): CopilotTransitionResult {
		let committed;
		try {
			committed = this.deps.catalogWriter.commit(owner, catalog.revision, agents);
		} catch (error) {
			throw new CopilotTransitionError("persistence_failed", "Copilot transition could not be persisted", {
				cause: error,
			});
		}
		if (!committed.committed)
			throw new CopilotTransitionError("persistence_failed", "Copilot catalog changed while saving");
		const storedAgent = committed.catalog.agents.find((candidate) => candidate.agentId === agent.agentId)!;
		return {
			disposition: "committed",
			owner,
			agent: storedAgent,
			operation: storedAgent.operations.find((operation) => operation.operationId === operationId)!,
			catalogRevision: committed.catalog.revision,
		};
	}

	private replay(owner: SessionRecord, operationId: string, fingerprint: string): CopilotTransitionResult | null {
		const catalog = this.catalog(owner);
		for (const agent of catalog.agents) {
			const operation = agent.operations.find((candidate) => candidate.operationId === operationId);
			if (!operation) continue;
			if (operation.fingerprint !== fingerprint)
				throw new CopilotTransitionError("operation_conflict", "operation ID was reused with different input");
			return {
				disposition: operation.state === "requested" ? "indeterminate" : "replayed",
				owner,
				agent,
				operation,
				catalogRevision: catalog.revision,
			};
		}
		return null;
	}

	private requireOwner(req: Request): SessionRecord {
		const owner = this.resolveOwner(req);
		if (!owner) throw new CopilotTransitionError("not_found", "session was not found");
		return owner;
	}

	private catalog(owner: SessionRecord): CopilotAgentCatalog {
		return this.deps.sessionStore.copilotCatalog(owner) ?? { version: 1, revision: 0, agents: [] };
	}

	private indexOf(catalog: CopilotAgentCatalog, agentId: string): number {
		const index = catalog.agents.findIndex((agent) => agent.agentId === agentId);
		if (index < 0) throw new CopilotTransitionError("not_found", "Copilot agent was not found");
		return index;
	}
}

export type { CopilotDaemonEvent, CopilotDaemonReceipt };
