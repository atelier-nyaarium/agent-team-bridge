import {
	COPILOT_WAIT_BUDGET_MS,
	type CopilotAgentResult,
	CopilotAgentResultSchema,
	type CopilotErrorCode,
	CopilotGatewayRequestSchema,
	type CopilotPersistedAgent,
	CopilotRequestErrorSchema,
	type CopilotStoredTurn,
	copilotAgentIdForOperation,
	projectCopilotListResult,
	sanitizeCopilotErrorText,
} from "../shared/copilot-agent.js";
import type { SessionRecord } from "../shared/session-store.js";
import { AGENT_FAILURE_ANSWERS, jsonResponse as json } from "./agentRouteEnvelope.js";
import { type CopilotAgentService, CopilotTransitionError } from "./copilotAgentService.js";
import type { CopilotRelay } from "./copilotRelay.js";
import { presentedByRequest } from "./sessionAuthority.js";

export interface CopilotRouteDeps {
	service: CopilotAgentService;
	relay: CopilotRelay;
	now?(): number;
	waitBudgetMs?: number;
}

function unavailable(agentId: string, code: CopilotErrorCode, message: string): CopilotAgentResult {
	return CopilotAgentResultSchema.parse({
		agentId,
		agentState: code === "indeterminate" ? "recovering" : "unavailable",
		observation: code === "indeterminate" ? "indeterminate" : "unavailable",
		activities: [],
		error: { code, message, retryable: code !== "not_found" },
	});
}

function turnOf(agent: CopilotPersistedAgent, turnId?: string): CopilotStoredTurn | undefined {
	return turnId ? agent.turns.find((turn) => turn.id === turnId) : undefined;
}

function describeAgent(
	agent: CopilotPersistedAgent,
	options: {
		observation?: CopilotAgentResult["observation"];
		turnId?: string;
		delivery?: "started" | "followup";
		includeLastSettled?: boolean;
	} = {},
): CopilotAgentResult {
	const uncertain = agent.agentState === "recovering" || agent.agentState === "unavailable";
	const turn = uncertain
		? undefined
		: (turnOf(agent, options.turnId ?? agent.activeTurnId) ??
			(options.includeLastSettled
				? agent.turns.findLast((candidate) => candidate.state !== "inProgress")
				: undefined));
	const activities = (turn?.activities ?? []).map((activity) =>
		activity.kind === "commentary" ? { kind: activity.kind, text: activity.text } : activity,
	);
	const result: CopilotAgentResult = {
		agentId: agent.agentId,
		agentState: agent.agentState,
		observation:
			options.observation ??
			(agent.agentState === "idle"
				? turn
					? "terminal"
					: "idle"
				: agent.agentState === "working"
					? "waitTimedOut"
					: agent.agentState === "creating"
						? "waitTimedOut"
						: agent.agentState === "recovering"
							? "indeterminate"
							: "unavailable"),
		activities,
		...(turn ? { turn: { id: turn.id, state: turn.state } } : {}),
		...(options.delivery && !uncertain ? { delivery: options.delivery } : {}),
	};
	if (uncertain) {
		result.error = {
			code: agent.agentState === "recovering" ? "indeterminate" : "daemon_unavailable",
			message:
				agent.agentState === "recovering"
					? "Copilot state could not be confirmed"
					: "Copilot agent is unavailable",
			retryable: true,
		};
	}
	if (turn?.state === "completed") result.finalResponse = turn.finalResponse;
	if (turn?.state === "failed") result.error = { code: "turn_failed", message: turn.error, retryable: false };
	return CopilotAgentResultSchema.parse(result);
}

export class CopilotRoute {
	constructor(private readonly deps: CopilotRouteDeps) {}

