import type { AgentBackendId } from "../../shared/agent-backend.js";
import type { CodexServiceTier } from "../../shared/codex-agent.js";
import type { LocalExchangeRecord } from "./localAgentHandlers.js";
import { LocalAgentHandlers } from "./localAgentHandlers.js";
import type { LocalBackendSession } from "./localAgentSession.js";
import { LocalChildSession } from "./localChildSession.js";
import { LocalOperationLedger } from "./localOperationLedger.js";

export { LOCAL_IDLE_REAP_MS } from "./localChildSession.js";

export type LocalAgentState = "idle" | "working" | "unavailable";
export type LocalTurnState = "inProgress" | "completed" | "failed" | "interrupted";
export type LocalObservation = "terminal" | "waitTimedOut" | "idle" | "interruptRequested" | "unavailable";

export type LocalErrorCode = "not_found" | "app_server_unavailable" | "turn_failed";

export interface LocalRefusal {
	refused: string;
}

export interface LocalError {
	code: string;
	message: string;
	retryable: boolean;
}

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
	operationId?: string;
	agentId?: string;
	prompt?: string;
	model?: string;
	cwd?: string;
	serviceTier?: CodexServiceTier;
}

export interface LocalBackendSpec {
	backendId: AgentBackendId;
	openSession(): Promise<LocalBackendSession>;
	defaultCwd(): string;
	waitBudgetMs: number;
	busyMessage?: string;
	followupDelivery: string;
	maxActivities: number;
	// Reap only backends whose threads survive child replacement.
	threadsResumable: boolean;
	// In-process operations refuse reuse instead of replaying answers.
	replaysOperations: false;
}

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

export class LocalAgentRuntime {
	private readonly ledger: LocalOperationLedger;
	private readonly child: LocalChildSession;
	private readonly handlers: LocalAgentHandlers;
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

	reapIfIdle(): boolean {
		return this.child.reapIfIdle();
	}

	async handle(request: LocalRequest): Promise<LocalAgentAnswer | LocalRefusal> {
		// Hold the lease across the whole request, including child calls.
		this.inFlight += 1;
		try {
			// Claim before dispatch so concurrent retries cannot both pass.
			const claim = this.ledger.claim(request);
			if (claim) return claim;
			const answer = await this.dispatch(request);
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

	private unstarted(answer: LocalAgentAnswer | LocalRefusal): boolean {
		return "refused" in answer ? false : answer.observation === "unavailable" && answer.error?.retryable === true;
	}

	list(): LocalListAgent[] {
		return this.handlers.list();
	}

	shutdown(): void {
		this.child.shutdown();
	}
}
