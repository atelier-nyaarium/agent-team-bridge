import { CodexAppServerThreadReadResultSchema, classifyCodexItemPhase } from "../../shared/codex-agent.js";
import type { TurnOutcome } from "./codexTurnTracker.js";

////////////////////////////////
//  Interfaces & Types

/** One shape for both the live tracker and a post-restart `thread/read`. */
export type TerminalOutcome =
	| { status: "completed"; finalResponse?: string; finalItemId?: string }
	| { status: "failed"; error: string }
	| { status: "interrupted" };

/**
 * Three answers, not two. Collapsing `running` and `unknown` reports a live turn as a failed one:
 * "still going" and "could not tell me" need opposite handling.
 */
export type ReadOutcome = { known: "settled"; outcome: TerminalOutcome } | { known: "running" } | { known: "unknown" };

////////////////////////////////
//  Functions & Helpers

/** Rebuilt from what `thread/read` still holds. A turn whose items are gone reports no answer. */
export function outcomeFromRead(result: unknown, threadId: string, turnId: string): ReadOutcome {
	const parsed = CodexAppServerThreadReadResultSchema.safeParse(result);
	if (!parsed.success || parsed.data.thread.id !== threadId) return { known: "unknown" };
	const turn = parsed.data.thread.turns.find((candidate) => candidate.id === turnId);
	if (!turn) return { known: "unknown" };
	if (turn.status === "inProgress") return { known: "running" };
	if (turn.status === "interrupted") return { known: "settled", outcome: { status: "interrupted" } };
	// A read carries no error text, so a failure recovered this way says only that it failed.
	if (turn.status === "failed") return { known: "settled", outcome: { status: "failed", error: `turn failed` } };
	const messages = turn.items.filter(
		(item): item is { type: "agentMessage"; id: string; text: string; phase?: unknown } =>
			item.type === "agentMessage",
	);
	// The tracker's own classification, so a rebuilt turn agrees with a witnessed one. Commentary is
	// excluded: narration as a final response is a wrong answer, none is an empty one.
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
			return { status: "failed", error: outcome.error ?? `turn failed` };
		default:
			return { status: "interrupted" };
	}
}
