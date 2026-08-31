import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { CodexChild } from "../mcp/devcontainer/codexTargets.js";
import { CodexLocalSession } from "../mcp/local/codexLocalSession.js";
import { CODEX_DEFAULT_MODEL } from "../shared/codexAgentIdentity.js";

////////////////////////////////
//  Functions & Helpers

const THREAD = "thread-1";
const OTHER_THREAD = "thread-2";
const TURN = "turn-1";

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
		sent: () => written.map((line) => JSON.parse(line)),
		methods: () => written.map((line) => JSON.parse(line).method as string),
		feed: (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`),
		exit: () => onExit({ code: 1, signal: null }),
	};
}

type Fake = ReturnType<typeof fakeChild>;

/** Flushes the pipe and the microtasks behind it under fake timers. */
const tick = () => vi.advanceTimersByTimeAsync(1);

async function requested(f: Fake, method: string, nth = 0) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const hits = f.sent().filter((message) => message.method === method);
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

function itemCompleted(threadId: string, turnId: string, text: string) {
	return {
		method: "item/completed",
		params: { threadId, turnId, item: { type: "agentMessage", id: "item-1", text, phase: "final_answer" } },
	};
}

function commentary(threadId: string, turnId: string, text: string) {
	return {
		method: "item/completed",
		params: { threadId, turnId, item: { type: "agentMessage", id: `note-${text}`, text, phase: "commentary" } },
	};
}

function turnCompleted(threadId: string, turnId: string) {
	return {
		method: "turn/completed",
		params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } },
	};
}

/** The real client and transport over a fake child, so the session drives what the daemon drives. */
async function openSession() {
	const f = fakeChild();
	const opening = CodexLocalSession.open(f.child);
	await answer(f, "initialize", {});
	await answer(f, "model/list", { data: [{ id: CODEX_DEFAULT_MODEL }] });
	const session = await opening;
	return { f, session };
}

async function running() {
	const opened = await openSession();
	const thread = opened.session.openThread({ cwd: "/tmp" });
	await answer(opened.f, "thread/start", { thread: { id: THREAD } });
	expect(await thread).toBe(THREAD);
	const turn = opened.session.startTurn(THREAD, "go");
	await answer(opened.f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
	return { ...opened, handle: await turn };
}

////////////////////////////////
//  Tests

describe("a local Codex turn settles through the thread lifecycle owner", () => {
	it("resolves the parked handle and parks the thread behind it", async () => {
		vi.useFakeTimers();
		try {
			const { f, handle } = await running();

			f.feed(itemCompleted(THREAD, TURN, "the answer"));
			f.feed(turnCompleted(THREAD, TURN));
			await tick();

			expect(await handle.settled).toMatchObject({ status: "completed", finalResponse: "the answer" });
			// Through the owner, so the thread's MCP servers die with it rather than outliving the turn.
			await requested(f, "thread/archive");
		} finally {
			vi.useRealTimers();
		}
	});

	it("answers each of two threads' turns with its own outcome", async () => {
		vi.useFakeTimers();
		try {
			const { f, session, handle } = await running();
			const second = session.openThread({ cwd: "/tmp" });
			await answer(f, "thread/start", { thread: { id: OTHER_THREAD } }, 1);
			expect(await second).toBe(OTHER_THREAD);
			const other = session.startTurn(OTHER_THREAD, "go too");
			await answer(f, "turn/start", { turn: { id: "turn-2", status: "inProgress", items: [] } }, 1);
			const otherHandle = await other;

			let first: unknown;
			void handle.settled.then((terminal) => {
				first = terminal;
			});
			f.feed(itemCompleted(OTHER_THREAD, "turn-2", "the second answer"));
			f.feed(turnCompleted(OTHER_THREAD, "turn-2"));
			await tick();

			expect(await otherHandle.settled).toMatchObject({ finalResponse: "the second answer" });
			expect(first).toBeUndefined();

			f.feed(itemCompleted(THREAD, TURN, "the first answer"));
			f.feed(turnCompleted(THREAD, TURN));
			await tick();

			expect(await handle.settled).toMatchObject({ finalResponse: "the first answer" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("resumes a parked thread for a follow-up rather than starting a turn on an unloaded one", async () => {
		vi.useFakeTimers();
		try {
			const { f, session, handle } = await running();
			f.feed(itemCompleted(THREAD, TURN, "first"));
			f.feed(turnCompleted(THREAD, TURN));
			await tick();
			await handle.settled;
			await answer(f, "thread/archive", {});

			const followUp = session.startTurn(THREAD, "again");
			await answer(f, "thread/resume", {});
			await answer(f, "turn/start", { turn: { id: "turn-2", status: "inProgress", items: [] } }, 1);
			const second = await followUp;
			expect(second.turnId).toBe("turn-2");

			f.feed(itemCompleted(THREAD, "turn-2", "second answer"));
			f.feed(turnCompleted(THREAD, "turn-2"));
			await tick();

			// The resumed turn settles and parks like the first, rather than only starting.
			expect(await second.settled).toMatchObject({ finalResponse: "second answer" });
			await requested(f, "thread/archive", 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("answers a turn whose terminal beat its own start reply", async () => {
		vi.useFakeTimers();
		try {
			const { f, session } = await openSession();
			const thread = session.openThread({ cwd: "/tmp" });
			await answer(f, "thread/start", { thread: { id: THREAD } });
			await thread;

			const turn = session.startTurn(THREAD, "go");
			await requested(f, "turn/start");
			// The whole turn arrives on the event stream before the request is answered.
			f.feed(itemCompleted(THREAD, TURN, "beat the reply"));
			f.feed(turnCompleted(THREAD, TURN));
			await tick();
			await answer(f, "turn/start", { turn: { id: TURN, status: "inProgress", items: [] } });
			// The drained terminal is the new turn's own, so the owner parks the thread before returning.
			await answer(f, "thread/archive", {});

			const handle = await turn;
			let answered: unknown;
			void handle.settled.then((terminal) => {
				answered = terminal;
			});
			await tick();

			// The owner drains a buffered terminal before it returns the id, so nothing is parked yet.
			expect(answered).toMatchObject({ status: "completed", finalResponse: "beat the reply" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("holds a terminal that lands while a follow-up is still starting", async () => {
		vi.useFakeTimers();
		try {
			const { f, session, handle } = await running();

			// The turn ends while the caller's next prompt is mid-flight on the same thread.
			const followUp = session.startTurn(THREAD, "again");
			f.feed(itemCompleted(THREAD, TURN, "first answer"));
			f.feed(turnCompleted(THREAD, TURN));
			await tick();

			await answer(f, "turn/start", { turn: { id: "turn-2", status: "inProgress", items: [] } }, 1);
			const second = await followUp;

			// Held by the owner until the start has its id, then drained, so the race loses no answer.
			expect(await handle.settled).toMatchObject({ finalResponse: "first answer" });

			f.feed(itemCompleted(THREAD, "turn-2", "second answer"));
			f.feed(turnCompleted(THREAD, "turn-2"));
			await tick();

			expect(await second.settled).toMatchObject({ finalResponse: "second answer" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles every parked turn as failed when the child exits", async () => {
		vi.useFakeTimers();
		try {
			const { f, handle } = await running();

			f.exit();
			await tick();

			expect(await handle.settled).toMatchObject({ status: "failed" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("delivers no activity once it has closed", async () => {
		vi.useFakeTimers();
		try {
			const { f, session } = await running();
			const seen: string[] = [];
			session.onActivity((_turnId, text) => seen.push(text));

			f.feed(commentary(THREAD, TURN, "before"));
			await tick();
			session.close();
			f.feed(commentary(THREAD, TURN, "after"));
			await tick();

			expect(seen).toEqual(["before"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports itself closed when the owner cannot learn a request's fate", async () => {
		vi.useFakeTimers();
		try {
			const { f, session, handle } = await running();
			let closed = false;
			session.onClosed(() => {
				closed = true;
			});

			f.feed(itemCompleted(THREAD, TURN, "done"));
			f.feed(turnCompleted(THREAD, TURN));
			await tick();
			await handle.settled;
			// No archive is ever answered.
			await vi.advanceTimersByTimeAsync(120_000);

			// The runtime evicts on this, so a cached dead child cannot outlive its generation.
			expect(closed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
