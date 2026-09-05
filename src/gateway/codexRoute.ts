import { publishedActivities } from "../shared/agent-record.js";
import type { Clock } from "../shared/ambient.js";
import {
	CODEX_WAIT_BUDGET_MS,
	type CodexAgentResult,
	CodexAgentResultSchema,
	type CodexErrorCode,
	CodexGatewayRequestSchema,
	type CodexListAgentsResult,
	type CodexPersistedAgent,
	CodexRequestErrorSchema,
	type CodexStoredTurn,
	codexAgentIdForOperation,
	projectCodexListResult,
	sanitizeCodexErrorText,
} from "../shared/codex-agent.js";
import { isHostSpawn } from "../shared/host-spawn.js";
import type { SessionRecord } from "../shared/session-store.js";
import { AGENT_FAILURE_ANSWERS, jsonResponse as json } from "./agentRouteEnvelope.js";
import type { CodexAgentService } from "./codexAgentService.js";
import { CodexTransitionError } from "./codexAgentTypes.js";
import type { CodexRelay } from "./codexRelay.js";
import { presentedByRequest } from "./sessionAuthority.js";

export interface CodexRouteDeps {
	service: CodexAgentService;
	relay: CodexRelay;
	ambient: Clock;
	/** Wait budget covers acceptance and turn settlement together. */
	waitBudgetMs?: number;
}

const DEFAULT_WAIT_BUDGET_MS = CODEX_WAIT_BUDGET_MS;

function unavailable(
	agentId: string,
	error: { code: CodexErrorCode; retryable: boolean },
	message: string,
): CodexAgentResult {
	return CodexAgentResultSchema.parse({
		agentId,
		agentState: "unavailable",
		observation: "unavailable",
		activities: [],
		error: { code: error.code, message, retryable: error.retryable },
	});
}

const TARGET_UNAVAILABLE = { code: "daemon_unavailable" as const, retryable: true };
const AGENT_NOT_FOUND = { code: "not_found" as const, retryable: false };

function turnOf(agent: CodexPersistedAgent, turnId: string | undefined): CodexStoredTurn | undefined {
	return turnId ? agent.turns.find((turn) => turn.id === turnId) : undefined;
}

function startModelOf(agent: CodexPersistedAgent): string | undefined {
	return agent.exchanges.find((exchange) => exchange.kind === "start")?.model;
}

function describeAgent(agent: CodexPersistedAgent, waitedTurnId: string | undefined): CodexAgentResult {
	// Unavailable and recovering states override any previously settled turn.
	if (agent.agentState === "unavailable" || agent.agentState === "recovering") {
		const dead = agent.agentState === "unavailable";
		return CodexAgentResultSchema.parse({
			agentId: agent.agentId,
			agentState: agent.agentState,
			observation: "unavailable",
			activities: [],
			error: {
				code: dead ? "agent_dead" : "agent_unreachable",
				retryable: !dead,
				message: dead ? "codex agent is dead" : "codex agent is alive but unreachable",
			},
		});
	}
	const turn = turnOf(agent, waitedTurnId);
	const activities = publishedActivities(turn?.activities);
	if (!turn) {
		return CodexAgentResultSchema.parse({
			agentId: agent.agentId,
			agentState: agent.agentState === "working" ? "idle" : agent.agentState,
			observation: agent.agentState === "creating" ? "waitTimedOut" : "idle",
			activities: [],
		});
	}
	const exchange = agent.exchanges.findLast((candidate) => candidate.turnId === turn.id);
	if (turn.state === "inProgress") {
		const interrupting = agent.pendingInterrupt !== undefined;
		return CodexAgentResultSchema.parse({
			agentId: agent.agentId,
			agentState: "working",
			observation: interrupting ? "interruptRequested" : "waitTimedOut",
			turn: { id: turn.id, state: turn.state },
			// Interrupting turns omit delivery.
			delivery: interrupting ? undefined : exchange?.delivery,
			activities,
		});
	}
	return CodexAgentResultSchema.parse({
		agentId: agent.agentId,
		agentState: "idle",
		observation: "terminal",
		turn: { id: turn.id, state: turn.state },
		delivery: exchange?.delivery,
		activities,
		...(turn.state === "completed" ? { finalResponse: turn.finalResponse } : {}),
		...(turn.state === "failed" ? { error: { code: "turn_failed", message: turn.error, retryable: false } } : {}),
	});
}

export class CodexRoute {
	constructor(private readonly deps: CodexRouteDeps) {}

