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

////////////////////////////////
//  Interfaces & Types

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
	/** The tier this agent is currently set to, applied to each new turn. */
	serviceTier?: CodexServiceTier;
	/** The thread's model, kept so a later turn's tier is checked against it. */
	model?: string;
	turns: LocalTurnRecord[];
	exchanges: LocalExchangeRecord[];
	settled?: Promise<LocalTerminal>;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Child errors arrive as whatever the process wrote, which for a spawn failure is a multi-line stack
 * trace. Both result schemas require `value === sanitize(value)` and cap the bytes, so trimming alone
 * made an ordinary failure unreportable: the answer threw on its own way out and the caller learned
 * nothing about what actually went wrong. Sanitizing here covers every `fail()` site at once.
 */
function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return sanitizeAgentErrorText(text, AGENT_ERROR_MAX_BYTES) || `agent command failed`;
}

////////////////////////////////
//  Class

/** Every agent's history and its request kinds. */
export class LocalAgentHandlers {
	private readonly agents = new Map<string, LocalAgentRecord>();

	constructor(private readonly host: LocalHandlerHost) {}

	/** Insertion order, which is start order: nothing here is reordered by later work. */
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
		// The CALLER's identity when it supplied one, so an id is not merely spelled like a coordinated
		// one but is the same one. Minted only when nobody named it.
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
			// Nothing was recorded, so no record is invented and `list` stays honest.
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
			// Refusing the REQUEST keeps the running turn untouched, instead of racing a second one.
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
			// A steer carries no tier, so a change asked for here lands on the next turn.
			if (request.serviceTier !== undefined) agent.serviceTier = request.serviceTier;
			return this.waitFor(agent, active.id, "steered");
		}

		const serviceTier = request.serviceTier ?? agent.serviceTier;
		const answer = await this.dispatchTurn(session, agent, prompt, "message", { model: agent.model, serviceTier });
		// Remembered only once a turn started. A refused tier would otherwise ride every later message.
		if (serviceTier !== undefined && answer.observation !== "unavailable") agent.serviceTier = serviceTier;
		return answer;
	}

	async awaitTurn(request: LocalRequest): Promise<LocalAgentAnswer> {
		const agent = this.agents.get(request.agentId ?? "");
		if (!agent) return this.notFound(request.agentId ?? "");
		const active = this.activeTurn(agent);
		// Nothing running is not an error: the outcome is already in hand.
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
		// Requested, not ended: the turn's own terminal still decides how it finished.
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
			// The newest window is kept: what it is doing now explains a running turn best.
			while (turn.commentary.length > this.host.spec.maxActivities) {
				turn.commentary.shift();
				turn.omitted += 1;
			}
			turn.updatedAt = this.host.now();
			agent.updatedAt = Math.max(agent.updatedAt, turn.updatedAt);
			return;
		}
	}

	/** Open a turn and wait on it, recording the exchange that started it. */
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
		// `LocalTurnHandle` promises this never rejects. Held to it here, so a backend that breaks the
		// promise loses one turn rather than raising an unhandled rejection.
		const settled = handle.settled.catch((error): LocalTerminal => ({ status: "failed", error: errorText(error) }));
		agent.settled = settled;
		agent.exchanges.push({
			kind,
			prompt,
			status: "accepted",
			// The schema refuses any other word for a start.
			delivery: kind === "start" ? "started" : this.host.spec.followupDelivery,
			turnId: turn.id,
			createdAt: at,
			acceptedAt: at,
		});
		// Registered before the race, so a terminal beating the budget is recorded. applyTerminal is
		// idempotent for the case where it does not.
		void settled.then((terminal) => this.applyTerminal(agent, turn.id, terminal));

		return this.waitFor(agent, turn.id, kind === "start" ? "started" : this.host.spec.followupDelivery);
	}

	/** A turn outliving the budget keeps running; the caller collects it with an await. */
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

	/**
	 * Record how a turn ended, once.
	 *
	 * Two paths reach it: the dispatch listener and the racing caller. Whichever runs second must not
	 * re-stamp, or an await reports a fresher timestamp than the terminal it describes.
	 */
	private applyTerminal(agent: LocalAgentRecord, turnId: string, terminal: LocalTerminal): void {
		const turn = agent.turns.find((candidate) => candidate.id === turnId);
		if (turn?.state !== "inProgress") return;
		turn.state = terminal.status;
		if (terminal.status === "completed") turn.finalResponse = terminal.finalResponse ?? "";
		// The child wrote this, so it is normalized before it is stored rather than at each reader:
		// it leaves here for `error.message`, which both backends bound and refuse unnormalized.
		if (terminal.status === "failed") turn.error = errorText(terminal.error || `turn failed`);
		turn.updatedAt = this.host.now();
		if (agent.activeTurnId === turnId) {
			agent.activeTurnId = undefined;
			agent.settled = undefined;
		}
		agent.updatedAt = Math.max(agent.updatedAt, turn.updatedAt);
		// A terminal arrives on the event stream, not from a call, so it reaches no lease. Without
		// this the idle clock still reads the turn's START: a thirty-minute turn would be reapable
		// the instant it finished, instead of ten minutes after the child actually went quiet.
		this.host.markUsed(turn.updatedAt);
	}

	/** The marker sits at the end and the window is exactly full, per the shared invariant. */
	private activitiesOf(turn: LocalTurnRecord): LocalAgentAnswer["activities"] {
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

	/** The latest settled turn, for an await that found nothing running. */
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

	/** Returns the instant, so every child record written in one step shares a timestamp. */
	private touch(agent: LocalAgentRecord): number {
		const at = this.host.now();
		agent.updatedAt = Math.max(agent.updatedAt, at);
		this.host.markUsed(at);
		return agent.updatedAt;
	}
}
