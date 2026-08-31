import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	type AppServerTransport,
	CodexAppServerClient,
	createJsonlTransport,
	isAppServerFailure,
	type LifecycleHooks,
	strongestEffort,
} from "../mcp/devcontainer/codexAppServer.js";
import type { CodexChild } from "../mcp/devcontainer/codexTargets.js";
import { DISPOSE_QUIET_MS, PARK_RETRY_MS, RETIRED_MEMORY } from "../mcp/devcontainer/codexThreadLifecycle.js";
import type { TerminalOutcome } from "../mcp/devcontainer/codexTurnOutcome.js";
import { CodexTurnTracker } from "../mcp/devcontainer/codexTurnTracker.js";

////////////////////////////////
//  Functions & Helpers

const THREAD = "thread-1";
const TURN = "turn-1";

/** These cases drive the wire, not a consumer, so they register nothing for the turn they start. */
const noteTurn = () => {};

let itemSeq = 0;

function itemCompleted(text: string, phase?: string, ids: { threadId?: string; turnId?: string } = {}) {
	// The id is its own counter rather than derived from the text, which would blow the wire schema's
	// 512-char id bound the moment a case uses a large message.
	itemSeq += 1;
	return {
		method: "item/completed",
		params: {
			threadId: ids.threadId ?? THREAD,
			turnId: ids.turnId ?? TURN,
			item: { type: "agentMessage", id: `item-${itemSeq}`, text, phase: phase ?? null },
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
function fakeChild(options: { writeThrows?: Error } = {}) {
	const stdout = new PassThrough();
	const written: string[] = [];
	let kills = 0;
	let onExit: (info: { code: number | null; signal: string | null }) => void = () => {};
	const child: CodexChild = {
		stdin: {
			write: (line: string) => {
				if (options.writeThrows) throw options.writeThrows;
				written.push(line);
			},
		} as unknown as CodexChild["stdin"],
		stdout: stdout as unknown as CodexChild["stdout"],
		kill: () => {
			kills += 1;
		},
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
		kills: () => kills,
	};
}

////////////////////////////////
//  Tests

describe("what a turn produced", () => {
	it("answers with the phased final even when a later message follows it", () => {
		// The phased final must win on its phase, not on being last, or the special case is untested.
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("the answer", "final_answer"));
		tracker.accept(itemCompleted("a trailing aside"));

		expect(tracker.accept(turnCompleted("completed"))?.finalResponse).toBe("the answer");
	});

	it("never answers with commentary, even when it is all the turn produced", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("just thinking", "commentary"));

		// Commentary is not an answer, so the terminal is held rather than settling on it. The caller
		// decides when to give up, and only then does the turn report with nothing.
		expect(tracker.accept(turnCompleted("completed"))).toBeNull();

		const outcome = tracker.settlePending(THREAD, TURN);

		expect(outcome?.finalResponse).toBeUndefined();
		expect(outcome?.activities).toHaveLength(1);
	});

	it("waits past commentary for the answer still in flight", () => {
		// Codex streams commentary before its answer, so a terminal arriving in between must not settle
		// the turn: the answer would land after it was reported and be dropped.
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("thinking out loud", "commentary"));

		expect(tracker.accept(turnCompleted("completed"))).toBeNull();

		const outcome = tracker.accept(itemCompleted("the real answer", "final_answer"));

		expect(outcome?.finalResponse).toBe("the real answer");
		expect(outcome?.activities).toHaveLength(1);
	});

	it("keeps agent text carrying a phase this build does not know", () => {
		// `phase` is an open string on the wire, so an unrecognized one must not send the text nowhere.
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("said under a new phase", "some_future_phase"));

		expect(tracker.accept(turnCompleted("completed"))?.finalResponse).toBe("said under a new phase");
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

		// Control characters in the fixture, so a dropped sanitize call fails this rather than passing.
		const outcome = tracker.accept(turnCompleted("failed", { error: "model\0refused\x1b[31m" }));

		expect(outcome?.finalResponse).toBeUndefined();
		expect(outcome?.error).not.toContain("\0");
		expect(outcome?.error).not.toContain("\x1b");
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
		// The delta arrives with nothing after it, so if it leaked into state it would BE the answer.
		const tracker = new CodexTurnTracker();
		tracker.accept({
			method: "item/agentMessage/delta",
			params: { threadId: THREAD, turnId: TURN, delta: "partial" },
		});

		const outcome = tracker.accept(turnCompleted("completed"));

		expect(outcome).toBeNull();
		expect(tracker.settlePending(THREAD, TURN)?.finalResponse).toBeUndefined();
	});

	it("drops an item naming a different thread than the turn it claims", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("mine", "final_answer"));
		tracker.accept(itemCompleted("not mine", "final_answer", { threadId: "thread-2" }));

		expect(tracker.accept(turnCompleted("completed"))?.finalResponse).toBe("mine");
	});

	it("refuses to report a turn twice when its terminal is redelivered", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("the answer", "final_answer"));
		expect(tracker.accept(turnCompleted("completed"))?.finalResponse).toBe("the answer");

		expect(tracker.accept(turnCompleted("failed", { error: "late duplicate" }))).toBeNull();
	});

	it("stops keeping commentary once its byte budget is spent, not just its count", () => {
		const tracker = new CodexTurnTracker();
		tracker.accept(itemCompleted("x".repeat(20_000), "commentary"));

		const outcome = tracker.accept(turnCompleted("failed"));

		expect(outcome?.activities).toHaveLength(0);
		expect(outcome?.truncated).toBe(true);
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

	it.each([
		["null"],
		["[1,2,3]"],
		['"a string"'],
		["123"],
	])("survives a frame that parses to %s rather than taking the daemon down", async (raw) => {
		// An uncaught throw here reaches the daemon's uncaughtException handler, which reaps every
		// target's App Server, so one bad line from one child would stop the whole machine.
		const f = fakeChild();
		createJsonlTransport(f.child);

		expect(() => f.child.stdout.emit("data", Buffer.from(`${raw}\n`))).not.toThrow();
	});

	it("still answers a request whose method is not even a string", async () => {
		const f = fakeChild();
		createJsonlTransport(f.child);
		f.feed({ jsonrpc: "2.0", id: 11, method: 42 });
		await new Promise((r) => setImmediate(r));

		expect(f.sent().find((m) => m.id === 11)?.error?.code).toBe(-32601);
	});

	it("refuses a method named after an inherited object property instead of answering with one", async () => {
		// A plain object lookup would return Object.prototype's own function here, and JSON.stringify
		// drops it, producing a reply carrying neither a result nor an error.
		const f = fakeChild();
		createJsonlTransport(f.child);
		f.feed({ jsonrpc: "2.0", id: 12, method: "constructor" });
		await new Promise((r) => setImmediate(r));

		expect(f.sent().find((m) => m.id === 12)?.error?.code).toBe(-32601);
	});

	it("bounds the method name it echoes back", async () => {
		const f = fakeChild();
		createJsonlTransport(f.child);
		f.feed({ jsonrpc: "2.0", id: 13, method: "x".repeat(5_000) });
		await new Promise((r) => setImmediate(r));

		expect(f.sent().find((m) => m.id === 13)?.error?.message.length).toBeLessThan(200);
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

	it("claims an unreadable frame carrying an id it minted, rather than waiting out the timeout", async () => {
		// `error: null` beside a result is ordinary serialization and fails the strict response schema.
		// Answering it as a malformed request would reuse our own id and strand the real caller.
		const f = fakeChild();
		const transport = createJsonlTransport(f.child);
		const pending = transport.request("initialize", {});
		await new Promise((r) => setImmediate(r));
		const id = f.sent()[0]?.id;
		f.feed({ jsonrpc: "2.0", id, result: { userAgent: "codex" }, error: null });

		await expect(pending).rejects.toThrow("unreadable response");
		await expect(pending).rejects.toMatchObject({ kind: "unreadable" });
		expect(f.sent().filter((m) => m.error?.code === -32601)).toHaveLength(0);
	});

	it("rejects a request the server answered with an error", async () => {
		const f = fakeChild();
		const transport = createJsonlTransport(f.child);
		const pending = transport.request("turn/steer", {});
		await new Promise((r) => setImmediate(r));
		f.feed({ jsonrpc: "2.0", id: f.sent()[0]?.id, error: { code: -1, message: "no such turn" } });

		await expect(pending).rejects.toThrow("no such turn");
		await expect(pending).rejects.toMatchObject({ kind: "refused", code: -1 });
	});

	it("fails everything in flight when the child dies rather than hanging, and drops their timers", async () => {
		vi.useFakeTimers();
		try {
			const f = fakeChild();
			const transport = createJsonlTransport(f.child);
			const pending = transport.request("turn/start", {});
			f.exit();

			await expect(pending).rejects.toThrow("app server exited");
			await expect(pending).rejects.toMatchObject({ kind: "closed" });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
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

describe("how a request fails", () => {
	it("carries a refusal's code and data beside its kind, so nothing reads the sentence", async () => {
		const f = fakeChild();
		const transport = createJsonlTransport(f.child);
		const pending = transport.request("thread/archive", { threadId: THREAD });
		await new Promise((r) => setImmediate(r));
		f.feed({
			jsonrpc: "2.0",
			id: f.sent()[0]?.id,
			error: { code: -32600, message: "no rollout found", data: { threadId: THREAD } },
		});

		const failure = await pending.catch((error) => error);
		// Still an Error: `describe` and `errorText` read the message through `instanceof Error`.
		expect(failure).toBeInstanceOf(Error);
		expect(isAppServerFailure(failure)).toBe(true);
		expect(failure).toMatchObject({
			name: "AppServerFailure",
			kind: "refused",
			code: -32600,
			data: { threadId: THREAD },
			message: "no rollout found",
		});
		// Only what the transport minted passes: not an ordinary Error, not one wearing the prototype, and
		// not one built through the constructor an instance hands out.
		expect(isAppServerFailure(new Error("ordinary"))).toBe(false);
		expect(isAppServerFailure(Object.setPrototypeOf(new Error("forged"), Object.getPrototypeOf(failure)))).toBe(
			false,
		);
		const Reached = (failure as { constructor: new (...args: unknown[]) => unknown }).constructor;
		expect(() => new Reached(Symbol("guess"), "refused", "forged")).toThrow();
	});

	it("settles what is in flight as closed when the transport is closed, rather than waiting out the timeout", async () => {
		vi.useFakeTimers();
		try {
			const f = fakeChild();
			const transport = createJsonlTransport(f.child);
			const failure = transport.request("thread/read", { threadId: THREAD }).catch((error) => error);
			transport.close();
			transport.close();

			expect(await failure).toMatchObject({ kind: "closed" });
			expect(vi.getTimerCount()).toBe(0);
			// A second close, and a close after the child already exited, kill nothing again.
			expect(f.kills()).toBe(1);
			f.exit();
			transport.close();
			expect(f.kills()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("times out as its own kind, and a reply landing afterwards settles nothing", async () => {
		vi.useFakeTimers();
		try {
			const f = fakeChild();
			const transport = createJsonlTransport(f.child);
			const failure = transport.request("thread/read", { threadId: THREAD }).catch((error) => error);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(await failure).toMatchObject({ kind: "timeout", message: "timed out: thread/read" });

			// The late frame carries the id the transport already gave up on; it must neither answer as a
			// request nor settle the request issued after it.
			const second = transport.request("thread/read", { threadId: THREAD });
			const [lateId, secondId] = f.sent().map((m) => m.id);
			f.feed({ jsonrpc: "2.0", id: lateId, result: { late: true } });
			f.feed({ jsonrpc: "2.0", id: secondId, result: { second: true } });

			expect(await second).toEqual({ second: true });
			expect(f.sent().filter((m) => m.error?.code === -32601)).toHaveLength(0);
			// A settled request leaves no timer behind.
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses a request after the child died, as closed, writing nothing to the pipe", async () => {
		const f = fakeChild();
		const transport = createJsonlTransport(f.child);
		f.exit();

		const failure = await transport.request("thread/read", { threadId: THREAD }).catch((error) => error);
		expect(failure).toMatchObject({ kind: "closed" });
		expect(f.sent()).toHaveLength(0);
	});

	it("treats a pipe that refuses a write as a dead child, failing that request and every later one as closed", async () => {
		// EPIPE surfaces as a synchronous throw from stdin.write, before any exit event.
		const f = fakeChild({ writeThrows: new Error("EPIPE") });
		const transport = createJsonlTransport(f.child);

		const first = await transport.request("thread/read", { threadId: THREAD }).catch((error) => error);
		const second = await transport.request("thread/read", { threadId: THREAD }).catch((error) => error);
		expect(isAppServerFailure(first)).toBe(true);
		expect(first).toMatchObject({ kind: "closed", message: "app server exited" });
		expect(second).toMatchObject({ kind: "closed" });
		// The kill is what makes the exit path run, so the supervisor drops the lease.
		expect(f.kills()).toBe(1);
	});
});

describe("the client's own guarantees", () => {
	/** A transport that answers from a canned table and records what it was asked. */
	function fakeTransport(
		models: unknown[] = [{ id: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }],
	) {
		const calls: Array<{ method: string; params: unknown }> = [];
		const transport: AppServerTransport = {
			request: async (method, params) => {
				calls.push({ method, params });
				if (method === "model/list") return { data: models };
				if (method === "thread/start") return { thread: { id: "thread-x" } };
				if (method === "turn/start") return { turn: { id: "turn-x", status: "inProgress", items: [] } };
				return {};
			},
			notify: (method, params) => calls.push({ method, params }),
			onEvent: () => {},
			close: () => {},
		};
		return { transport, calls, methods: () => calls.map((c) => c.method) };
	}

	it("handshakes before anything else, and only then lists models", async () => {
		const f = fakeTransport();
		await CodexAppServerClient.open(f.transport, "gpt-5.6-luna");

		expect(f.methods()).toEqual(["initialize", "initialized", "model/list"]);
	});

	it("refuses to open at all against a server that does not offer the model", async () => {
		const f = fakeTransport([{ id: "gpt-5.6-sol" }]);

		await expect(CodexAppServerClient.open(f.transport, "gpt-5.6-luna")).rejects.toThrow("model not offered");
	});

	it("starts a thread with the model, its strongest effort, approvals off, and a named sandbox", async () => {
		const f = fakeTransport();
		const client = await CodexAppServerClient.open(f.transport, "gpt-5.6-luna");
		await client.startThread({ cwd: "/workspace/app" });

		expect(f.calls.find((c) => c.method === "thread/start")?.params).toEqual({
			cwd: "/workspace/app",
			model: "gpt-5.6-luna",
			reasoningEffort: "max",
			approvalPolicy: "never",
			sandbox: "workspace-write",
		});
	});

	it("verifies a per-call model override rather than passing it through on trust", async () => {
		// This is the path Phase 7's optional model input takes, so an unverified override here would
		// run a tier nobody confirmed exists.
		const f = fakeTransport();
		const client = await CodexAppServerClient.open(f.transport, "gpt-5.6-luna");

		await expect(client.startThread({ cwd: "/tmp", model: "gpt-9-imaginary" })).rejects.toThrow(
			"model not offered",
		);
		expect(f.methods()).not.toContain("thread/start");
	});

	it("leaves effort unset for a model that advertises none, so its own default stands", async () => {
		const f = fakeTransport([{ id: "gpt-5.6-luna" }]);
		const client = await CodexAppServerClient.open(f.transport, "gpt-5.6-luna");
		await client.startThread({ cwd: "/tmp" });

		expect(f.calls.find((c) => c.method === "thread/start")?.params).not.toHaveProperty("reasoningEffort");
	});

	it("uses only the stable thread and turn operations", async () => {
		const f = fakeTransport();
		const client = await CodexAppServerClient.open(f.transport, "gpt-5.6-luna");
		await client.startThread({ cwd: "/tmp" });
		await client.resumeThread("t");
		await client.readThread("t");
		const turnId = await client.startTurn("t", "hi", noteTurn);
		await client.steerTurn("t", turnId, "more");
		await client.interruptTurn("t", turnId);

		expect(f.methods()).toEqual([
			"initialize",
			"initialized",
			"model/list",
			"thread/start",
			"thread/resume",
			"thread/read",
			"turn/start",
			"turn/steer",
			"turn/interrupt",
		]);
	});
});

describe("the thread lifecycle", () => {
	const MODEL = "gpt-5.6-luna";
	const DONE: TerminalOutcome = { status: "completed", finalResponse: "ok" };

	/** Flushes the pipe and the microtasks behind it under fake timers. */
	const tick = () => vi.advanceTimersByTimeAsync(1);

	type Fake = ReturnType<typeof fakeChild>;

	/** The nth request of a method, once the client has written it. */
	async function requested(f: Fake, method: string, nth = 0) {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const hits = f.sent().filter((m) => m.method === method);
			if (hits.length > nth) return hits[nth];
			await tick();
		}
		throw new Error(`${method} #${nth} was never requested`);
	}

	async function answer(f: Fake, method: string, result: unknown, nth = 0) {
		const request = await requested(f, method, nth);
		f.feed({ jsonrpc: "2.0", id: request.id, result });
		await tick();
	}

	async function refuse(f: Fake, method: string, message: string, nth = 0) {
		const request = await requested(f, method, nth);
		f.feed({ jsonrpc: "2.0", id: request.id, error: { code: -32600, message } });
		await tick();
	}

	function readOf(threadId: string, turns: unknown[]) {
		return { thread: { id: threadId, turns } };
	}

	/** The real transport over a fake child, so every failure here is one the transport minted. */
	async function openLifecycle(hooks: LifecycleHooks = {}) {
		const f = fakeChild();
		const transport = createJsonlTransport(f.child);
		const opening = CodexAppServerClient.open(transport, MODEL, hooks);
		await answer(f, "initialize", {});
		await answer(f, "model/list", { data: [{ id: MODEL }] });
		const client = await opening;
		const starting = client.startThread({ cwd: "/tmp" });
		await answer(f, "thread/start", { thread: { id: THREAD } });
		await starting;
		return { f, client };
	}

	/** A thread with one settled turn, parked. */
	async function parked(hooks: LifecycleHooks = {}) {
		const opened = await openLifecycle(hooks);
		const turn = opened.client.startTurn(THREAD, "go", noteTurn);
		await answer(opened.f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
		expect(await turn).toBe(TURN);
		const settling = opened.client.settleTurn(THREAD, TURN, DONE);
		await answer(opened.f, "thread/archive", {});
		await settling;
		expect(opened.client.stateOf(THREAD)).toMatchObject({ phase: "parked" });
		return opened;
	}

	const methods = (f: Fake) => f.sent().map((m) => m.method as string);

	it("settles a terminal that beat the turn/start response once the id is known, then parks", async () => {
		vi.useFakeTimers();
		try {
			const terminals: unknown[] = [];
			const order: string[] = [];
			const { f, client } = await openLifecycle({
				onTerminal: (...args) => {
					order.push("published");
					terminals.push(args);
				},
			});
			const turn = client.startTurn(THREAD, "go", () => order.push("registered"));
			await requested(f, "turn/start");
			await client.settleTurn(THREAD, TURN, DONE);
			expect(terminals).toEqual([]);

			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await answer(f, "thread/archive", {});

			expect(await turn).toBe(TURN);
			// The whole reason the callback exists: a consumer registers before this terminal is its to miss.
			expect(order).toEqual(["registered", "published"]);
			expect(terminals).toEqual([[THREAD, TURN, DONE]]);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "parked" });
			expect((await requested(f, "thread/archive")).params).toEqual({ threadId: THREAD });
		} finally {
			vi.useRealTimers();
		}
	});

	it("forgets a settled record once enough retire behind it, keeping one activated since", async () => {
		vi.useFakeTimers();
		try {
			const published: string[] = [];
			const { f, client } = await openLifecycle({ onTerminal: (_thread, turnId) => published.push(turnId) });
			// A thread reached only by name parks on its terminal, so one archive retires each.
			const retire = async (threadId: string, nth: number) => {
				const settling = client.settleTurn(threadId, `${threadId}-turn`, DONE);
				await answer(f, "thread/archive", {}, nth);
				await settling;
			};

			await retire("aged", 0);
			await retire("revived", 1);
			const reviving = client.resumeThread("revived");
			await answer(f, "thread/resume", {});
			await reviving;

			// Enough to shift both ids off the queue, which is the only way a record is forgotten.
			for (let index = 0; index < RETIRED_MEMORY; index += 1) await retire(`spare-${index}`, index + 2);

			expect(client.stateOf("aged")).toBeUndefined();
			expect(client.stateOf("revived")).toMatchObject({ phase: "idle" });

			// The kept record still carries what it published, so its terminal does not report twice.
			await retire("revived", RETIRED_MEMORY + 2);
			expect(published.filter((turnId) => turnId === "revived-turn")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retires a replacement thread on its own clock, not on the one whose id it reused", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			let archives = 0;
			const retire = async (threadId: string) => {
				const settling = client.settleTurn(threadId, `${threadId}-turn`, DONE);
				await answer(f, "thread/archive", {}, archives);
				archives += 1;
				await settling;
			};

			await retire("reused");
			// The server handing back an id this client knew is a new thread, and it replaces the record.
			const restarting = client.startThread({ cwd: "/tmp" });
			await answer(f, "thread/start", { thread: { id: "reused" } }, 1);
			await restarting;
			await retire("reused");

			// Enough to shift the first thread's retirement off the queue, but not the replacement's.
			for (let index = 0; index < RETIRED_MEMORY - 1; index += 1) await retire(`spare-${index}`);

			expect(client.stateOf("reused")).toMatchObject({ phase: "parked" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("starts a reactivated thread's retention over rather than running it from the first park", async () => {
		vi.useFakeTimers();
		try {
			const published: string[] = [];
			const { f, client } = await openLifecycle({ onTerminal: (_thread, turnId) => published.push(turnId) });
			let archives = 0;
			const retire = async (threadId: string, turnId: string) => {
				const settling = client.settleTurn(threadId, turnId, DONE);
				await answer(f, "thread/archive", {}, archives);
				archives += 1;
				await settling;
			};

			await retire("busy", "busy-1");
			const reviving = client.resumeThread("busy");
			await answer(f, "thread/resume", {}, 0);
			await reviving;
			await retire("busy", "busy-2");

			// Enough to shift the FIRST park's entry, which must not spend the record's second window.
			for (let index = 0; index < RETIRED_MEMORY - 1; index += 1)
				await retire(`spare-${index}`, `spare-${index}`);

			expect(client.stateOf("busy")).toMatchObject({ phase: "parked" });
			// The record still holds its first turn, so a late duplicate does not report again.
			await client.settleTurn("busy", "busy-1", DONE);
			expect(published.filter((turnId) => turnId === "busy-1")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a record whose work is still in flight when its retirement comes up", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			let archives = 0;
			const retire = async (threadId: string) => {
				const settling = client.settleTurn(threadId, `${threadId}-turn`, DONE);
				await answer(f, "thread/archive", {}, archives);
				archives += 1;
				await settling;
			};

			await retire("held");
			// Unanswered, so the record still has work outstanding when its entry is shifted off.
			const reading = client.readThread("held");
			await requested(f, "thread/read");

			for (let index = 0; index < RETIRED_MEMORY; index += 1) await retire(`spare-${index}`);

			expect(client.stateOf("held")).toMatchObject({ phase: "parked" });

			await answer(f, "thread/read", readOf("held", []));
			await reading;
		} finally {
			vi.useRealTimers();
		}
	});

	it("publishes the terminal before the archive request leaves, and only once for two observers", async () => {
		vi.useFakeTimers();
		try {
			const seen: string[] = [];
			const { f, client } = await openLifecycle({ onTerminal: () => seen.push("terminal") });
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;

			const first = client.settleTurn(THREAD, TURN, DONE);
			const second = client.settleTurn(THREAD, TURN, DONE);
			await requested(f, "thread/archive");
			expect(seen).toEqual(["terminal"]);
			await answer(f, "thread/archive", {});
			await Promise.all([first, second]);

			expect(seen).toEqual(["terminal"]);
			expect(methods(f).filter((m) => m === "thread/archive")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("runs a follow-up that arrives during the archive after it, resuming the parked thread first", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			const settling = client.settleTurn(THREAD, TURN, DONE);
			await requested(f, "thread/archive");

			const followup = client.startTurn(THREAD, "again", noteTurn);
			await tick();
			expect(methods(f).filter((m) => m === "thread/resume")).toHaveLength(0);
			await answer(f, "thread/archive", {});
			await settling;
			await answer(f, "thread/resume", {});
			await answer(f, "turn/start", { turn: { id: "turn-2", status: "inProgress", items: [] } }, 1);

			expect(await followup).toBe("turn-2");
			expect(methods(f).slice(-3)).toEqual(["thread/archive", "thread/resume", "turn/start"]);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "active", turnId: "turn-2" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("poisons the generation when the archive reply never comes, and refuses the thread afterwards", async () => {
		vi.useFakeTimers();
		try {
			const poisoned: unknown[] = [];
			const { f, client } = await openLifecycle({ onPoisoned: (...args) => poisoned.push(args) });
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			const settling = client.settleTurn(THREAD, TURN, DONE).catch((error) => error);
			await requested(f, "thread/archive");
			await vi.advanceTimersByTimeAsync(60_000);

			expect(await settling).toMatchObject({ kind: "timeout" });
			expect(poisoned).toEqual([
				[THREAD, { kind: "failure", failure: expect.objectContaining({ kind: "timeout" }) }],
			]);
			await expect(client.startTurn(THREAD, "more", noteTurn)).rejects.toThrow("poisoned");
			expect(methods(f).filter((m) => m === "thread/resume" || m === "turn/start")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("adopts a running turn the read shows when the archive is refused", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			const settling = client.settleTurn(THREAD, TURN, DONE);
			await refuse(f, "thread/archive", "no rollout found for thread id");
			await answer(f, "thread/read", readOf(THREAD, [{ id: "turn-9", status: "inProgress", items: [] }]));
			await settling;

			expect((await requested(f, "thread/read")).params).toEqual({ threadId: THREAD, includeTurns: true });
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "active", turnId: "turn-9" });
			expect(methods(f)).not.toContain("thread/delete");
		} finally {
			vi.useRealTimers();
		}
	});

	it("deletes a thread two quiet reads prove empty when the archive is refused", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			const settling = client.settleTurn(THREAD, TURN, DONE);
			await refuse(f, "thread/archive", "no rollout found for thread id");
			await answer(f, "thread/read", readOf(THREAD, []));
			expect(methods(f)).not.toContain("thread/delete");
			await vi.advanceTimersByTimeAsync(DISPOSE_QUIET_MS);
			await answer(f, "thread/read", readOf(THREAD, []), 1);
			await answer(f, "thread/delete", {});
			await settling;

			expect((await requested(f, "thread/delete")).params).toEqual({ threadId: THREAD });
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "disposed" });
			await expect(client.startTurn(THREAD, "more", noteTurn)).rejects.toThrow("disposed");
		} finally {
			vi.useRealTimers();
		}
	});

	it("never deletes on an unknown read, retries the park on a timer, and gives up on the generation", async () => {
		vi.useFakeTimers();
		try {
			const poisoned: unknown[] = [];
			const { f, client } = await openLifecycle({ onPoisoned: (...args) => poisoned.push(args) });
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			const settling = client.settleTurn(THREAD, TURN, DONE);

			for (let attempt = 0; attempt < 3; attempt += 1) {
				await refuse(f, "thread/archive", "no rollout found for thread id", attempt);
				// A read naming another thread is an answer the lifecycle cannot use.
				await answer(f, "thread/read", readOf("someone-else", []), attempt);
				if (attempt < 2) {
					expect(client.stateOf(THREAD)).toMatchObject({ phase: "parking" });
					await vi.advanceTimersByTimeAsync(PARK_RETRY_MS);
				}
			}
			await settling;

			expect(methods(f)).not.toContain("thread/delete");
			expect(poisoned).toEqual([[THREAD, { kind: "exhausted", attempts: 3 }]]);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "poisoned" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("drops a park retry once a follow-up has moved the thread on", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			const settling = client.settleTurn(THREAD, TURN, DONE);
			await refuse(f, "thread/archive", "no rollout found for thread id");
			await answer(f, "thread/read", readOf("someone-else", []));
			await settling;
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "parking" });

			// Still loaded while parking, so the follow-up needs no resume, only the retry dropped.
			const followup = client.startTurn(THREAD, "again", noteTurn);
			await answer(f, "turn/start", { turn: { id: "turn-2", status: "inProgress", items: [] } }, 1);
			expect(await followup).toBe("turn-2");
			await vi.advanceTimersByTimeAsync(PARK_RETRY_MS * 2);

			expect(methods(f)).not.toContain("thread/resume");
			expect(methods(f).filter((m) => m === "thread/archive")).toHaveLength(1);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "active", turnId: "turn-2" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("unarchives a parked thread when its resume is refused, then resumes and starts the turn", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await parked();
			const followup = client.startTurn(THREAD, "again", noteTurn);
			await refuse(f, "thread/resume", "session is archived. Run `codex unarchive` first.");
			await answer(f, "thread/unarchive", {});
			await answer(f, "thread/resume", {}, 1);
			await answer(f, "turn/start", { turn: { id: "turn-2", status: "inProgress", items: [] } }, 1);

			expect(await followup).toBe("turn-2");
			expect((await requested(f, "thread/unarchive")).params).toEqual({ threadId: THREAD });
			expect(methods(f).slice(-4)).toEqual(["thread/resume", "thread/unarchive", "thread/resume", "turn/start"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("surfaces the resume failure, not the unarchive's, when both are refused", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await parked();
			const followup = client.startTurn(THREAD, "again", noteTurn).catch((error) => error);
			await refuse(f, "thread/resume", "resume said no");
			await refuse(f, "thread/unarchive", "unarchive said no");

			const failure = await followup;
			expect(isAppServerFailure(failure)).toBe(true);
			expect(failure).toMatchObject({ kind: "refused", message: "resume said no" });
			expect(methods(f).filter((m) => m === "turn/start")).toHaveLength(1);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "parked" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses a control only for another turn it knows is active, and lets the server arbitrate the rest", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			// Idle here, and a thread never loaded here: both are the server's call, as after a daemon restart.
			const idle = client.steerTurn(THREAD, "turn-old", "carry on");
			await answer(f, "turn/steer", { turnId: "turn-old" });
			await idle;
			const inherited = client.interruptTurn("thread-inherited", "turn-old");
			await answer(f, "turn/interrupt", {});
			await inherited;
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;

			await expect(client.steerTurn(THREAD, "turn-other", "wrong")).rejects.toThrow("no active turn");
			await expect(client.interruptTurn(THREAD, "turn-other")).rejects.toThrow("no active turn");
			const steering = client.steerTurn(THREAD, TURN, "more");
			await answer(f, "turn/steer", { turnId: TURN }, 1);
			await steering;
			const interrupting = client.interruptTurn(THREAD, TURN);
			await answer(f, "turn/interrupt", {}, 1);
			await interrupting;

			expect(methods(f).filter((m) => m === "turn/steer" || m === "turn/interrupt")).toEqual([
				"turn/steer",
				"turn/interrupt",
				"turn/steer",
				"turn/interrupt",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("publishes a terminal for a turn it does not own without parking, and parks its own", async () => {
		vi.useFakeTimers();
		try {
			const terminals: unknown[] = [];
			const { f, client } = await openLifecycle({ onTerminal: (...args) => terminals.push(args) });
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;

			await client.settleTurn(THREAD, "turn-other", DONE);
			await client.settleTurn(THREAD, "turn-other", DONE);
			expect(terminals).toEqual([[THREAD, "turn-other", DONE]]);
			expect(methods(f)).not.toContain("thread/archive");
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "active", turnId: TURN });

			const settling = client.settleTurn(THREAD, TURN, DONE);
			await answer(f, "thread/archive", {});
			await settling;
			expect(terminals).toHaveLength(2);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "parked" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("parks an idle thread whose turn it never started when that turn's terminal arrives", async () => {
		vi.useFakeTimers();
		try {
			const terminals: unknown[] = [];
			const { f, client } = await openLifecycle({ onTerminal: (...args) => terminals.push(args) });

			const settling = client.settleTurn(THREAD, "turn-inherited", DONE);
			await answer(f, "thread/archive", {});
			await settling;

			expect(terminals).toEqual([[THREAD, "turn-inherited", DONE]]);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "parked" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a read in the thread's queue, behind a turn/start still in flight", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await requested(f, "turn/start");
			const reading = client.readThread(THREAD);
			await tick();
			expect(methods(f)).not.toContain("thread/read");

			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			await answer(f, "thread/read", readOf(THREAD, [{ id: TURN, status: "inProgress", items: [] }]));
			expect(await reading).toEqual(readOf(THREAD, [{ id: TURN, status: "inProgress", items: [] }]));
		} finally {
			vi.useRealTimers();
		}
	});

	it("resumes a thread it only knows by name, and nothing for one it already loaded", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			await client.resumeThread(THREAD);
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			await client.resumeThread(THREAD);
			expect(methods(f)).not.toContain("thread/resume");
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "active", turnId: TURN });

			const inherited = client.resumeThread("thread-inherited");
			await answer(f, "thread/resume", {});
			await inherited;
			expect((await requested(f, "thread/resume")).params).toEqual({ threadId: "thread-inherited" });
			expect(client.stateOf("thread-inherited")).toMatchObject({ phase: "idle" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("publishes a terminal buffered under a start that was refused, and parks the thread it left idle", async () => {
		vi.useFakeTimers();
		try {
			const terminals: unknown[] = [];
			const { f, client } = await openLifecycle({ onTerminal: (...args) => terminals.push(args) });
			const turn = client.startTurn(THREAD, "go", noteTurn).catch((error) => error);
			await requested(f, "turn/start");
			await client.settleTurn(THREAD, "turn-other", DONE);
			await refuse(f, "turn/start", "no capacity");
			await answer(f, "thread/archive", {});

			expect(await turn).toMatchObject({ kind: "refused" });
			expect(terminals).toEqual([[THREAD, "turn-other", DONE]]);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "parked" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("takes a started thread as new whatever it knew of that id, and drops the old record's retry", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			// Left parking with a retry pending, which must not reach the thread the server starts next.
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			const settling = client.settleTurn(THREAD, TURN, DONE);
			await refuse(f, "thread/archive", "no rollout found for thread id");
			await answer(f, "thread/read", readOf("someone-else", []));
			await settling;
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "parking" });

			const starting = client.startThread({ cwd: "/tmp" });
			await answer(f, "thread/start", { thread: { id: THREAD } }, 1);
			expect(await starting).toBe(THREAD);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "idle" });

			await vi.advanceTimersByTimeAsync(PARK_RETRY_MS * 2);
			expect(methods(f).filter((m) => m === "thread/archive")).toHaveLength(1);

			// Loaded, so its first turn needs no resume.
			const next = client.startTurn(THREAD, "again", noteTurn);
			await answer(f, "turn/start", { turn: { id: "turn-2", status: "inProgress", items: [] } }, 1);
			expect(await next).toBe("turn-2");
			expect(methods(f)).not.toContain("thread/resume");
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops an operation the replaced thread left in flight, so its delete cannot reach the new one", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			// Paused between the two reads of the dispose rule when the server hands the id back.
			const settling = client.settleTurn(THREAD, TURN, DONE).catch((error) => error);
			await refuse(f, "thread/archive", "no rollout found for thread id");
			await answer(f, "thread/read", readOf(THREAD, []));

			const starting = client.startThread({ cwd: "/tmp" });
			await answer(f, "thread/start", { thread: { id: THREAD } }, 1);
			expect(await starting).toBe(THREAD);
			await vi.advanceTimersByTimeAsync(DISPOSE_QUIET_MS * 2);

			expect(await settling).toMatchObject({ message: expect.stringContaining("replaced") });
			expect(methods(f)).not.toContain("thread/delete");
			expect(methods(f).filter((m) => m === "thread/read")).toHaveLength(1);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "idle" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("tracks a thread it hears of only through a terminal, publishing and parking it", async () => {
		vi.useFakeTimers();
		try {
			const terminals: unknown[] = [];
			const { f, client } = await openLifecycle({ onTerminal: (...args) => terminals.push(args) });

			const settling = client.settleTurn("thread-inherited", "turn-old", DONE);
			await answer(f, "thread/archive", {});
			await settling;

			expect(terminals).toEqual([["thread-inherited", "turn-old", DONE]]);
			expect((await requested(f, "thread/archive")).params).toEqual({ threadId: "thread-inherited" });
			expect(client.stateOf("thread-inherited")).toMatchObject({ phase: "parked" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses a read of a thread it disposed, rather than asking about one that is gone", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			const empty = client.adoptOrDispose(THREAD);
			await answer(f, "thread/read", readOf(THREAD, []));
			await vi.advanceTimersByTimeAsync(DISPOSE_QUIET_MS);
			await answer(f, "thread/read", readOf(THREAD, []), 1);
			await answer(f, "thread/delete", {});
			await empty;

			await expect(client.readThread(THREAD)).rejects.toThrow("disposed");
			expect(methods(f).filter((m) => m === "thread/read")).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("budgets a refused delete like any other park that did not happen", async () => {
		vi.useFakeTimers();
		try {
			const poisoned: unknown[] = [];
			const { f, client } = await openLifecycle({ onPoisoned: (...args) => poisoned.push(args) });
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			await turn;
			const settling = client.settleTurn(THREAD, TURN, DONE);

			for (let attempt = 0; attempt < 3; attempt += 1) {
				await refuse(f, "thread/archive", "no rollout found for thread id", attempt);
				await answer(f, "thread/read", readOf(THREAD, []), attempt * 2);
				await vi.advanceTimersByTimeAsync(DISPOSE_QUIET_MS);
				await answer(f, "thread/read", readOf(THREAD, []), attempt * 2 + 1);
				await refuse(f, "thread/delete", "delete said no", attempt);
				if (attempt < 2) await vi.advanceTimersByTimeAsync(PARK_RETRY_MS);
			}
			await settling;

			expect(poisoned).toEqual([[THREAD, { kind: "exhausted", attempts: 3 }]]);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "poisoned" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("serializes a steer and an interrupt on a thread it only knows by name", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			const steering = client.steerTurn("thread-inherited", "turn-old", "carry on");
			const interrupting = client.interruptTurn("thread-inherited", "turn-old");
			await tick();
			expect(methods(f)).not.toContain("turn/interrupt");

			await answer(f, "turn/steer", { turnId: "turn-old" });
			await steering;
			await answer(f, "turn/interrupt", {});
			await interrupting;

			expect(methods(f).slice(-2)).toEqual(["turn/steer", "turn/interrupt"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("publishes a terminal buffered under another id once the start resolves, without parking", async () => {
		vi.useFakeTimers();
		try {
			const terminals: unknown[] = [];
			const { f, client } = await openLifecycle({ onTerminal: (...args) => terminals.push(args) });
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await requested(f, "turn/start");
			await client.settleTurn(THREAD, "turn-other", DONE);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });

			expect(await turn).toBe(TURN);
			expect(terminals).toEqual([[THREAD, "turn-other", DONE]]);
			expect(methods(f)).not.toContain("thread/archive");
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "active", turnId: TURN });
		} finally {
			vi.useRealTimers();
		}
	});

	it("publishes once when two observers report the turn, one before and one after the start reply", async () => {
		vi.useFakeTimers();
		try {
			const terminals: unknown[] = [];
			const { f, client } = await openLifecycle({ onTerminal: (...args) => terminals.push(args) });
			const turn = client.startTurn(THREAD, "go", noteTurn);
			await requested(f, "turn/start");
			await client.settleTurn(THREAD, TURN, DONE);
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			const second = client.settleTurn(THREAD, TURN, DONE);
			await answer(f, "thread/archive", {});
			await turn;
			await second;

			expect(terminals).toEqual([[THREAD, TURN, DONE]]);
			expect(methods(f).filter((m) => m === "thread/archive")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("poisons the thread when a read never answers, so a doubtful thread is not adopted on guesswork", async () => {
		vi.useFakeTimers();
		try {
			const poisoned: unknown[] = [];
			const { f, client } = await openLifecycle({ onPoisoned: (...args) => poisoned.push(args) });
			const adopting = client.adoptOrDispose(THREAD).catch((error) => error);
			await requested(f, "thread/read");
			await vi.advanceTimersByTimeAsync(60_000);

			expect(await adopting).toMatchObject({ kind: "timeout" });
			expect(poisoned).toEqual([
				[THREAD, { kind: "failure", failure: expect.objectContaining({ kind: "timeout" }) }],
			]);
			expect(methods(f)).not.toContain("thread/delete");
		} finally {
			vi.useRealTimers();
		}
	});

	it("releases an operation paused between its two reads when the client closes", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();
			const adopting = client.adoptOrDispose(THREAD).catch((error) => error);
			await answer(f, "thread/read", readOf(THREAD, []));
			client.close();
			await tick();

			expect(await adopting).toMatchObject({ kind: "closed" });
			expect(methods(f)).not.toContain("thread/delete");
		} finally {
			vi.useRealTimers();
		}
	});

	it("adopts what a doubtful thread holds: a running turn becomes ours, a settled one is settled", async () => {
		vi.useFakeTimers();
		try {
			const terminals: unknown[] = [];
			const { f, client } = await openLifecycle({ onTerminal: (...args) => terminals.push(args) });

			const running = client.adoptOrDispose(THREAD);
			await answer(f, "thread/read", readOf(THREAD, [{ id: "turn-r", status: "inProgress", items: [] }]));
			expect(await running).toEqual({ known: "running", turnId: "turn-r" });
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "active", turnId: "turn-r" });

			const settled = client.adoptOrDispose(THREAD);
			await answer(
				f,
				"thread/read",
				readOf(THREAD, [
					{
						id: "turn-s",
						status: "completed",
						items: [{ type: "agentMessage", id: "item-1", text: "done", phase: "final_answer" }],
					},
				]),
				1,
			);
			await answer(f, "thread/archive", {});
			expect(await settled).toMatchObject({ known: "settled", turnId: "turn-s" });
			expect(terminals).toEqual([
				[THREAD, "turn-s", { status: "completed", finalResponse: "done", finalItemId: "item-1" }],
			]);
			expect(client.stateOf(THREAD)).toMatchObject({ phase: "parked" });

			// Adopting again what was already settled here publishes nothing and archives nothing.
			const again = client.adoptOrDispose(THREAD);
			await answer(
				f,
				"thread/read",
				readOf(THREAD, [
					{
						id: "turn-s",
						status: "completed",
						items: [{ type: "agentMessage", id: "item-1", text: "done", phase: "final_answer" }],
					},
				]),
				2,
			);
			expect(await again).toMatchObject({ known: "settled", turnId: "turn-s" });
			expect(terminals).toHaveLength(1);
			expect(methods(f).filter((m) => m === "thread/archive")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("disposes of a doubtful thread only after two quiet reads prove it empty, and leaves an unknown one alone", async () => {
		vi.useFakeTimers();
		try {
			const { f, client } = await openLifecycle();

			const unknown = client.adoptOrDispose(THREAD);
			await answer(f, "thread/read", readOf("someone-else", []));
			expect(await unknown).toEqual({ known: "unknown" });
			await vi.advanceTimersByTimeAsync(DISPOSE_QUIET_MS * 2);
			expect(methods(f).slice(-1)).toEqual(["thread/read"]);

			const empty = client.adoptOrDispose(THREAD);
			await answer(f, "thread/read", readOf(THREAD, []), 1);
			await vi.advanceTimersByTimeAsync(DISPOSE_QUIET_MS);
			await answer(f, "thread/read", readOf(THREAD, []), 2);
			await answer(f, "thread/delete", {});
			expect(await empty).toEqual({ known: "empty" });
			await expect(client.startTurn(THREAD, "more", noteTurn)).rejects.toThrow("disposed");
			expect(methods(f).filter((m) => m === "turn/start")).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
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
