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
	lastAgentMessage?: string;
	lastFinalAnswer?: string;
	pendingTerminal?: { status: "completed" | "failed" | "interrupted"; error?: string };
}

export class CodexTurnTracker {
	private readonly turns = new Map<string, TrackedTurn>();

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
	}

	private entryFor(threadId: string, turnId: string): TrackedTurn {
		const existing = this.turns.get(turnId);
		if (existing) return existing;
		const created: TrackedTurn = { threadId, activities: [], activityBytes: 0, truncated: false };
		this.turns.set(turnId, created);
		return created;
	}

	private onItemCompleted(params: { threadId: string; turnId: string; item: { text: string; phase?: unknown } }) {
		const entry = this.entryFor(params.threadId, params.turnId);
		// An item can only ever belong to the turn it names, so a late one from another turn updates
		// that turn's own record and never this one's.
		if (entry.threadId !== params.threadId) return null;

		const phase = typeof params.item.phase === "string" ? params.item.phase : undefined;
		entry.lastAgentMessage = params.item.text;
		if (phase === FINAL_ANSWER_PHASE) entry.lastFinalAnswer = params.item.text;
		if (phase === COMMENTARY_PHASE) this.retainActivity(entry, params.item.text);

		// The terminal beat its own final item. Now that the item has landed, the turn can settle.
		if (entry.pendingTerminal) return this.finish(params.turnId, entry.pendingTerminal);
		return null;
	}

	private onTurnCompleted(params: {
		threadId: string;
		turn: { id: string; status: "completed" | "failed" | "interrupted"; error?: { message?: string } | null };
	}) {
		const entry = this.entryFor(params.threadId, params.turn.id);
		const error = params.turn.error?.message ? sanitizeCodexErrorText(params.turn.error.message) : undefined;
		const terminal = { status: params.turn.status, error };

		// A successful turn with nothing completed yet is the terminal-before-final-item case. Hold it
		// rather than settling on an answer that has not arrived.
		if (params.turn.status === "completed" && entry.lastAgentMessage === undefined) {
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
		return {
			threadId: entry.threadId,
			turnId,
			status: terminal.status,
			// Only a completed turn gets an answer, and only from its own items: the phased final if the
			// server marked one, otherwise this exact turn's last completed message.
			finalResponse:
				terminal.status === "completed" ? (entry.lastFinalAnswer ?? entry.lastAgentMessage) : undefined,
			error: terminal.error,
			activities: entry.activities,
			truncated: entry.truncated,
		};
	}

	private retainActivity(
		entry: { activities: TrackedActivity[]; activityBytes: number; truncated: boolean },
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
		entry.activities.push({ kind: "commentary", text });
		entry.activityBytes += size;
	}
}
