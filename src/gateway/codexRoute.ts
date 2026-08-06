import {
	type CodexAgentResult,
	CodexAgentResultSchema,
	type CodexErrorCode,
	CodexGatewayRequestSchema,
	type CodexListAgentsResult,
	type CodexPersistedAgent,
	type CodexStoredTurn,
	codexAgentIdForOperation,
	projectCodexListResult,
} from "../shared/codex-thinking.js";
import type { SessionRecord } from "../shared/session-store.js";
import { type CodexAgentService, CodexTransitionError, type CodexTransitionErrorCode } from "./codexAgentService.js";
import type { CodexRelay } from "./codexRelay.js";

////////////////////////////////
//  Interfaces & Types

export interface CodexRouteDeps {
	service: CodexAgentService;
	relay: CodexRelay;
	now?(): number;
	/** How long a waiting call blocks. The tool's own documented budget; overridable for tests. */
	waitBudgetMs?: number;
}

////////////////////////////////
//  Functions & Helpers

const DEFAULT_WAIT_BUDGET_MS = 9 * 60_000;

/**
 * Transition failures mapped to the envelope's own error vocabulary, with whether a caller may
 * usefully try again.
 *
 * Keyed by the error union so a new transition code fails the build here rather than producing an
 * envelope the schema rejects at runtime, which is how this table's first version shipped: it
 * invented a `conflict` code the enum does not have, and every failing call answered HTML.
 */