	async handle(req: Request, body: unknown): Promise<Response> {
		const parsed = CodexGatewayRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid Codex request" }, 400);

		const owner = this.deps.service.resolveOwner(req);
		if (!owner) {
			if (!presentedByRequest(req).token) {
				return json(
					{
						error: "this session is not bound to the gateway (launch it from the console, or install the codex CLI for a local agent)",
					},
					401,
				);
			}
			// Unknown tokens remain indistinguishable from unknown agents.
			return json({ error: "not found" }, 404);
		}

		const request = parsed.data;
		try {
			switch (request.kind) {
				case "start":
					return json(await this.start(req, owner, request));
				case "message":
					return json(await this.message(req, owner, request));
				case "await":
					return json(await this.awaitAgent(req, owner, request.agentId));
				case "stop":
					return json(await this.stop(req, owner, request));
				case "list":
					return json(this.list(owner, request));
				default:
					return json({ error: "unsupported Codex request" }, 400);
			}
		} catch (error) {
			if (error instanceof CodexTransitionError) {
				const answer = AGENT_FAILURE_ANSWERS[error.code];
				if (answer.kind === "request") {
					return json(
						CodexRequestErrorSchema.parse({
							error: {
								code: "invalid_input",
								retryable: false,
								message: sanitizeCodexErrorText(error.message),
							},
						}),
						400,
					);
				}
				const agentId =
					"agentId" in request
						? request.agentId
						: request.kind === "start"
							? codexAgentIdForOperation(request.operationId)
							: undefined;
				if (!agentId) throw error;
				return json(unavailable(agentId, answer, error.message));
			}
			throw error;
		}
	}

	private async start(
		req: Request,
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CodexGatewayRequestSchema.parse>, { kind: "start" }>,
	): Promise<CodexAgentResult> {
		// Derive agent identity from operationId so retries replay the same start.
		const agentId = codexAgentIdForOperation(request.operationId);
		// Only host sessions may override the execution working directory.
		if (request.cwd !== undefined && !isHostSpawn(owner.spawn)) {
			throw new CodexTransitionError("invalid_input", "cwd applies to host sessions only");
		}
		const target = this.deps.service.resolveExecutionTarget(owner, request.cwd);
		if (!target) return unavailable(agentId, TARGET_UNAVAILABLE, "no trusted execution target for this session");

		const committed = this.deps.service.beginStart(req, {
			agentId,
			operationId: request.operationId,
			prompt: request.prompt,
			target,
			model: request.model,
			serviceTier: request.serviceTier,
			at: this.now(),
		});
		let dispatched = true;
		if (committed.disposition === "committed") {
			dispatched = this.deps.relay.dispatch({
				kind: "start",
				ownerKey: this.ownerKey(owner),
				agentId,
				operationId: request.operationId,
				target,
				prompt: request.prompt,
				// Persisted model and tier are the replay source of truth.
				model: request.model,
				...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
			});
		}
		return this.settle(owner, agentId, request.operationId, dispatched);
	}

	private async message(
		req: Request,
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CodexGatewayRequestSchema.parse>, { kind: "message" }>,
	): Promise<CodexAgentResult> {
		const committed = this.deps.service.beginMessage(req, {
			agentId: request.agentId,
			operationId: request.operationId,
			prompt: request.prompt,
			serviceTier: request.serviceTier,
			at: this.now(),
		});
		let dispatched = true;
		if (committed.disposition === "committed") {
			const agent = committed.agent;
			dispatched = this.deps.relay.dispatch({
				kind: "message",
				ownerKey: this.ownerKey(owner),
				agentId: request.agentId,
				operationId: request.operationId,
				target: agent.resolvedTarget!,
				threadId: agent.threadId!,
				expectedTurnId: committed.operation.expectedTurnId,
				prompt: request.prompt,
				...(agent.serviceTier === undefined ? {} : { serviceTier: agent.serviceTier }),
				...(startModelOf(agent) === undefined ? {} : { model: startModelOf(agent) }),
			});
		}
		return this.settle(owner, request.agentId, request.operationId, dispatched);
	}

	private async stop(
		req: Request,
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CodexGatewayRequestSchema.parse>, { kind: "stop" }>,
	): Promise<CodexAgentResult> {
		const committed = this.deps.service.beginStop(req, {
			agentId: request.agentId,
			operationId: request.operationId,
			at: this.now(),
		});
		const agent = committed.agent;
		if (committed.disposition === "committed" && !committed.operation.noOp) {
			this.deps.relay.dispatch({
				kind: "interrupt",
				ownerKey: this.ownerKey(owner),
				agentId: request.agentId,
				operationId: request.operationId,
				target: agent.resolvedTarget!,
				threadId: agent.threadId!,
				turnId: committed.operation.turnId!,
			});
		}
		return describeAgent(this.current(owner, request.agentId) ?? agent, agent.activeTurnId);
	}

