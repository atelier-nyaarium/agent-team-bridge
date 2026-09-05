import crypto from "node:crypto";
import { AGENT_ERROR_MAX_BYTES, agentIdForOperation, sanitizeAgentErrorText } from "../../shared/agent-record.js";
import type { CodexServiceTier } from "../../shared/codex-agent.js";
import type {
	LocalAgentAnswer,
	LocalAgentState,
	LocalBackendSpec,
	LocalErrorCode,
	LocalListAgent,
	LocalRefusal,
	LocalRequest,
	LocalTurnState,
} from "./localAgentRuntime.js";
import type { LocalBackendSession, LocalTerminal, LocalTurnHandle } from "./localAgentSession.js";

export interface LocalHandlerHost {
	spec: LocalBackendSpec;
	now(): number;
	open(): Promise<LocalBackendSession>;
	markUsed(at?: number): void;
}

interface LocalTurnRecord {
	id: string;
	state: LocalTurnState;
	commentary: string[];
	omitted: number;
	finalResponse?: string;
	error?: string;
	updatedAt: number;
}

export interface LocalExchangeRecord {
	kind: "start" | "message";
	prompt: string;
	status: "accepted";
	delivery: string;
	turnId: string;
	createdAt: number;
	acceptedAt: number;
}

interface LocalAgentRecord {
	agentId: string;
	threadId: string;
	createdAt: number;
	updatedAt: number;
	activeTurnId?: string;
	serviceTier?: CodexServiceTier;
	model?: string;
	turns: LocalTurnRecord[];
	exchanges: LocalExchangeRecord[];
	settled?: Promise<LocalTerminal>;
}

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return sanitizeAgentErrorText(text, AGENT_ERROR_MAX_BYTES) || `agent command failed`;
}

export class LocalAgentHandlers {
	private readonly agents = new Map<string, LocalAgentRecord>();

	constructor(private readonly host: LocalHandlerHost) {}

	list(): LocalListAgent[] {
		return [...this.agents.values()].map((agent) => ({
			agentId: agent.agentId,
			agentState: this.stateOf(agent),
			...(agent.model === undefined ? {} : { model: agent.model }),
			...(agent.activeTurnId ? { activeTurnId: agent.activeTurnId } : {}),
			exchanges: agent.exchanges.map((exchange) => ({ ...exchange })),
			turns: agent.turns.map((turn) => ({
				id: turn.id,
				state: turn.state,
				activities: this.activitiesOf(turn),
				...(turn.state === "completed" ? { finalResponse: turn.finalResponse ?? "" } : {}),
				...(turn.state === "failed" ? { error: turn.error ?? `turn failed` } : {}),
				updatedAt: turn.updatedAt,
			})),
			createdAt: agent.createdAt,
			updatedAt: agent.updatedAt,
		}));
	}

	hasActiveTurn(): boolean {
		for (const agent of this.agents.values()) {
			if (agent.activeTurnId) return true;
		}
		return false;
	}

	async start(request: LocalRequest): Promise<LocalAgentAnswer> {
		// Preserve a caller-supplied operation identity for agent derivation.
		const operationId = request.operationId ?? crypto.randomUUID();
		const agentId = agentIdForOperation(this.host.spec.backendId, operationId);
		const prompt = request.prompt ?? "";

		let session: LocalBackendSession;
		try {
			session = await this.host.open();
		} catch (error) {
			return this.fail(agentId, "app_server_unavailable", errorText(error), true);
		}

		const createdAt = this.host.now();
		let threadId: string;
		try {
			threadId = await session.openThread({
				cwd: request.cwd ?? this.host.spec.defaultCwd(),
				model: request.model,
				serviceTier: request.serviceTier,
			});
		} catch (error) {
			return this.fail(agentId, "app_server_unavailable", errorText(error), true);
		}

		const agent: LocalAgentRecord = {
			agentId,
			threadId,
			createdAt,
			updatedAt: createdAt,
			...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
			...(request.model === undefined ? {} : { model: request.model }),
			turns: [],
			exchanges: [],
		};
		this.agents.set(agentId, agent);
		return this.dispatchTurn(session, agent, prompt, "start");
	}

