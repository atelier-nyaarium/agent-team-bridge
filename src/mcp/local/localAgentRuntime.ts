// The daemonless half of agent delegation, answering the same five tool calls in the same shapes.
//
// What it lacks is what a wire needs: no relay so nothing is fenced, no restart so nothing is
// durable, no HTTP so nothing needs replay identity. An agent dies with the process.

import crypto from "node:crypto";
import type { AgentBackendId } from "../../shared/agent-backend.js";
import {
	AGENT_ERROR_MAX_BYTES,
	agentIdForOperation,
	agentOperationFingerprintOf,
	sanitizeAgentErrorText,
} from "../../shared/agent-record.js";
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
	/**
	 * The caller's own operation identity, honoured rather than discarded.
	 *
	 * It was accepted, validated against the same schema the gateway route uses, and then thrown away
	 * while a fresh one was minted - a field that survives validation and means nothing reads as
	 * honoured, and the next caller to depend on operation identity would have believed both paths
	 * supported it. It is what a start's agent id derives from, so an id is not merely SPELLED like a
	 * coordinated one but IS one, and it is what makes reuse detectable.
	 */
	operationId?: string;
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
	/**
	 * Whether presenting a known operation identity again returns that operation's original answer.
	 *
	 * Always false here, and declared rather than left as an absence. A gateway records each settled
	 * reply and replays it, because an HTTP retry can re-present an identity behind the caller's back.
	 * This backend is called in-process with the very body the tool would have posted, so no transport
	 * can retry unseen, and its agents die with the MCP - it has nothing to replay FROM. The identity
	 * is still honoured: it names the agent, and a reuse is refused rather than silently starting a
	 * second operation under an id that already means something.
	 */
	replaysOperations: false;
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

/**
 * One agent's history, in the shape CODEX's list schema declares.
 *
 * This said "the shape both list schemas declare" and that was never true: Copilot publishes
 * `operations`, bare turns and no timestamps, so handing this record to its schema threw on every
 * non-empty list. The host projects per backend now; this type stays Codex-shaped because the
 * runtime records what Codex needs and Copilot's row is a strict subset of it.
 */
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

export class LocalAgentRuntime {
	private readonly agents = new Map<string, LocalAgentRecord>();
	/**
	 * Every operation identity this process has already acted on, against the input it named.
	 *
	 * Process-local and gone with the MCP, which is exactly why local mode REFUSES a reuse rather than
	 * replaying one: it holds no durable ledger and its agents die with it, so it cannot answer for an
	 * operation the way a gateway can. Refusing is the honest half of honouring the field.
	 *
	 * It is also what stops the obvious version of this change from being a bug. Deriving an agent id
	 * from a caller-supplied operation id without this makes a reused id overwrite the first agent in
	 * `agents`: its thread stays open, its activity stops being recorded, no later call can address
	 * it, and the idle reaper walks only this map so an orphaned ACTIVE turn becomes invisible to the
	 * one guard meant to protect it.
	 */
	private readonly operations = new Map<string, string>();
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
			// Claimed BEFORE dispatch, so every mutating kind inherits it and a new one cannot be added
			// that quietly does not - and so two concurrent calls naming one identity cannot both pass.
			// `await` and `list` read, so they claim nothing.
			const claim = this.claimOperation(request);
			if (claim) return claim;
			const answer = await this.dispatch(request);
			// An identity is spent by an operation that HAPPENED. A child that could not be opened or a
			// thread that could not be started leaves nothing behind and reports itself retryable, so
			// holding the claim would answer the retry with "already used" and strand the caller on an
			// id it was invited to reuse. The gateway does not have this problem because it returns
			// before persisting anything; releasing here is what makes the two agree.
			if (this.unstarted(answer)) this.releaseOperation(request);
			return answer;
		} finally {
			this.inFlight -= 1;
			this.markUsed();
		}
	}

	private async dispatch(request: LocalRequest): Promise<LocalAgentAnswer | LocalRefusal> {
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
	}

	/** Nothing was recorded and the caller was told to try again. `fail(..., retryable)` is the sole
	 * producer of this shape, so it is one question rather than a list of error codes to keep in step
	 * with. A refusal never claimed anything, and a settled or failed TURN did happen. */
	private unstarted(answer: LocalAgentAnswer | LocalRefusal): boolean {
		return "refused" in answer ? false : answer.observation === "unavailable" && answer.error?.retryable === true;
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
				...(turn.state === "failed" ? { error: turn.error ?? `turn failed` } : {}),
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

	/**
	 * Take the caller's operation identity, or refuse a reuse of one.
	 *
	 * Both refusals carry the gateway's own wording for the same conditions, so a caller reading an
	 * answer cannot tell which backend served it apart from the one thing that genuinely differs: the
	 * gateway REPLAYS a matching reuse and this cannot, having no ledger that survives the process.
	 * That difference is declared on `LocalBackendSpec.replaysOperations`.
	 */
	private claimOperation(request: LocalRequest): LocalRefusal | undefined {
		if (request.kind === "await" || request.kind === "list") return undefined;
		const operationId = request.operationId;
		if (!operationId) return undefined;
		// The input this identity named, so a reuse with different input is separable from a plain
		// retry. Same encoding the gateway fingerprints with, so the two cannot drift apart on what
		// "different input" means.
		const fingerprint = agentOperationFingerprintOf({
			kind: request.kind,
			agentId: request.agentId ?? agentIdForOperation(this.spec.backendId, operationId),
			prompt: request.prompt,
			...(request.kind === "start" && request.model !== undefined ? { model: request.model } : {}),
		});
		const held = this.operations.get(operationId);
		if (held === undefined) {
			this.operations.set(operationId, fingerprint);
			return undefined;
		}
		if (held !== fingerprint) return { refused: `operation ID was reused with different input` };
		return {
			refused: `operation ID was already used; this session runs its agents itself and keeps no record to replay from`,
		};
	}

	/** Give an identity back, for an operation that never reached the child. Paired with the claim in
	 * `handle`, which is the only place either happens. */
	private releaseOperation(request: LocalRequest): void {
		if (request.operationId) this.operations.delete(request.operationId);
	}

	private async start(request: LocalRequest): Promise<LocalAgentAnswer> {
		// The CALLER's identity when it supplied one, so an id is not merely spelled like a coordinated
		// one but is the same one. Minted only when nobody named it.
		const operationId = request.operationId ?? crypto.randomUUID();
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
			if (!session.steerTurn) return { refused: this.spec.busyMessage ?? `agent is still working` };
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
		// `LocalTurnHandle` promises this never rejects. Held to it here, so a backend that breaks the
		// promise loses one turn rather than raising an unhandled rejection.
		const settled = handle.settled.catch((error): LocalTerminal => ({ status: "failed", error: errorText(error) }));
		agent.settled = settled;
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
		void settled.then((terminal) => this.applyTerminal(agent, turn.id, terminal));

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
		// The child wrote this, so it is normalized before it is stored rather than at each reader:
		// it leaves here for `error.message`, which both backends bound and refuse unnormalized.
		if (terminal.status === "failed") turn.error = errorText(terminal.error || `turn failed`);
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
