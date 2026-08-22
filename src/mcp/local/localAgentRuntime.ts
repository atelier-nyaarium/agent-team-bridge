// The daemonless half of agent delegation, answering the same five tool calls in the same shapes.
//
// What it lacks is what a wire needs: no relay so nothing is fenced, no restart so nothing is
// durable, no HTTP so nothing needs replay identity. An agent dies with the process.

import crypto from "node:crypto";
import type { AgentBackendId } from "../../shared/agent-backend.js";
import { agentIdForOperation } from "../../shared/agent-record.js";
import type { LocalBackendSession, LocalTerminal, LocalTurnHandle } from "./localAgentSession.js";

////////////////////////////////
//  Interfaces & Types

export type LocalAgentState = "idle" | "working" | "unavailable";
export type LocalTurnState = "inProgress" | "completed" | "failed" | "interrupted";
export type LocalObservation = "terminal" | "waitTimedOut" | "idle" | "interruptRequested" | "unavailable";

/** Spelled the same in both backends' error enums, so an answer never needs translating. */
export type LocalErrorCode = "not_found" | "app_server_unavailable" | "turn_failed";

/**
 * A refused REQUEST, which is not an unwell AGENT.
 *
 * The result envelope only permits an error when the agent is genuinely unavailable, so both
 * schemas reject a timing refusal there. Both paths route these to the request-error shape.
 */
export interface LocalRefusal {
	refused: string;
}

export interface LocalError {
	code: string;
	message: string;
	retryable: boolean;
}

/** Field names match both result schemas, which is what lets one builder serve both. */
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

/** Opened lazily, so an unused CLI never spawns a child. */
export interface LocalBackendSpec {
	backendId: AgentBackendId;
	/** Memoized, but a failure is not cached, so a login and retry works without a restart. */
	openSession(): Promise<LocalBackendSession>;
	defaultCwd(): string;
	waitBudgetMs: number;
	/** Absent means the backend steers instead, detected from the session itself. */
	busyMessage?: string;
	/** Codex and Copilot disagree on the term. */
	followupDelivery: string;
	maxActivities: number;
	/**
	 * Whether a thread outlives the child that made it, so a replacement can adopt it.
	 *
	 * This is what makes reaping an idle child safe, and it is a FACT about the backend rather than
	 * a policy: a codex thread is durable and gets resumed, while an ACP session lives inside the
	 * process and dies with it. Only a resumable backend is reaped, since for the other one the
	 * reap would silently destroy agents the caller may still message.
	 */
	threadsResumable: boolean;
}

/**
 * How long a local child may sit with nothing running before it is reaped.
 *
 * The child is otherwise released only when the MCP's stdin closes, so an agent that used it once
 * and then idled held ~155MB for the rest of a long session - measured, and the reason this exists.
 * Generous, because re-opening costs a process launch and a thread resume: this reclaims the memory
 * of agents nobody came back to, and is not meant to fire between turns of a working one.
 */
