// The daemonless half of agent delegation: a session running its own backend child, answering the
// same five tool calls in the same validated shapes the gateway path answers in.
//
// What it deliberately does NOT have is what a wire needs. There is no relay, so nothing is fenced;
// no restart, so nothing is durable; no HTTP, so an operation cannot be retried behind the caller's
// back and needs no replay identity. An agent lives exactly as long as the process that started it,
// which is the honest cost of having no daemon to outlive it.

import crypto from "node:crypto";
import type { AgentBackendId } from "../../shared/agent-backend.js";
import { agentIdForOperation } from "../../shared/agent-record.js";
import type { LocalBackendSession, LocalTerminal, LocalTurnHandle } from "./localAgentSession.js";

////////////////////////////////
//  Interfaces & Types

export type LocalAgentState = "idle" | "working" | "unavailable";
export type LocalTurnState = "inProgress" | "completed" | "failed" | "interrupted";
export type LocalObservation = "terminal" | "waitTimedOut" | "idle" | "interruptRequested" | "unavailable";

/** The error codes the runtime itself raises. Every one is spelled the same in both backends' error
 * enums, so a shared answer never needs translating. */
export type LocalErrorCode = "not_found" | "app_server_unavailable" | "turn_failed";

/**
 * A refused REQUEST, which is not the same as an unwell AGENT.
 *
 * The result envelope only permits an error when the agent is genuinely unavailable, so a refusal
 * about the timing of THIS call cannot be expressed there: both backends' schemas reject it outright.
 * The gateway routes these to the request-error shape and so does the local host.
 */
export interface LocalRefusal {
	refused: string;
}

export interface LocalError {
	code: string;
	message: string;
	retryable: boolean;
}

/** The neutral answer, handed to a backend's own schema to be validated into its result type. Field
 * names match both result schemas, which is what lets one builder serve both. */
export interface LocalAgentAnswer {
	agentId: string;
	agentState: LocalAgentState;
	observation: LocalObservation;
	turn?: { id: string; state: LocalTurnState };
	delivery?: string;
	activities: Array<{ kind: "commentary"; text: string } | { kind: "truncated"; omitted: number }>;
	finalResponse?: string;
	error?: LocalError;
}

export interface LocalRequest {
	kind: "start" | "message" | "await" | "stop" | "list";
	agentId?: string;
	prompt?: string;
	model?: string;
	cwd?: string;
}

/** How the runtime reaches one backend. The session is opened lazily, so a process with the CLI
 * installed but never used never spawns a child. */
export interface LocalBackendSpec {
	backendId: AgentBackendId;
	/** Fresh session, or a reason it could not be opened. Called once and memoized; a failure is not
	 * cached, so installing a login and retrying works without restarting the session. */
	openSession(): Promise<LocalBackendSession>;
	defaultCwd(): string;
	waitBudgetMs: number;
	/** Why a follow-up to a working agent is refused on a backend with no steer. Absent means the
	 * backend steers instead, which the runtime detects from the session itself. */
	busyMessage?: string;
	/** Delivery word for a follow-up that opened a NEW turn. Codex and Copilot disagree on the term. */
	followupDelivery: string;
	/** Cap on retained commentary per turn, and the item count its truncation marker must leave. */
	maxActivities: number;
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

interface LocalExchangeRecord {
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
	turns: LocalTurnRecord[];
	exchanges: LocalExchangeRecord[];
	settled?: Promise<LocalTerminal>;
}

/** One agent's history, in the shape both list schemas declare. */
export interface LocalListAgent {
	agentId: string;
	agentState: LocalAgentState;
	activeTurnId?: string;
	exchanges: Array<Omit<LocalExchangeRecord, never>>;
	turns: Array<{
		id: string;
		state: LocalTurnState;
		activities: LocalAgentAnswer["activities"];
		finalResponse?: string;
		error?: string;
		updatedAt: number;
	}>;
	createdAt: number;
	updatedAt: number;
}

////////////////////////////////
//  Functions & Helpers

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.trim() || "agent command failed";
}

////////////////////////////////
//  Class

export class LocalAgentRuntime {
	private readonly agents = new Map<string, LocalAgentRecord>();
	private session?: LocalBackendSession;
	private opening?: Promise<LocalBackendSession>;

	constructor(
		private readonly spec: LocalBackendSpec,
		private readonly now: () => number = () => Date.now(),
	) {}

	async handle(request: LocalRequest): Promise<LocalAgentAnswer | LocalRefusal> {
		switch (request.kind) {
			case "start":
				return this.start(request);
			case "message":
				return this.message(request);
			case "await":
				return this.awaitTurn(request);
			case "stop":
				return this.stop(request);
			default:
				return { refused: `unsupported request: ${request.kind}` };
		}
	}