	async message(request: LocalRequest): Promise<LocalAgentAnswer | LocalRefusal> {
		const agent = this.agents.get(request.agentId ?? "");
		if (!agent) return this.notFound(request.agentId ?? "");
		const prompt = request.prompt ?? "";
		let session: LocalBackendSession;
		try {
			session = await this.host.open();
		} catch (error) {
			return this.fail(agent.agentId, "app_server_unavailable", errorText(error), true);
		}

		const active = this.activeTurn(agent);
		if (active) {
			// Refuse busy requests when steering is unavailable.
			if (!session.steerTurn) return { refused: this.host.spec.busyMessage ?? `agent is still working` };
			try {
				await session.steerTurn(agent.threadId, active.id, prompt);
			} catch (error) {
				return this.fail(agent.agentId, "app_server_unavailable", errorText(error), true);
			}
			const at = this.touch(agent);
			agent.exchanges.push({
				kind: "message",
				prompt,
				status: "accepted",
				delivery: "steered",
				turnId: active.id,
				createdAt: at,
				acceptedAt: at,
			});
			if (request.serviceTier !== undefined) agent.serviceTier = request.serviceTier;
			return this.waitFor(agent, active.id, "steered");
		}

		const serviceTier = request.serviceTier ?? agent.serviceTier;
		const answer = await this.dispatchTurn(session, agent, prompt, "message", { model: agent.model, serviceTier });
		if (serviceTier !== undefined && answer.observation !== "unavailable") agent.serviceTier = serviceTier;
		return answer;
	}

	async awaitTurn(request: LocalRequest): Promise<LocalAgentAnswer> {
		const agent = this.agents.get(request.agentId ?? "");
		if (!agent) return this.notFound(request.agentId ?? "");
		const active = this.activeTurn(agent);
		if (!active) return this.settledAnswer(agent);
		return this.waitFor(agent, active.id);
	}

	async stop(request: LocalRequest): Promise<LocalAgentAnswer> {
		const agent = this.agents.get(request.agentId ?? "");
		if (!agent) return this.notFound(request.agentId ?? "");
		const active = this.activeTurn(agent);
		if (!active) return this.idleAnswer(agent);

		let session: LocalBackendSession;
		try {
			session = await this.host.open();
		} catch (error) {
			return this.fail(agent.agentId, "app_server_unavailable", errorText(error), true);
		}
		try {
			await session.interruptTurn(agent.threadId, active.id);
		} catch (error) {
			return this.fail(agent.agentId, "app_server_unavailable", errorText(error), true);
		}
		return {
			agentId: agent.agentId,
			agentState: "working",
			observation: "interruptRequested",
			turn: { id: active.id, state: "inProgress" },
			activities: this.activitiesOf(active),
		};
	}

	recordActivity(turnId: string, text: string): void {
		if (!text) return;
		for (const agent of this.agents.values()) {
			const turn = agent.turns.find((candidate) => candidate.id === turnId);
			if (turn?.state !== "inProgress") continue;
			turn.commentary.push(text);
			while (turn.commentary.length > this.host.spec.maxActivities) {
				turn.commentary.shift();
				turn.omitted += 1;
			}
			turn.updatedAt = this.host.now();
			agent.updatedAt = Math.max(agent.updatedAt, turn.updatedAt);
			return;
		}
	}

	private async dispatchTurn(
		session: LocalBackendSession,
		agent: LocalAgentRecord,
		prompt: string,
		kind: "start" | "message",
		settings: { model?: string; serviceTier?: CodexServiceTier } = {},
	): Promise<LocalAgentAnswer> {
		let handle: LocalTurnHandle;
		try {
			handle = await session.startTurn(agent.threadId, prompt, settings);
		} catch (error) {
			return this.fail(agent.agentId, "app_server_unavailable", errorText(error), true);
		}

		const at = this.touch(agent);
		const turn: LocalTurnRecord = {
			id: handle.turnId,
			state: "inProgress",
			commentary: [],
			omitted: 0,
			updatedAt: at,
		};
		agent.turns.push(turn);
		agent.activeTurnId = turn.id;
		// Register the turn before racing its terminal.
		const settled = handle.settled.catch((error): LocalTerminal => ({ status: "failed", error: errorText(error) }));
		agent.settled = settled;
		agent.exchanges.push({
			kind,
			prompt,
			status: "accepted",
			delivery: kind === "start" ? "started" : this.host.spec.followupDelivery,
			turnId: turn.id,
			createdAt: at,
			acceptedAt: at,
		});
		void settled.then((terminal) => this.applyTerminal(agent, turn.id, terminal));

		return this.waitFor(agent, turn.id, kind === "start" ? "started" : this.host.spec.followupDelivery);
	}

