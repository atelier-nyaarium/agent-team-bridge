import { CodexAppServerThreadReadResultSchema, classifyCodexItemPhase } from "../../shared/codex-thinking.js";
import type { TurnOutcome } from "./codexTurnTracker.js";

////////////////////////////////
//  Interfaces & Types

/** How a turn ended. The one shape both the live tracker and a post-restart `thread/read` produce, so
 * a rebuilt terminal and a witnessed one are the same message. */
export type TerminalOutcome =
	| { status: "completed"; finalResponse?: string; finalItemId?: string }
	| { status: "failed"; error: string }
	| { status: "interrupted" };

/**
 * What App Server says about one turn.
 *
 * Three answers, not two. Collapsing `running` and `unknown` into a single absent outcome is what
 * lets a live turn be reported as a failed one: the caller cannot tell "App Server says it is still
 * going" from "App Server could not tell me", and the plan requires opposite handling for each.
 */
export type ReadOutcome = { known: "settled"; outcome: TerminalOutcome } | { known: "running" } | { known: "unknown" };

////////////////////////////////
//  Functions & Helpers

/** The outcome a settled turn had, rebuilt from what `thread/read` still holds. Nothing is invented:
 * a turn whose items are gone reports completed with no answer rather than a guessed one. */
export function outcomeFromRead(result: unknown, threadId: string, turnId: string): ReadOutcome {
	const parsed = CodexAppServerThreadReadResultSchema.safeParse(result);
	if (!parsed.success || parsed.data.thread.id !== threadId) return { known: "unknown" };
	const turn = parsed.data.thread.turns.find((candidate) => candidate.id === turnId);
	if (!turn) return { known: "unknown" };
	if (turn.status === "inProgress") return { known: "running" };
	if (turn.status === "interrupted") return { known: "settled", outcome: { status: "interrupted" } };
	// A read carries no error text, so a failure recovered this way says only that it failed.
	if (turn.status === "failed") return { known: "settled", outcome: { status: "failed", error: "turn failed" } };
	const messages = turn.items.filter(
		(item): item is { type: "agentMessage"; id: string; text: string; phase?: unknown } =>
			item.type === "agentMessage",
	);
	// The same three-way classification the live tracker uses, so a turn rebuilt after a restart and
	// one witnessed as it ran cannot disagree about which item was the answer. Commentary is excluded
	// from the fallback: handing narration back as a final response is a WRONG answer, where handing
	// back none is merely an empty one.
	const classified = messages.map((item) => ({ item, kind: classifyCodexItemPhase(item.phase) }));
	const final =
		classified.findLast((entry) => entry.kind === "answer")?.item ??
		classified.findLast((entry) => entry.kind === "candidate")?.item;
	return {
		known: "settled",
		outcome: { status: "completed", finalResponse: final?.text, finalItemId: final?.id },
	};
}

export function terminalOf(outcome: TurnOutcome): TerminalOutcome {
	switch (outcome.status) {
		case "completed":
			return { status: "completed", finalResponse: outcome.finalResponse };
		case "failed":
			return { status: "failed", error: outcome.error ?? "turn failed" };
		default:
			return { status: "interrupted" };
	}
}