export const LOCAL_IDLE_REAP_MS = 10 * 60_000;

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
	/** When the child last had work. Distinct from any agent's updatedAt: a reap is about the CHILD. */
	private lastUsedAt = 0;
	/** Child operations currently issued and unanswered. An active turn is NOT the same fact: a call
	 * is in flight before any turn record exists (openThread, and startTurn until it resolves), and a
	 * steer or interrupt is in flight while owning no turn of its own. Reaping on the turn marker
	 * alone would close the transport under exactly those calls. */
	private inFlight = 0;
	private idleTimer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly spec: LocalBackendSpec,
		private readonly now: () => number = () => Date.now(),
	) {}

	/**
	 * Release the child if nothing has used it for [LOCAL_IDLE_REAP_MS] and no turn is in flight.
	 *
	 * Returns whether it reaped, so a test can drive this without a clock. Refuses on a backend whose
	 * threads do not survive (see the spec field), and refuses while ANY agent has an active turn -
	 * closing settles every pending turn as failed, which would turn working agents into errors to
	 * reclaim memory, the exact trade this must never make.
	 */
	reapIfIdle(): boolean {
		if (!this.session || !this.spec.threadsResumable) return false;
		if (this.inFlight > 0) return false;
		if (this.now() - this.lastUsedAt < LOCAL_IDLE_REAP_MS) return false;
		for (const agent of this.agents.values()) {
			if (agent.activeTurnId) return false;
		}
		// The session's own onClosed clears this.session; clearing here too keeps the reap correct
		// even for a backend whose close does not fire it.
		this.session.close();
		this.session = undefined;
		this.opening = undefined;
		return true;
	}

	async handle(request: LocalRequest): Promise<LocalAgentAnswer | LocalRefusal> {
		// The lease spans the WHOLE request, not each child call: a per-call lease leaves a gap
		// between startTurn resolving and its turn record being written, and the reaper can fire in
		// exactly that gap. Held here so the invariant is one line and a new request kind inherits
		// it - at every instant either this lease is held or an activeTurnId guards the child.
		this.inFlight += 1;
		try {
			switch (request.kind) {
				case "start":
					return await this.start(request);
				case "message":
					return await this.message(request);
				case "await":
					return await this.awaitTurn(request);
				case "stop":
					return await this.stop(request);
				default:
					return { refused: `unsupported request: ${request.kind}` };
			}
		} finally {
			this.inFlight -= 1;
			this.markUsed();
		}
	}

	/** Insertion order, which is start order: nothing here is reordered by later work. */
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
		if (this.idleTimer) clearInterval(this.idleTimer);
		this.idleTimer = undefined;
		this.session?.close();
		this.session = undefined;
		this.opening = undefined;
	}

	private async start(request: LocalRequest): Promise<LocalAgentAnswer> {
		// Derived, so a local id is spelled like a coordinated one.
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
			// Nothing was recorded, so no record is invented and `list` stays honest.
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
			// Refusing the REQUEST keeps the running turn untouched, instead of racing a second one.
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
		// Nothing running is not an error: the outcome is already in hand.
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
		// Requested, not ended: the turn's own terminal still decides how it finished.
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
			// The schema refuses any other word for a start.
			delivery: kind === "start" ? "started" : this.spec.followupDelivery,
			turnId: turn.id,
			createdAt: at,
			acceptedAt: at,
		});
		// Registered before the race, so a terminal beating the budget is recorded. applyTerminal is
		// idempotent for the case where it does not.
		void handle.settled.then((terminal) => this.applyTerminal(agent, turn.id, terminal));

		return this.waitFor(agent, turn.id, kind === "start" ? "started" : this.spec.followupDelivery);
	}

	/** A turn outliving the budget keeps running; the caller collects it with an await. */
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
	 * Two paths reach it: the dispatch listener and the racing caller. Whichever runs second must not
	 * re-stamp, or an await reports a fresher timestamp than the terminal it describes.
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
		// A terminal arrives on the event stream, not from a call, so it reaches no lease. Without
		// this the idle clock still reads the turn's START: a thirty-minute turn would be reapable
		// the instant it finished, instead of ten minutes after the child actually went quiet.
		this.markUsed(turn.updatedAt);
	}

	/** The marker sits at the end and the window is exactly full, per the shared invariant. */
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
			// The newest window is kept: what it is doing now explains a running turn best.
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

	/** Returns the instant, so every child record written in one step shares a timestamp. */
	private touch(agent: LocalAgentRecord): number {
		const at = this.now();
		agent.updatedAt = Math.max(agent.updatedAt, at);
		this.markUsed(at);
		return agent.updatedAt;
	}

	/** The child's idle clock. Every child operation ends here, so "idle" means the CHILD went quiet
	 * rather than that some record happened not to be written. */
	private markUsed(at: number = this.now()): void {
		this.lastUsedAt = Math.max(this.lastUsedAt, at);
	}

	private open(): Promise<LocalBackendSession> {
		if (this.session) return Promise.resolve(this.session);
		this.startIdleReaper();
		// Shared: two opens would give one child two stdout readers and two colliding id spaces.
		this.opening ??= this.spec
			.openSession()
			.then((session) => {
				this.session = session;
				session.onActivity((turnId, text) => this.recordActivity(turnId, text));
				// A cached dead child sends every later call into a closed pipe. Identity-guarded, so a
				// late close cannot evict its successor.
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

	/** One timer for the runtime's life. unref'd, so an idle child never holds the process open. */
	private startIdleReaper(): void {
		if (this.idleTimer || !this.spec.threadsResumable) return;
		this.idleTimer = setInterval(() => this.reapIfIdle(), LOCAL_IDLE_REAP_MS / 2);
		this.idleTimer.unref?.();
	}
}