const ERROR_CODES: Record<CodexTransitionErrorCode, { code: CodexErrorCode; retryable: boolean }> = {
	invalid_input: { code: "invalid_input", retryable: false },
	not_found: { code: "not_found", retryable: false },
	// The operation ID was reused with different input, which no retry of the same call fixes.
	operation_conflict: { code: "invalid_input", retryable: false },
	// The agent cannot take this right now. Reconciliation may well make it possible.
	state_conflict: { code: "indeterminate", retryable: true },
	target_unavailable: { code: "daemon_unavailable", retryable: true },
	persistence_failed: { code: "daemon_unavailable", retryable: true },
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A result carrying nothing but a failure. Deliberately claims no agent activity, which is what the
 * envelope requires of a contextless error. */
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
const DELIVERY_UNCONFIRMED = { code: "app_server_unavailable" as const, retryable: true };

function turnOf(agent: CodexPersistedAgent, turnId: string | undefined): CodexStoredTurn | undefined {
	return turnId ? agent.turns.find((turn) => turn.id === turnId) : undefined;
}

/**
 * What one call should report about an agent, given the turn it was waiting on.
 *
 * The turn is captured at invocation and never re-read from the record, so a later turn cannot
 * satisfy an earlier waiter. Everything else is derived from the stored state, which is why a result
 * cannot claim an outcome the record does not hold.
 */
function describeAgent(agent: CodexPersistedAgent, waitedTurnId: string | undefined): CodexAgentResult {
	const turn = turnOf(agent, waitedTurnId);
	const activities = (turn?.activities ?? []).map((activity) =>
		activity.kind === "commentary" ? { kind: activity.kind, text: activity.text } : activity,
	);
	if (!turn) {
		// No turn to speak for. An agent that never got one reports its state and nothing else.
		return CodexAgentResultSchema.parse({
			agentId: agent.agentId,
			agentState: agent.agentState === "working" ? "idle" : agent.agentState,
			observation:
				agent.agentState === "unavailable" || agent.agentState === "recovering" ? "unavailable" : "idle",
			activities: [],
			...(agent.agentState === "unavailable" || agent.agentState === "recovering"
				? { error: { ...DELIVERY_UNCONFIRMED, message: "codex agent state could not be confirmed" } }
				: {}),
		});
	}
	const exchange = agent.exchanges.findLast((candidate) => candidate.turnId === turn.id);
	if (turn.state === "inProgress") {
		return CodexAgentResultSchema.parse({
			agentId: agent.agentId,
			agentState: "working",
			observation: agent.pendingInterrupt ? "interruptRequested" : "waitTimedOut",
			turn: { id: turn.id, state: turn.state },
			delivery: exchange?.delivery,
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

////////////////////////////////
//  Class

/**
 * The one authenticated entry point for every Codex tool.
 *
 * Five tools, one handler: session authority, input validation, idempotency and the result envelope
 * are each written once here rather than five times, which is what keeps them from drifting apart.
 */
export class CodexRoute {
	constructor(private readonly deps: CodexRouteDeps) {}

	async handle(req: Request, body: unknown): Promise<Response> {
		const parsed = CodexGatewayRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid Codex request" }, 400);

		const owner = this.deps.service.resolveOwner(req);
		// Indistinguishable from an unknown agent on purpose: neither answer may tell a caller whether
		// somebody else's session exists.
		if (!owner) return json({ error: "not found" }, 404);

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
					return json(this.list(owner));
				default:
					return json({ error: "unsupported Codex request" }, 400);
			}
		} catch (error) {
			if (error instanceof CodexTransitionError) {
				// Every failing kind names its agent one way or the other: an existing one carries the ID,
				// and a start derives it from the operation it would have created.
				const agentId =
					"agentId" in request
						? request.agentId
						: request.kind === "start"
							? codexAgentIdForOperation(request.operationId)
							: undefined;
				if (!agentId) throw error;
				return json(unavailable(agentId, ERROR_CODES[error.code], error.message));
			}
			throw error;
		}
	}

	private async start(
		req: Request,
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CodexGatewayRequestSchema.parse>, { kind: "start" }>,
	): Promise<CodexAgentResult> {
		// Derived, not minted, so an HTTP retry of this same invocation names the same agent and
		// replays instead of colliding.
		const agentId = codexAgentIdForOperation(request.operationId);
		const target = this.deps.service.resolveExecutionTarget(owner);
		if (!target) return unavailable(agentId, TARGET_UNAVAILABLE, "no trusted execution target for this session");

		const committed = this.deps.service.beginStart(req, {
			agentId,
			operationId: request.operationId,
			prompt: request.prompt,
			at: this.now(),
		});
		if (committed.disposition === "committed") {
			this.deps.relay.dispatch({
				kind: "start",
				ownerKey: this.ownerKey(owner),
				agentId,
				operationId: request.operationId,
				target,
				prompt: request.prompt,
			});
		}
		return this.settle(owner, agentId, request.operationId, request.awaitResponse);
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
			at: this.now(),
		});
		if (committed.disposition === "committed") {
			const agent = committed.agent;
			this.deps.relay.dispatch({
				kind: "message",
				ownerKey: this.ownerKey(owner),
				agentId: request.agentId,
				operationId: request.operationId,
				target: agent.resolvedTarget!,
				threadId: agent.threadId!,
				expectedTurnId: committed.operation.expectedTurnId,
				prompt: request.prompt,
			});
		}
		return this.settle(owner, request.agentId, request.operationId, request.awaitResponse);
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
		// An idle stop is a successful no-op that never reaches the daemon, which is what `noOp` records.
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
		// Stop returns immediately by design. The authoritative outcome arrives later, on the turn.
		return describeAgent(this.current(owner, request.agentId) ?? agent, agent.activeTurnId);
	}

	private async awaitAgent(req: Request, owner: SessionRecord, agentId: string): Promise<CodexAgentResult> {
		const owned = this.deps.service.resolveOwnedAgent(req, agentId);
		if (!owned) return unavailable(agentId, AGENT_NOT_FOUND, "codex agent was not found");
		// With no active turn there is nothing to wait for, so the latest settled state is the answer.
		const waitedTurnId = owned.agent.activeTurnId;
		if (!waitedTurnId) return describeAgent(owned.agent, lastSettledTurnId(owned.agent));
		await this.waitForTurn(owner, agentId, waitedTurnId);
		return describeAgent(this.current(owner, agentId) ?? owned.agent, waitedTurnId);
	}

	private list(owner: SessionRecord): CodexListAgentsResult {
		return projectCodexListResult(this.deps.service.listOwnedAgents(owner));
	}

	/**
	 * Report on the operation just committed, waiting for its exact turn when asked to.
	 *
	 * The turn is whatever the acceptance recorded, so a caller that did not wait still learns which
	 * turn its prompt landed in, and one that did wait cannot be satisfied by a later turn.
	 */
	private async settle(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		awaitResponse: boolean,
	): Promise<CodexAgentResult> {
		const accepted = await this.waitForAcceptance(owner, agentId, operationId);
		const agent = this.current(owner, agentId);
		if (!agent) return unavailable(agentId, AGENT_NOT_FOUND, "codex agent was not found");
		const turnId = accepted?.turnId;
		if (!turnId) {
			// Never accepted within the budget. Reporting a turn or a delivery here would describe work
			// that was never proven to have started.
			return CodexAgentResultSchema.parse({
				agentId,
				agentState: agent.agentState === "creating" ? "creating" : agent.agentState,
				observation: agent.agentState === "creating" ? "waitTimedOut" : "unavailable",
				activities: [],
				...(agent.agentState === "creating"
					? {}
					: { error: { ...DELIVERY_UNCONFIRMED, message: "codex delivery was not confirmed" } }),
			});
		}
		if (!awaitResponse) return describeAgent(agent, turnId);
		await this.waitForTurn(owner, agentId, turnId);
		return describeAgent(this.current(owner, agentId) ?? agent, turnId);
	}

	/** The operation's accepted turn, once the daemon's receipt has been committed. */
	private async waitForAcceptance(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
	): Promise<{ turnId: string } | undefined> {
		const accepted = () => {
			const operation = this.current(owner, agentId)?.operations.find(
				(candidate) => candidate.operationId === operationId,
			);
			return operation?.state === "requested" ? undefined : operation;
		};
		await this.deps.relay.waitFor(this.ownerKey(owner), agentId, () => accepted() !== undefined, this.deadline());
		const settled = accepted();
		return settled?.turnId ? { turnId: settled.turnId } : undefined;
	}

	private async waitForTurn(owner: SessionRecord, agentId: string, turnId: string): Promise<void> {
		await this.deps.relay.waitFor(
			this.ownerKey(owner),
			agentId,
			() => {
				const agent = this.current(owner, agentId);
				// An agent that has fallen out of a working state settles the wait too: there is nothing
				// left that could produce this turn's outcome until reconciliation runs.
				if (!agent || agent.agentState === "unavailable") return true;
				return turnOf(agent, turnId)?.state !== "inProgress";
			},
			this.deadline(),
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
		return this.deps.now?.() ?? Date.now();
	}
}

////////////////////////////////
//  Functions & Helpers

/** The most recent turn that actually ended, which is what an await with nothing running reports. */
function lastSettledTurnId(agent: CodexPersistedAgent): string | undefined {
	return agent.turns.findLast((turn) => turn.state !== "inProgress")?.id;
}