	/** Every agent this process owns, newest activity last. Ordering is insertion order, which is
	 * start order, since nothing here is reordered by later work. */
	list(): LocalListAgent[] {
		return [...this.agents.values()].map((agent) => ({
			agentId: agent.agentId,
			agentState: this.stateOf(agent),
			...(agent.activeTurnId ? { activeTurnId: agent.activeTurnId } : {}),
			exchanges: agent.exchanges.map((exchange) => ({ ...exchange })),
			turns: agent.turns.map((turn) => ({
				id: turn.id,
				state: turn.state,
				activities: this.activitiesOf(turn),
				...(turn.state === "completed" ? { finalResponse: turn.finalResponse ?? "" } : {}),
				...(turn.state === "failed" ? { error: turn.error ?? "turn failed" } : {}),
				updatedAt: turn.updatedAt,
			})),
			createdAt: agent.createdAt,
			updatedAt: agent.updatedAt,
		}));
	}

	/** Reap the child, so it does not outlive the session that started it. */
	shutdown(): void {
		this.session?.close();
		this.session = undefined;
		this.opening = undefined;
	}

	private async start(request: LocalRequest): Promise<LocalAgentAnswer> {
		// The id is derived rather than random so a local agent id is spelled like a coordinated one,
		// and two runs of the same operation cannot mint two agents.
		const operationId = crypto.randomUUID();
		const agentId = agentIdForOperation(this.spec.backendId, operationId);
		const prompt = request.prompt ?? "";

		let session: LocalBackendSession;
		try {
			session = await this.open();
		} catch (error) {
			return this.fail(agentId, "app_server_unavailable", errorText(error), true);
		}

		const createdAt = this.now();
		let threadId: string;
		try {
			threadId = await session.openThread({ cwd: request.cwd ?? this.spec.defaultCwd(), model: request.model });
		} catch (error) {
			// Nothing was recorded, so the agent simply does not exist. Reporting it as unavailable
			// rather than inventing a record keeps `list` honest about what this process is running.
			return this.fail(agentId, "app_server_unavailable", errorText(error), true);
		}

		const agent: LocalAgentRecord = {
			agentId,
			threadId,
			createdAt,
			updatedAt: createdAt,
			turns: [],
			exchanges: [],
		};
		this.agents.set(agentId, agent);
		return this.dispatchTurn(session, agent, prompt, "start");
	}

	private async message(request: LocalRequest): Promise<LocalAgentAnswer | LocalRefusal> {
		const agent = this.agents.get(request.agentId ?? "");
		if (!agent) return this.notFound(request.agentId ?? "");
		const prompt = request.prompt ?? "";

		let session: LocalBackendSession;
		try {
			session = await this.open();
		} catch (error) {
			return this.fail(agent.agentId, "app_server_unavailable", errorText(error), true);
		}

		const active = this.activeTurn(agent);
		if (active) {
			// A backend with no steer cannot take this at all. Refusing the REQUEST is what keeps the
			// running turn untouched instead of racing a second one against it.
			if (!session.steerTurn) return { refused: this.spec.busyMessage ?? "agent is still working" };
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
			return this.waitFor(agent, active.id, "steered");
		}

		return this.dispatchTurn(session, agent, prompt, "message");
	}

	private async awaitTurn(request: LocalRequest): Promise<LocalAgentAnswer> {
		const agent = this.agents.get(request.agentId ?? "");
		if (!agent) return this.notFound(request.agentId ?? "");
		const active = this.activeTurn(agent);
		// Nothing running is not an error: the caller asked for the outcome and the outcome is already
		// in hand, which is exactly what the settled record holds.
		if (!active) return this.settledAnswer(agent);
		return this.waitFor(agent, active.id);
	}

	private async stop(request: LocalRequest): Promise<LocalAgentAnswer> {
		const agent = this.agents.get(request.agentId ?? "");
		if (!agent) return this.notFound(request.agentId ?? "");
		const active = this.activeTurn(agent);
		if (!active) return this.idleAnswer(agent);

		let session: LocalBackendSession;
		try {
			session = await this.open();
		} catch (error) {
			return this.fail(agent.agentId, "app_server_unavailable", errorText(error), true);
		}
		try {
			await session.interruptTurn(agent.threadId, active.id);
		} catch (error) {
			return this.fail(agent.agentId, "app_server_unavailable", errorText(error), true);
		}
		// Requested, not ended. The turn's own terminal still decides how it finished, which may be a
		// completion that won the race against the interrupt.
		return {
			agentId: agent.agentId,
			agentState: "working",
			observation: "interruptRequested",
			turn: { id: active.id, state: "inProgress" },
			activities: this.activitiesOf(active),
		};
	}