	async handle(req: Request, body: unknown): Promise<Response> {
		const parsed = CopilotGatewayRequestSchema.safeParse(body);
		if (!parsed.success)
			return json(
				CopilotRequestErrorSchema.parse({
					error: { code: "invalid_input", retryable: false, message: "invalid Copilot request" },
				}),
				400,
			);
		const owner = this.deps.service.resolveOwner(req);
		if (!owner) {
			// Same split as CodexRoute: a token-less caller is told so (it leaks nothing it does not
			// already know), an unknown token stays "not found" against session probing.
			if (!presentedByRequest(req).token) {
				return json(
					{
						error: "this session is not bound to the gateway (launch it from the console, or install the copilot CLI for a local agent)",
					},
					401,
				);
			}
			return json({ error: "not found" }, 404);
		}
		try {
			switch (parsed.data.kind) {
				case "start":
					return json(await this.start(req, owner, parsed.data));
				case "message":
					return json(await this.message(req, owner, parsed.data));
				case "await":
					return json(await this.awaitAgent(req, owner, parsed.data.agentId));
				case "stop":
					return json(await this.stop(req, owner, parsed.data));
				case "list":
					return json(this.list(owner));
			}
		} catch (error) {
			if (error instanceof CopilotTransitionError) {
				const answer = AGENT_FAILURE_ANSWERS[error.code];
				if (answer.kind === "request")
					return json(
						CopilotRequestErrorSchema.parse({
							error: {
								code: "invalid_input",
								retryable: false,
								message: sanitizeCopilotErrorText(error.message),
							},
						}),
						400,
					);
				const agentId =
					"agentId" in parsed.data
						? parsed.data.agentId
						: parsed.data.kind === "start"
							? copilotAgentIdForOperation(parsed.data.operationId)
							: undefined;
				if (!agentId) throw error;
				return json(unavailable(agentId, answer.code, error.message));
			}
			throw error;
		}
		return json({ error: "unsupported Copilot request" }, 400);
	}

	private async start(
		req: Request,
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CopilotGatewayRequestSchema.parse>, { kind: "start" }>,
	): Promise<CopilotAgentResult> {
		const agentId = copilotAgentIdForOperation(request.operationId);
		if (request.cwd !== undefined && owner.spawn !== "host")
			throw new CopilotTransitionError("invalid_input", "cwd applies to host sessions only");
		const target = this.deps.service.resolveExecutionTarget(owner, request.cwd);
		if (!target) return unavailable(agentId, "daemon_unavailable", "no trusted execution target for this session");
		const committed = this.deps.service.beginStart(req, {
			agentId,
			operationId: request.operationId,
			prompt: request.prompt,
			target,
			model: request.model,
			at: this.now(),
		});
		let dispatched = true;
		if (committed.disposition === "committed") {
			dispatched = this.deps.relay.dispatch({
				kind: "start",
				ownerKey: this.deps.service.ownerKeyOf(owner),
				agentId,
				operationId: request.operationId,
				target,
				prompt: request.prompt,
				...(request.model ? { model: request.model } : {}),
			});
		}
		return this.settle(owner, agentId, request.operationId, "started", committed.agent, dispatched);
	}

	private async message(
		req: Request,
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CopilotGatewayRequestSchema.parse>, { kind: "message" }>,
	): Promise<CopilotAgentResult> {
		const committed = this.deps.service.beginMessage(req, {
			agentId: request.agentId,
			operationId: request.operationId,
			prompt: request.prompt,
			at: this.now(),
		});
		let dispatched = true;
		if (committed.disposition === "committed") {
			const agent = committed.agent;
			dispatched = this.deps.relay.dispatch({
				kind: "message",
				ownerKey: this.deps.service.ownerKeyOf(owner),
				agentId: request.agentId,
				operationId: request.operationId,
				target: agent.resolvedTarget!,
				sessionId: agent.sessionId!,
				prompt: request.prompt,
			});
		}
		return this.settle(owner, request.agentId, request.operationId, "followup", committed.agent, dispatched);
	}

	private async stop(
		req: Request,
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CopilotGatewayRequestSchema.parse>, { kind: "stop" }>,
	): Promise<CopilotAgentResult> {
		const committed = this.deps.service.beginStop(req, {
			agentId: request.agentId,
			operationId: request.operationId,
			at: this.now(),
		});
		if (committed.disposition === "committed" && committed.operation.state === "requested") {
			this.deps.relay.dispatch({
				kind: "interrupt",
				ownerKey: this.deps.service.ownerKeyOf(owner),
				agentId: request.agentId,
				operationId: request.operationId,
				target: committed.agent.resolvedTarget!,
				sessionId: committed.agent.sessionId!,
				turnId: committed.operation.turnId!,
			});
		}
		return describeAgent(committed.agent, {
			observation: committed.operation.state === "accepted" ? "idle" : "interruptRequested",
			turnId: committed.agent.activeTurnId,
		});
	}

