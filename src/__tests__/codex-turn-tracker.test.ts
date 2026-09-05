import { describe, expect, it } from "vitest";
import { CodexTurnTracker } from "../mcp/devcontainer/codexTurnTracker.js";

const threadId = "thread-1";
const turnId = "turn-1";

function item(text: string, phase?: string, turn = turnId, thread = threadId) {
	return {
		method: "item/completed",
		params: { threadId: thread, turnId: turn, item: { type: "agentMessage", id: text, text, phase } },
	};
}

function terminal(status: "completed" | "failed" | "interrupted" = "completed", error?: string) {
	return {
		method: "turn/completed",
		params: { threadId, turn: { id: turnId, status, error: error ? { message: error } : null } },
	};
}

describe("CodexTurnTracker protocol outcomes", () => {
	it("chooses a final answer over later unphased text and preserves commentary", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(item("thinking", "commentary"));
		tracker.accept(item("answer", "final_answer"));
		tracker.accept(item("trailing"));
		expect(tracker.accept(terminal())).toEqual({
			threadId,
			turnId,
			status: "completed",
			finalResponse: "answer",
			activities: [{ kind: "commentary", itemId: "thinking", text: "thinking" }],
			truncated: false,
		});
	});

	it("holds a terminal until its final item, then settles it", () => {
		const tracker = new CodexTurnTracker();
		expect(tracker.accept(terminal())).toBeNull();
		expect(tracker.holding(threadId, turnId)).toBe(true);
		expect(tracker.accept(item("answer", "final_answer"))).toMatchObject({ finalResponse: "answer" });
	});

	it("settles an action-only held turn without inventing an answer", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(item("working", "commentary"));
		tracker.accept(terminal());
		expect(tracker.settlePending(threadId, turnId)).toMatchObject({
			status: "completed",
			activities: [{ text: "working" }],
			truncated: false,
		});
	});

	it("maps failed and interrupted terminals without an answer", () => {
		const failed = new CodexTurnTracker();
		expect(failed.accept(terminal("failed", "model\0refused\u001b[31m"))).toMatchObject({
			status: "failed",
			finalResponse: undefined,
			error: expect.not.stringContaining("\0"),
		});
		const interrupted = new CodexTurnTracker();
		interrupted.accept(item("partial", "final_answer"));
		expect(interrupted.accept(terminal("interrupted"))).toMatchObject({
			status: "interrupted",
			finalResponse: undefined,
		});
	});

	it("ignores deltas, other turns, other threads, and duplicate terminals", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "partial" } });
		tracker.accept(item("other turn", "final_answer", "turn-2"));
		tracker.accept(item("answer", "final_answer"));
		// The turn id is bound to its first thread.
		tracker.accept(item("other thread", "final_answer", turnId, "thread-2"));
		expect(tracker.accept(terminal())).toMatchObject({ finalResponse: "answer" });
		expect(tracker.accept(terminal("failed", "duplicate"))).toBeNull();
	});

	it("marks activity truncation after the item bound", () => {
		const tracker = new CodexTurnTracker();
		for (let index = 0; index < 40; index += 1) tracker.accept(item(`note-${index}`, "commentary"));
		tracker.accept(item("answer", "final_answer"));
		expect(tracker.accept(terminal())).toMatchObject({ activities: { length: 32 }, truncated: true });
	});
});