	private async awaitAgent(req: Request, owner: SessionRecord, agentId: string): Promise<CodexAgentResult> {
		const owned = this.deps.service.resolveOwnedAgent(req, agentId);
		if (!owned) return unavailable(agentId, AGENT_NOT_FOUND, "codex agent was not found");
		const waitedTurnId = owned.agent.activeTurnId;
		// Reconcile only stale agents; querying the active turn would mark it recovering.
		if (!waitedTurnId) this.deps.relay.reconcileStale(owner);
		if (!waitedTurnId) return describeAgent(owned.agent, lastSettledTurnId(owned.agent));
		await this.waitForTurn(owner, agentId, waitedTurnId, this.deadline());
		return describeAgent(this.current(owner, agentId) ?? owned.agent, waitedTurnId);
	}

	private list(
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CodexGatewayRequestSchema.parse>, { kind: "list" }>,
	): CodexListAgentsResult {
		this.deps.relay.reconcileStale(owner);
		const agents = this.deps.service.listOwnedAgents(owner);
		const selected =
			request.agentId === undefined ? agents : agents.filter((agent) => agent.agentId === request.agentId);
		return projectCodexListResult(selected, undefined, {
			detail: request.agentId === undefined ? request.detail : "full",
			limit: request.limit,
		});
	}

	private async settle(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		dispatched = true,
	): Promise<CodexAgentResult> {
		// Acceptance and turn settlement share one deadline.
		const deadline = dispatched ? this.deadline() : this.now();
		const accepted = await this.waitForAcceptance(owner, agentId, operationId, deadline);
		const agent = this.current(owner, agentId);
		if (!agent) return unavailable(agentId, AGENT_NOT_FOUND, "codex agent was not found");
		const turnId = accepted?.turnId;
		if (!turnId) {
			// Do not report delivery or a turn without confirmed acceptance.
			if (agent.agentState === "creating") {
				return CodexAgentResultSchema.parse({
					agentId,
					agentState: "creating",
					observation: "waitTimedOut",
					activities: [],
				});
			}
			const recovering = this.deps.service.abandonDelivery(owner, agentId, operationId, this.now());
			// Unconfirmed delivery is reported as recovery, never as idle.
			return CodexAgentResultSchema.parse({
				agentId,
				agentState: recovering?.agentState === "unavailable" ? "unavailable" : "recovering",
				observation: "indeterminate",
				activities: [],
				error: {
					code: "indeterminate",
					retryable: true,
					message:
						this.deps.service.takeRefusalReason(operationId) ??
						"codex delivery was not confirmed within the wait budget",
				},
			});
		}
		await this.waitForTurn(owner, agentId, turnId, deadline);
		return describeAgent(this.current(owner, agentId) ?? agent, turnId);
	}

	private async waitForAcceptance(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		deadline: number,
	): Promise<{ turnId: string } | undefined> {
		const accepted = () => {
			const operation = this.current(owner, agentId)?.operations.find(
				(candidate) => candidate.operationId === operationId,
			);
			return operation?.state === "requested" ? undefined : operation;
		};
		await this.deps.relay.waitFor(this.ownerKey(owner), agentId, () => accepted() !== undefined, deadline);
		const settled = accepted();
		return settled?.turnId ? { turnId: settled.turnId } : undefined;
	}

	private async waitForTurn(owner: SessionRecord, agentId: string, turnId: string, deadline: number): Promise<void> {
		await this.deps.relay.waitFor(
			this.ownerKey(owner),
			agentId,
			() => {
				const agent = this.current(owner, agentId);
				if (!agent || agent.agentState === "unavailable" || agent.agentState === "recovering") return true;
				return turnOf(agent, turnId)?.state !== "inProgress";
			},
			deadline,
		);
	}

	private current(owner: SessionRecord, agentId: string): CodexPersistedAgent | undefined {
		return this.deps.service.listOwnedAgents(owner).find((agent) => agent.agentId === agentId);
	}

	private ownerKey(owner: SessionRecord): string {
		return this.deps.service.ownerKeyOf(owner);
	}

	private deadline(): number {
		return this.now() + (this.deps.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS);
	}

	private now(): number {
		return this.deps.ambient.now();
	}
}

function lastSettledTurnId(agent: CodexPersistedAgent): string | undefined {
	return agent.turns.findLast((turn) => turn.state !== "inProgress")?.id;
}