	private async awaitAgent(req: Request, owner: SessionRecord, agentId: string): Promise<CopilotAgentResult> {
		const owned = this.deps.service.resolveOwnedAgent(req, agentId);
		if (!owned) return unavailable(agentId, "not_found", "Copilot agent was not found");
		const turnId = owned.agent.activeTurnId;
		if (!turnId) {
			this.deps.relay.reconcileStale(owner);
			return describeAgent(owned.agent, { includeLastSettled: true });
		}
		await this.deps.relay.waitFor(
			this.deps.service.ownerKeyOf(owner),
			agentId,
			() => {
				const current = this.current(owner, agentId);
				return current?.agentState !== "working" || current?.activeTurnId === undefined;
			},
			this.deadline(),
		);
		const current = this.current(owner, agentId);
		return current
			? describeAgent(current, {
					turnId,
					observation:
						current.agentState === "working"
							? "waitTimedOut"
							: current.agentState === "recovering"
								? "indeterminate"
								: "terminal",
				})
			: unavailable(agentId, "not_found", "Copilot agent was not found");
	}

	private list(owner: SessionRecord) {
		this.deps.relay.reconcileStale(owner);
		return projectCopilotListResult(this.deps.service.listOwnedAgents(owner));
	}

	private async settle(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		delivery: "started" | "followup",
		initial: CopilotPersistedAgent,
		dispatched = true,
	): Promise<CopilotAgentResult> {
		// A delivery that never left (no host socket) cannot be accepted, so waiting out the budget for
		// it would only delay the same indeterminate answer by four minutes.
		const deadline = dispatched ? this.deadline() : this.now();
		await this.deps.relay.waitFor(
			this.deps.service.ownerKeyOf(owner),
			agentId,
			() => {
				const operation = this.current(owner, agentId)?.operations.find(
					(candidate) => candidate.operationId === operationId,
				);
				return operation !== undefined && operation.state !== "requested";
			},
			deadline,
		);
		const current = this.current(owner, agentId) ?? initial;
		const operation = current.operations.find((candidate) => candidate.operationId === operationId);
		if (!operation || operation.state === "requested") {
			const abandoned = this.deps.service.abandonDelivery(owner, agentId, operationId, this.now());
			if (!abandoned) return unavailable(agentId, "not_found", "Copilot agent was not found");
			if (abandoned.agentState === "creating")
				return describeAgent(abandoned, { observation: "waitTimedOut", delivery });
			const refusal = this.deps.service.takeRefusal(operationId);
			return unavailable(
				agentId,
				refusal?.code ?? (abandoned.agentState === "unavailable" ? "daemon_unavailable" : "indeterminate"),
				refusal?.message ?? "Copilot delivery was not confirmed within the wait budget",
			);
		}
		if (!operation.turnId) {
			if (operation.state === "accepted") return describeAgent(current, { observation: "idle" });
			const refusal = this.deps.service.takeRefusal(operationId);
			return unavailable(
				agentId,
				refusal?.code ?? (current.agentState === "unavailable" ? "daemon_unavailable" : "indeterminate"),
				refusal?.message ?? "Copilot delivery could not be confirmed",
			);
		}
		await this.deps.relay.waitFor(
			this.deps.service.ownerKeyOf(owner),
			agentId,
			() => {
				const next = this.current(owner, agentId);
				const turn = next?.turns.find((candidate) => candidate.id === operation.turnId);
				return (
					!next ||
					next.agentState === "recovering" ||
					next.agentState === "unavailable" ||
					turn?.state !== "inProgress"
				);
			},
			deadline,
		);
		const settled = this.current(owner, agentId) ?? current;
		return describeAgent(settled, {
			turnId: operation.turnId,
			delivery,
			observation:
				settled.agentState === "working"
					? "waitTimedOut"
					: settled.agentState === "recovering"
						? "indeterminate"
						: "terminal",
		});
	}

	private current(owner: SessionRecord, agentId: string): CopilotPersistedAgent | undefined {
		return this.deps.service.listOwnedAgents(owner).find((agent) => agent.agentId === agentId);
	}

	private deadline(): number {
		return this.now() + (this.deps.waitBudgetMs ?? COPILOT_WAIT_BUDGET_MS);
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}
}