	/** Open a turn and wait on it, recording the exchange that started it. */
	private async dispatchTurn(
		session: LocalBackendSession,
		agent: LocalAgentRecord,
		prompt: string,
		kind: "start" | "message",
	): Promise<LocalAgentAnswer> {
		let handle: LocalTurnHandle;
		try {
			handle = await session.startTurn(agent.threadId, prompt);
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
		agent.settled = handle.settled;
		agent.exchanges.push({
			kind,
			prompt,
			status: "accepted",
			// A start always starts its own turn; the schema refuses any other word there.
			delivery: kind === "start" ? "started" : this.spec.followupDelivery,
			turnId: turn.id,
			createdAt: at,
			acceptedAt: at,
		});
		// Registered before the race, so a terminal that beats the budget is already recorded by the
		// time the wait resumes. `applyTerminal` is idempotent for the case where it does not.
		void handle.settled.then((terminal) => this.applyTerminal(agent, turn.id, terminal));

		return this.waitFor(agent, turn.id, kind === "start" ? "started" : this.spec.followupDelivery);
	}

	/** Race one turn against the wait budget. A turn that outlives it keeps running, and the caller
	 * collects it later with an await. */
	private async waitFor(agent: LocalAgentRecord, turnId: string, delivery?: string): Promise<LocalAgentAnswer> {
		const settled = agent.settled;
		if (settled) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const budget = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), this.spec.waitBudgetMs);
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
	 * Idempotent because two paths reach it: the listener registered at dispatch, and the racing
	 * caller that saw the same promise settle. Whichever runs second must not re-stamp a turn whose
	 * outcome is already written, or an await would report a fresher timestamp than the terminal it
	 * describes.
	 */
	private applyTerminal(agent: LocalAgentRecord, turnId: string, terminal: LocalTerminal): void {
		const turn = agent.turns.find((candidate) => candidate.id === turnId);
		if (turn?.state !== "inProgress") return;
		turn.state = terminal.status;
		if (terminal.status === "completed") turn.finalResponse = terminal.finalResponse ?? "";
		if (terminal.status === "failed") turn.error = terminal.error || "turn failed";
		turn.updatedAt = this.now();
		if (agent.activeTurnId === turnId) {
			agent.activeTurnId = undefined;
			agent.settled = undefined;
		}
		agent.updatedAt = Math.max(agent.updatedAt, turn.updatedAt);
	}

	/** Narration for one turn, capped. The marker sits at the end and the retained window is exactly
	 * full, which is what the shared activity invariant requires of any producer. */
	private activitiesOf(turn: LocalTurnRecord): LocalAgentAnswer["activities"] {
		const kept = turn.commentary.map((text) => ({ kind: "commentary" as const, text }));
		if (turn.omitted === 0) return kept;
		return [...kept, { kind: "truncated" as const, omitted: turn.omitted }];
	}

	private recordActivity(turnId: string, text: string): void {
		if (!text) return;
		for (const agent of this.agents.values()) {
			const turn = agent.turns.find((candidate) => candidate.id === turnId);
			if (turn?.state !== "inProgress") continue;
			turn.commentary.push(text);
			// The newest window is kept: what an agent is doing now explains a running turn better than
			// how it opened. Dropping from the front is what makes `omitted` a count of lost history.
			while (turn.commentary.length > this.spec.maxActivities) {
				turn.commentary.shift();
				turn.omitted += 1;
			}
			turn.updatedAt = this.now();
			agent.updatedAt = Math.max(agent.updatedAt, turn.updatedAt);
			return;
		}
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
				error: { code: "turn_failed", message: turn.error || "turn failed", retryable: false },
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
		return this.fail(agentId, "not_found", "agent is not known to this session", false);
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

	/** Stamp the agent as touched and return the instant, so every child record written in the same
	 * step carries a timestamp inside the agent's own lifetime. */
	private touch(agent: LocalAgentRecord): number {
		const at = this.now();
		agent.updatedAt = Math.max(agent.updatedAt, at);
		return agent.updatedAt;
	}

	private open(): Promise<LocalBackendSession> {
		if (this.session) return Promise.resolve(this.session);
		// Shared across concurrent callers: two opens would give one child two readers of its stdout
		// and two request id spaces able to settle each other's calls.
		this.opening ??= this.spec
			.openSession()
			.then((session) => {
				this.session = session;
				session.onActivity((turnId, text) => this.recordActivity(turnId, text));
				// A dead child must not stay cached, or every later call is dispatched into a closed pipe
				// and the target manager is never asked for a replacement. Guarded on identity so a late
				// close from a replaced session cannot evict its successor.
				session.onClosed(() => {
					if (this.session === session) this.session = undefined;
				});
				return session;
			})
			.finally(() => {
				this.opening = undefined;
			});
		return this.opening;
	}
}
