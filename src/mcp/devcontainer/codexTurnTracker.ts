import {
	CODEX_ACTIVITY_MAX_BYTES,
	CODEX_ACTIVITY_MAX_ITEMS,
	CodexAppServerAgentMessageCompletedSchema,
	CodexAppServerTurnCompletedSchema,
	sanitizeCodexErrorText,
} from "../../shared/codex-thinking.js";

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
	/** Present only for a completed turn that actually produced one. A failed or interrupted turn
	 * never receives an invented answer. */
	finalResponse?: string;
	error?: string;
	activities: TrackedActivity[];
	truncated: boolean;
}

////////////////////////////////
//  Functions & Helpers

const FINAL_ANSWER_PHASE = "final_answer";
const COMMENTARY_PHASE = "commentary";

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

////////////////////////////////
//  Class

/**
 * What a turn produced, assembled from the events the App Server emits for it.
 *
 * Deltas are ignored entirely and only completed items are kept, so nothing partial can reach
 * storage. A terminal that arrives before its own final item is held until that item lands or the
 * caller gives up waiting, which is the only reason this needs state at all.
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

/** The one place an answer is chosen. Both the hold decision and the reported outcome read it, so
 * they cannot disagree about whether this turn has produced one. */
function answerOf(entry: TrackedTurn): string | undefined {
	return entry.lastFinalAnswer ?? entry.lastCandidate;
}

// Turn ids of turns already reported. Bounded, because a late duplicate only ever arrives near its
// own turn, so remembering the recent ones is enough to refuse one.
const SETTLED_MEMORY = 256;

export class CodexTurnTracker {
	private readonly turns = new Map<string, TrackedTurn>();
	private readonly settled = new Set<string>();

	/** `onCommentary` streams what `retainActivity` just kept. It fires from the same classification
	 * the stored copy is built from, so a relayed item and a recorded one cannot disagree about which
	 * text was commentary. */
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

	/**
	 * Settle a turn whose terminal arrived but whose final item never did.
	 *
	 * The caller decides when to stop waiting; this only reports what is actually held, so a turn with
	 * no completed answer settles without one rather than borrowing a message from somewhere else.
	 */
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
		// A turn id belongs to one thread. An item naming a different one is not this turn's and is
		// dropped rather than merged, which is what keeps an answer from crossing threads.
		if (entry.threadId !== params.threadId) return null;

		const phase = typeof params.item.phase === "string" ? params.item.phase : undefined;
		if (phase === FINAL_ANSWER_PHASE) entry.lastFinalAnswer = params.item.text;
		// Commentary is retained but never answers for the turn. Everything else is a candidate,
		// including a phase this build has not seen, since dropping agent text loses it entirely.
		else if (phase === COMMENTARY_PHASE) this.retainActivity(entry, params, params.item.id, params.item.text);
		else entry.lastCandidate = params.item.text;

		// The terminal beat its own answer. Release the hold only once an answer has actually landed,
		// or commentary would release it and the real answer would arrive after the turn was reported.
		if (entry.pendingTerminal && answerOf(entry) !== undefined) {
			return this.finish(params.turnId, entry.pendingTerminal);
		}
		return null;
	}

	private onTurnCompleted(params: {
		threadId: string;
		turn: { id: string; status: "completed" | "failed" | "interrupted"; error?: { message?: string } | null };
	}) {
		// A redelivered terminal for a turn already reported would otherwise fabricate a blank entry and
		// answer a second time, with none of the first outcome's content.
		if (this.settled.has(params.turn.id)) return null;
		const entry = this.entryFor(params.threadId, params.turn.id);
		if (entry.threadId !== params.threadId) return null;

		const error = params.turn.error?.message ? sanitizeCodexErrorText(params.turn.error.message) : undefined;
		const terminal = { status: params.turn.status, error };

		// A successful turn with no answer yet is the terminal-before-final-item case. The test has to
		// be the same value the answer is read from, or a turn that has only produced commentary looks
		// finished and settles without the answer still in flight.
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
			// Only a completed turn gets an answer, and only from its own items.
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
