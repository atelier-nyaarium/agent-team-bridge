import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createJsonlTransport, strongestEffort } from "../mcp/devcontainer/codexAppServer.js";
import type { CodexChild } from "../mcp/devcontainer/codexTargets.js";
import { CodexTurnTracker } from "../mcp/devcontainer/codexTurnTracker.js";

////////////////////////////////
//  Functions & Helpers

const THREAD = "thread-1";
const TURN = "turn-1";

function itemCompleted(text: string, phase?: string, ids: { threadId?: string; turnId?: string } = {}) {
	return {
		method: "item/completed",
		params: {
			threadId: ids.threadId ?? THREAD,
			turnId: ids.turnId ?? TURN,
			item: { type: "agentMessage", id: `item-${text}`, text, phase: phase ?? null },
		},
	};
}

function turnCompleted(
	status: "completed" | "failed" | "interrupted",
	extra: { error?: string; turnId?: string } = {},
) {
	return {
		method: "turn/completed",
		params: {
			threadId: THREAD,
			turn: {
				id: extra.turnId ?? TURN,
				status,
				items: [],
				error: extra.error ? { message: extra.error } : null,
			},
		},
	};
}

/** A fake child whose written lines are captured, and whose stdout can be fed a frame. */
function fakeChild() {
	const stdout = new PassThrough();
	const written: string[] = [];
	let onExit: (info: { code: number | null; signal: string | null }) => void = () => {};
	const child: CodexChild = {
		stdin: { write: (line: string) => written.push(line) } as unknown as CodexChild["stdin"],
		stdout: stdout as unknown as CodexChild["stdout"],
		kill: () => {},
		onExit: (listener) => {
			onExit = listener;
		},
	};
	return {
		child,
		written,
		sent: () => written.map((w) => JSON.parse(w)),
		feed: (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`),
		exit: () => onExit({ code: 1, signal: null }),
	};
}

////////////////////////////////
//  Tests

describe("what a turn produced", () => {
	it("answers with the phased final when the server marked one", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("thinking out loud", "commentary"));
		tracker.accept(itemCompleted("the answer", "final_answer"));

		const outcome = tracker.accept(turnCompleted("completed"));

		expect(outcome?.finalResponse).toBe("the answer");
	});

	it("falls back to this turn's last completed message when no phase was marked", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("first"));
		tracker.accept(itemCompleted("second"));

		expect(tracker.accept(turnCompleted("completed"))?.finalResponse).toBe("second");
	});

	it("holds a terminal that beat its own final item, then settles when the item lands", () => {
		const tracker = new CodexTurnTracker();

		expect(tracker.accept(turnCompleted("completed"))).toBeNull();

		const outcome = tracker.accept(itemCompleted("late answer", "final_answer"));

		expect(outcome?.status).toBe("completed");
		expect(outcome?.finalResponse).toBe("late answer");
	});

	it("settles a held terminal without an answer rather than inventing one", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(turnCompleted("completed"));

		const outcome = tracker.settlePending(THREAD, TURN);

		expect(outcome?.status).toBe("completed");
		expect(outcome?.finalResponse).toBeUndefined();
	});

	it("gives a failed turn no answer, only its sanitized error", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("partial work"));

		const outcome = tracker.accept(turnCompleted("failed", { error: "model refused" }));

		expect(outcome?.finalResponse).toBeUndefined();
		expect(outcome?.error).toContain("model refused");
	});

	it("gives an interrupted turn no answer either", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("half a thought", "final_answer"));

		expect(tracker.accept(turnCompleted("interrupted"))?.finalResponse).toBeUndefined();
	});

	it("never borrows a message from another turn", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("belongs to the other turn", "final_answer", { turnId: "turn-2" }));

		const outcome = tracker.accept(turnCompleted("completed"));

		expect(outcome).toBeNull();
		expect(tracker.settlePending(THREAD, TURN)?.finalResponse).toBeUndefined();
	});

	it("keeps commentary and marks truncation once it runs past the cap", () => {
		const tracker = new CodexTurnTracker();
		for (let i = 0; i < 40; i++) tracker.accept(itemCompleted(`note ${i}`, "commentary"));
		tracker.accept(itemCompleted("done", "final_answer"));

		const outcome = tracker.accept(turnCompleted("completed"));

		expect(outcome?.activities.length).toBe(32);
		expect(outcome?.truncated).toBe(true);
	});

	it("keeps a delta out of everything, since only completed items are ever accepted", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: TURN, delta: "par" } });
		tracker.accept(itemCompleted("whole", "final_answer"));

		expect(tracker.accept(turnCompleted("completed"))?.finalResponse).toBe("whole");
	});
});

describe("how the client answers what Codex asks of it", () => {
	it.each([
		["item/commandApproval", { decision: "denied" }],
		["item/fileChangeApproval", { decision: "denied" }],
		["thread/userInput", { cancelled: true }],
		["thread/elicitation", { action: "cancel" }],
		["app/toolApproval", { decision: "denied" }],
		["permission/request", { granted: false }],
	])("refuses %s", async (method, expected) => {
		const f = fakeChild();
		createJsonlTransport(f.child);
		f.feed({ jsonrpc: "2.0", id: 7, method, params: {} });
		await new Promise((r) => setImmediate(r));

		expect(f.sent().find((m) => m.id === 7)?.result).toEqual(expected);
	});

	it("refuses an unknown request instead of leaving Codex waiting", async () => {
		const f = fakeChild();
		createJsonlTransport(f.child);
		f.feed({ jsonrpc: "2.0", id: 9, method: "some/futureApproval", params: {} });
		await new Promise((r) => setImmediate(r));

		const answer = f.sent().find((m) => m.id === 9);
		expect(answer?.error?.code).toBe(-32601);
		expect(answer?.result).toBeUndefined();
	});

	it("treats a method with no id as an event rather than answering it", async () => {
		const f = fakeChild();
		const transport = createJsonlTransport(f.child);
		const seen = vi.fn();
		transport.onEvent(seen);
		f.feed({ jsonrpc: "2.0", method: "turn/started", params: {} });
		await new Promise((r) => setImmediate(r));

		expect(seen).toHaveBeenCalled();
		expect(f.sent()).toHaveLength(0);
	});
});

describe("the transport's request plumbing", () => {
	it("resolves a request with its own response, matched by id", async () => {
		const f = fakeChild();
		const transport = createJsonlTransport(f.child);
		const pending = transport.request("thread/read", { threadId: THREAD });
		await new Promise((r) => setImmediate(r));
		const id = f.sent()[0]?.id;
		f.feed({ jsonrpc: "2.0", id, result: { ok: true } });

		expect(await pending).toEqual({ ok: true });
	});

	it("rejects a request the server answered with an error", async () => {
		const f = fakeChild();
		const transport = createJsonlTransport(f.child);
		const pending = transport.request("turn/steer", {});
		await new Promise((r) => setImmediate(r));
		f.feed({ jsonrpc: "2.0", id: f.sent()[0]?.id, error: { code: -1, message: "no such turn" } });

		await expect(pending).rejects.toThrow("no such turn");
	});

	it("fails everything in flight when the child dies rather than hanging", async () => {
		const f = fakeChild();
		const transport = createJsonlTransport(f.child);
		const pending = transport.request("turn/start", {});
		f.exit();

		await expect(pending).rejects.toThrow("app server exited");
	});

	it("reassembles a frame split across chunks", async () => {
		const f = fakeChild();
		const transport = createJsonlTransport(f.child);
		const seen = vi.fn();
		transport.onEvent(seen);
		f.child.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","method":"turn/st'));
		f.child.stdout.emit("data", Buffer.from('arted","params":{}}\n'));
		await new Promise((r) => setImmediate(r));

		expect(seen).toHaveBeenCalledWith(expect.objectContaining({ method: "turn/started" }));
	});
});

describe("choosing a reasoning effort", () => {
	it("takes the strongest tier the model actually offers", () => {
		expect(
			strongestEffort({
				supportedReasoningEfforts: [
					{ reasoningEffort: "low" },
					{ reasoningEffort: "max" },
					{ reasoningEffort: "high" },
				],
			}),
		).toBe("max");
	});

	it("takes ultra over max where a model offers it", () => {
		expect(
			strongestEffort({ supportedReasoningEfforts: [{ reasoningEffort: "max" }, { reasoningEffort: "ultra" }] }),
		).toBe("ultra");
	});
});