	private async waitFor(agent: LocalAgentRecord, turnId: string, delivery?: string): Promise<LocalAgentAnswer> {
		const settled = agent.settled;
		if (settled) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const budget = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), this.host.spec.waitBudgetMs);
			});
			try {
				const outcome = await Promise.race([settled, budget]);
				if (outcome !== "timeout") this.applyTerminal(agent, turnId, outcome);
			} finally {
				if (timer) clearTimeout(timer);
			}
		}

		const turn = agent.turns.find((candidate) => candidate.id === turnId);
		if (!turn) return this.notFound(agent.agentId);
		if (turn.state === "inProgress") {
			return {
				agentId: agent.agentId,
				agentState: "working",
				observation: "waitTimedOut",
				turn: { id: turn.id, state: "inProgress" },
				...(delivery ? { delivery } : {}),
				activities: this.activitiesOf(turn),
			};
		}
		return this.terminalAnswer(agent, turn, delivery);
	}

	private applyTerminal(agent: LocalAgentRecord, turnId: string, terminal: LocalTerminal): void {
		// Apply the terminal once because listener and waiter paths race.
		const turn = agent.turns.find((candidate) => candidate.id === turnId);
		if (turn?.state !== "inProgress") return;
		turn.state = terminal.status;
		if (terminal.status === "completed") turn.finalResponse = terminal.finalResponse ?? "";
		// Normalize child errors before schema validation.
		if (terminal.status === "failed") turn.error = errorText(terminal.error || `turn failed`);
		turn.updatedAt = this.host.now();
		if (agent.activeTurnId === turnId) {
			agent.activeTurnId = undefined;
			agent.settled = undefined;
		}
		agent.updatedAt = Math.max(agent.updatedAt, turn.updatedAt);
		this.host.markUsed(turn.updatedAt);
	}

	private activitiesOf(turn: LocalTurnRecord): LocalAgentAnswer["activities"] {
		// Keep the truncation marker with the full activity window.
		const kept = turn.commentary.map((text) => ({ kind: "commentary" as const, text }));
		if (turn.omitted === 0) return kept;
		return [...kept, { kind: "truncated" as const, omitted: turn.omitted }];
	}

	private terminalAnswer(agent: LocalAgentRecord, turn: LocalTurnRecord, delivery?: string): LocalAgentAnswer {
		const base: LocalAgentAnswer = {
			agentId: agent.agentId,
			agentState: "idle",
			observation: "terminal",
			turn: { id: turn.id, state: turn.state },
			...(delivery ? { delivery } : {}),
			activities: this.activitiesOf(turn),
		};
		if (turn.state === "completed") return { ...base, finalResponse: turn.finalResponse ?? "" };
		if (turn.state === "failed") {
			return {
				...base,
				error: { code: "turn_failed", message: turn.error || `turn failed`, retryable: false },
			};
		}
		return base;
	}

	private settledAnswer(agent: LocalAgentRecord): LocalAgentAnswer {
		const last = agent.turns[agent.turns.length - 1];
		if (!last || last.state === "inProgress") return this.idleAnswer(agent);
		return this.terminalAnswer(agent, last);
	}

	private idleAnswer(agent: LocalAgentRecord): LocalAgentAnswer {
		return { agentId: agent.agentId, agentState: "idle", observation: "idle", activities: [] };
	}

	private notFound(agentId: string): LocalAgentAnswer {
		return this.fail(agentId, "not_found", `agent is not known to this session`, false);
	}

	private fail(agentId: string, code: LocalErrorCode, message: string, retryable: boolean): LocalAgentAnswer {
		return {
			agentId,
			agentState: "unavailable",
			observation: "unavailable",
			activities: [],
			error: { code, message, retryable },
		};
	}

	private activeTurn(agent: LocalAgentRecord): LocalTurnRecord | undefined {
		if (!agent.activeTurnId) return undefined;
		const turn = agent.turns.find((candidate) => candidate.id === agent.activeTurnId);
		return turn?.state === "inProgress" ? turn : undefined;
	}

	private stateOf(agent: LocalAgentRecord): LocalAgentState {
		return this.activeTurn(agent) ? "working" : "idle";
	}

	private touch(agent: LocalAgentRecord): number {
		const at = this.host.now();
		agent.updatedAt = Math.max(agent.updatedAt, at);
		this.host.markUsed(at);
		return agent.updatedAt;
	}
}
