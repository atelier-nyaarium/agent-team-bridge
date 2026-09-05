// The daemonless half of agent delegation, answering the same five tool calls in the same shapes.
//
// What it lacks is what a wire needs: no relay so nothing is fenced, no restart so nothing is
// durable, no HTTP so nothing needs replay identity. An agent dies with the process.

import type { AgentBackendId } from "../../shared/agent-backend.js";
import type { CodexServiceTier } from "../../shared/codex-agent.js";
import type { LocalExchangeRecord } from "./localAgentHandlers.js";
import { LocalAgentHandlers } from "./localAgentHandlers.js";
import type { LocalBackendSession } from "./localAgentSession.js";
import { LocalChildSession } from "./localChildSession.js";
import { LocalOperationLedger } from "./localOperationLedger.js";

export { LOCAL_IDLE_REAP_MS } from "./localChildSession.js";

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
	/** Ignored by a backend with no service tiers. */
	serviceTier?: CodexServiceTier;
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
	model?: string;
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
//  Class

export class LocalAgentRuntime {
	private readonly ledger: LocalOperationLedger;
	private readonly child: LocalChildSession;
	private readonly handlers: LocalAgentHandlers;
	/** Child operations currently issued and unanswered. An active turn is NOT the same fact: a call
	 * is in flight before any turn record exists (openThread, and startTurn until it resolves), and a
	 * steer or interrupt is in flight while owning no turn of its own. Reaping on the turn marker
	 * alone would close the transport under exactly those calls. */
	private inFlight = 0;

	constructor(
		private readonly spec: LocalBackendSpec,
		private readonly now: () => number = () => Date.now(),
	) {
		this.ledger = new LocalOperationLedger(spec.backendId);
		this.handlers = new LocalAgentHandlers({
			spec: this.spec,
			now: this.now,
			open: () => this.child.open(),
			markUsed: (at) => this.child.markUsed(at),
		});
		this.child = new LocalChildSession({
			spec: this.spec,
			now: this.now,
			inFlight: () => this.inFlight,
			hasActiveTurn: () => this.handlers.hasActiveTurn(),
			onActivity: (turnId, text) => this.handlers.recordActivity(turnId, text),
		});
	}

	/**
	 * Release the child if nothing has used it for [LOCAL_IDLE_REAP_MS] and no turn is in flight.
	 *
	 * Returns whether it reaped, so a test can drive this without a clock. Refuses on a backend whose
	 * threads do not survive (see the spec field), and refuses while ANY agent has an active turn -
	 * closing settles every pending turn as failed, which would turn working agents into errors to
	 * reclaim memory, the exact trade this must never make.
	 */
	reapIfIdle(): boolean {
		return this.child.reapIfIdle();
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
			const claim = this.ledger.claim(request);
			if (claim) return claim;
			const answer = await this.dispatch(request);
			// An identity is spent by an operation that HAPPENED. A child that could not be opened or a
			// thread that could not be started leaves nothing behind and reports itself retryable, so
			// holding the claim would answer the retry with "already used" and strand the caller on an
			// id it was invited to reuse. The gateway does not have this problem because it returns
			// before persisting anything; releasing here is what makes the two agree.
			if (this.unstarted(answer)) this.ledger.release(request);
			return answer;
		} finally {
			this.inFlight -= 1;
			this.child.markUsed();
		}
	}

	private async dispatch(request: LocalRequest): Promise<LocalAgentAnswer | LocalRefusal> {
		switch (request.kind) {
			case "start":
				return await this.handlers.start(request);
			case "message":
				return await this.handlers.message(request);
			case "await":
				return await this.handlers.awaitTurn(request);
			case "stop":
				return await this.handlers.stop(request);
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
		return this.handlers.list();
	}

	/** Reap the child, so it does not outlive the session that started it. */
	shutdown(): void {
		this.child.shutdown();
	}
}
