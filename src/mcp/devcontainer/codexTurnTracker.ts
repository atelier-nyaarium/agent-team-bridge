import {
	CODEX_ACTIVITY_MAX_BYTES,
	CODEX_ACTIVITY_MAX_ITEMS,
	CodexAppServerAgentMessageCompletedSchema,
	CodexAppServerTurnCompletedSchema,
	classifyCodexItemPhase,
	sanitizeCodexErrorText,
} from "../../shared/codex-agent.js";

////////////////////////////////
//  Interfaces & Types

export interface TrackedActivity {
	kind: "commentary";
	itemId: string;
	text: string;
}

export interface TurnOutcome {
	threadId: string;
	turnId: string;
	status: "completed" | "failed" | "interrupted";
	/** Only for a completed turn that produced one. */
	finalResponse?: string;
	error?: string;
	activities: TrackedActivity[];
	truncated: boolean;
}

////////////////////////////////
//  Functions & Helpers

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

////////////////////////////////
//  Class

/**
 * What a turn produced, not its lifecycle: parking is `ThreadLifecycle` and liveness is
 * `CodexLiveTurns`. Deltas are ignored, so nothing partial reaches storage.
 *
 * A terminal arriving before its own final item is held until that item lands or the caller gives
 * up. That hold is the only reason this needs state.
 */
interface TrackedTurn {
	threadId: string;
	activities: TrackedActivity[];
	activityBytes: number;
	truncated: boolean;
	lastCandidate?: string;
	lastFinalAnswer?: string;
	pendingTerminal?: { status: "completed" | "failed" | "interrupted"; error?: string };
}

/** The one place an answer is chosen, so the hold and the outcome cannot disagree. */
function answerOf(entry: TrackedTurn): string | undefined {
	return entry.lastFinalAnswer ?? entry.lastCandidate;
}

// A late duplicate only arrives near its own turn.
const SETTLED_MEMORY = 256;

export class CodexTurnTracker {
	private readonly turns = new Map<string, TrackedTurn>();
	private readonly settled = new Set<string>();

	/** Fires from the same classification the stored copy is built from. */
	constructor(
		private readonly onCommentary: (item: {
			threadId: string;
			turnId: string;
			itemId: string;
			text: string;
		}) => void = () => {},
	) {}

	/** Feed one server event. Returns an outcome only when a turn is genuinely settled. */
	accept(message: unknown): TurnOutcome | null {
		const item = CodexAppServerAgentMessageCompletedSchema.safeParse(message);
		if (item.success) return this.onItemCompleted(item.data.params);

		const terminal = CodexAppServerTurnCompletedSchema.safeParse(message);
		if (terminal.success) return this.onTurnCompleted(terminal.data.params);

		return null;
	}

	/** True only while a terminal waits here for its final item. */
	holding(threadId: string, turnId: string): boolean {
		const entry = this.turns.get(turnId);
		return entry?.threadId === threadId && entry.pendingTerminal !== undefined;
	}

	/** Settle a turn whose terminal arrived but whose final item never did. Reports only what is
	 * held, so a turn with no answer settles without one. */
	settlePending(threadId: string, turnId: string): TurnOutcome | null {
		const entry = this.turns.get(turnId);
		if (!entry || entry.threadId !== threadId || !entry.pendingTerminal) return null;
		return this.finish(turnId, entry.pendingTerminal);
	}

	forget(turnId: string): void {
		this.turns.delete(turnId);
		this.remember(turnId);
	}

	private remember(turnId: string): void {
		this.settled.add(turnId);
		if (this.settled.size > SETTLED_MEMORY) {
			const oldest = this.settled.values().next().value;
			if (oldest !== undefined) this.settled.delete(oldest);
		}
	}

	private entryFor(threadId: string, turnId: string): TrackedTurn {
		const existing = this.turns.get(turnId);
		if (existing) return existing;
		const created: TrackedTurn = { threadId, activities: [], activityBytes: 0, truncated: false };
		this.turns.set(turnId, created);
		return created;
	}

	private onItemCompleted(params: {
		threadId: string;
		turnId: string;
		item: { id: string; text: string; phase?: unknown };
	}) {
		if (this.settled.has(params.turnId)) return null;
		const entry = this.entryFor(params.threadId, params.turnId);
		// Keeps an answer from crossing threads.
		if (entry.threadId !== params.threadId) return null;

		// Commentary is retained but never answers for the turn.
		switch (classifyCodexItemPhase(params.item.phase)) {
			case "answer":
				entry.lastFinalAnswer = params.item.text;
				break;
			case "commentary":
				this.retainActivity(entry, params, params.item.id, params.item.text);
				break;
			default:
				entry.lastCandidate = params.item.text;
		}

		// Commentary must not release the hold.
		if (entry.pendingTerminal && answerOf(entry) !== undefined) {
			return this.finish(params.turnId, entry.pendingTerminal);
		}
		return null;
	}

	private onTurnCompleted(params: {
		threadId: string;
		turn: { id: string; status: "completed" | "failed" | "interrupted"; error?: { message?: string } | null };
	}) {
		// A redelivered terminal would answer again from a blank entry.
		if (this.settled.has(params.turn.id)) return null;
		const entry = this.entryFor(params.threadId, params.turn.id);
		if (entry.threadId !== params.threadId) return null;

		const error = params.turn.error?.message ? sanitizeCodexErrorText(params.turn.error.message) : undefined;
		const terminal = { status: params.turn.status, error };

		// Tested against the same value the answer is read from.
		if (params.turn.status === "completed" && answerOf(entry) === undefined) {
			entry.pendingTerminal = terminal;
			return null;
		}
		return this.finish(params.turn.id, terminal);
	}

	private finish(
		turnId: string,
		terminal: { status: "completed" | "failed" | "interrupted"; error?: string },
	): TurnOutcome {
		const entry = this.turns.get(turnId);
		if (!entry) {
			return { threadId: "", turnId, status: terminal.status, activities: [], truncated: false };
		}
		this.turns.delete(turnId);
		this.remember(turnId);
		return {
			threadId: entry.threadId,
			turnId,
			status: terminal.status,
			finalResponse: terminal.status === "completed" ? answerOf(entry) : undefined,
			error: terminal.error,
			activities: entry.activities,
			truncated: entry.truncated,
		};
	}

	private retainActivity(
		entry: { activities: TrackedActivity[]; activityBytes: number; truncated: boolean },
		origin: { threadId: string; turnId: string },
		itemId: string,
		text: string,
	) {
		const size = byteLength(text);
		if (
			entry.activities.length >= CODEX_ACTIVITY_MAX_ITEMS ||
			entry.activityBytes + size > CODEX_ACTIVITY_MAX_BYTES
		) {
			entry.truncated = true;
			return;
		}
		entry.activities.push({ kind: "commentary", itemId, text });
		entry.activityBytes += size;
		this.onCommentary({ ...origin, itemId, text });
	}
}
