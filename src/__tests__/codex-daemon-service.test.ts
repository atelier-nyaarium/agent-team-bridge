import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexDaemonService, resolveAgentTarget } from "../mcp/devcontainer/codexDaemonService.js";
import type { CodexChild, TargetAvailability, TargetSupervisor } from "../mcp/devcontainer/codexTargets.js";
import type { CodexResolvedTarget } from "../shared/codex-agent.js";
import { CODEX_DEFAULT_MODEL, CodexDaemonEventSchema, CodexDaemonReceiptSchema } from "../shared/codex-agent.js";

const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const TARGET_ID = "container:recipe-app";
const REAP_QUIET = 900_000;
const RESOLVED_TARGET: CodexResolvedTarget = {
	kind: "devcontainer",
	targetId: TARGET_ID,
	cwd: "/workspace/recipe-app",
};
type Request = Record<string, unknown>;
type Item = { id: string; text: string; phase?: string };

function reply(request: Request, result: unknown) {
	return { jsonrpc: "2.0", id: request.id as number, result };
}

function errorReply(request: Request, message: string) {
	return { jsonrpc: "2.0", id: request.id as number, error: { code: -1, message } };
}

function scripted() {
	const stdout = new PassThrough();
	const requests: Request[] = [];
	let nextTurn = 1;
	let readResult: unknown = { thread: { id: "thread-1", turns: [] } };
	let turnStartError: string | undefined;
	let steerError: string | undefined;
	let interruptError: string | undefined;
	let archiveError: string | undefined;
	let unreadableRead = false;
	let blockedRead: Request | undefined;
	let blockedSteer: Request | undefined;
	let blockedInitialize = false;
	let initializeRelease: (() => void) | undefined;
	let exited = false;
	let onExit: (info: { code: number | null; signal: string | null }) => void = () => {};
	const emit = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
	const child = {
		stdin: new Writable({
			write(chunk: Buffer, _encoding, callback) {
				const request = JSON.parse(String(chunk)) as Request;
				requests.push(request);
				switch (request.method) {
					case "initialize":
						if (blockedInitialize) initializeRelease = () => emit(reply(request, {}));
						else emit(reply(request, {}));
						break;
					case "initialized":
						break;
					case "model/list":
						emit(reply(request, { data: [{ id: CODEX_DEFAULT_MODEL }] }));
						break;
					case "thread/start":
						emit(reply(request, { thread: { id: "thread-1" } }));
						break;
					case "thread/read":
						if (blockedRead) blockedRead = request;
						else if (unreadableRead) emit({ jsonrpc: "2.0", id: request.id, result: {}, error: null });
						else emit(reply(request, readResult));
						break;
					case "thread/resume":
					case "thread/unarchive":
					case "thread/delete":
						emit(reply(request, {}));
						break;
					case "thread/archive":
						emit(archiveError ? errorReply(request, archiveError) : reply(request, {}));
						break;
					case "turn/start":
						if (turnStartError) emit(errorReply(request, turnStartError));
						else
							emit(
								reply(request, { turn: { id: `turn-${nextTurn++}`, status: "inProgress", items: [] } }),
							);
						break;
					case "turn/steer":
						if (blockedSteer) blockedSteer = request;
						else if (steerError) emit(errorReply(request, steerError));
						else emit(reply(request, {}));
						break;
					default:
						if (request.method === "turn/interrupt" && interruptError)
							emit(errorReply(request, interruptError));
						else emit(reply(request, {}));
				}
				callback();
			},
		}),
		stdout,
		kill: () => {
			if (!exited) {
				exited = true;
				onExit({ code: 1, signal: null });
			}
		},
		onExit(listener: (info: { code: number | null; signal: string | null }) => void) {
			onExit = listener;
		},
	} as unknown as CodexChild;
	return {
		child,
		requests,
		emit,
		setRead(value: unknown) {
			readResult = value;
		},
		failStart(message = "start failed") {
			turnStartError = message;
		},
		failSteer(message = "steer failed") {
			steerError = message;
		},
		failInterrupt(message = "turn ended") {
			interruptError = message;
		},
		blockSteer() {
			blockedSteer = {};
		},
		releaseSteer() {
			const request = blockedSteer;
			blockedSteer = undefined;
			if (request) emit(steerError ? errorReply(request, steerError) : reply(request, {}));
		},
		failArchive(message = "archive failed") {
			archiveError = message;
		},
		failRead() {
			unreadableRead = true;
		},
		blockInitialize() {
			blockedInitialize = true;
		},
		exit() {
			if (!exited) {
				exited = true;
				onExit({ code: 1, signal: null });
			}
		},
		releaseInitialize() {
			blockedInitialize = false;
			initializeRelease?.();
			initializeRelease = undefined;
		},
		blockNextRead() {
			blockedRead = {};
		},
		releaseRead() {
			const request = blockedRead;
			blockedRead = undefined;
			if (request) emit(reply(request, readResult));
		},
	};
}

function item(threadId: string, turnId: string, value: Item) {
	return { method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", ...value } } };
}

function terminal(threadId: string, turnId: string, status = "completed") {
	return { method: "turn/completed", params: { threadId, turn: { id: turnId, status } } };
}

function read(threadId: string, turns: unknown[]) {
	return { thread: { id: threadId, turns } };
}

function startCommand(overrides: Record<string, unknown> = {}) {
	return {
		type: "codex_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Audit the parser",
		...overrides,
	};
}

function reconcile(threadId: string, turnId?: string) {
	return {
		type: "codex_command",
		kind: "reconcile",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		target: RESOLVED_TARGET,
		threadId,
		...(turnId ? { turnId } : {}),
	};
}

function message(threadId: string, prompt: string, turnId?: string) {
	return {
		type: "codex_command",
		kind: "message",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: "123e4567-e89b-42d3-a456-426614174002",
		target: RESOLVED_TARGET,
		threadId,
		prompt,
		...(turnId ? { expectedTurnId: turnId } : {}),
	};
}

function setup(options: { availability?: TargetAvailability } = {}) {
	const app = scripted();
	const apps = new Map([[3, app]]);
	const sent: Record<string, unknown>[] = [];
	const released: Array<{ targetId: string; generation: number }> = [];
	const acquired: number[] = [];
	let generation = 3;
	const targets: TargetSupervisor = {
		acquire: () => {
			if (options.availability) return options.availability;
			acquired.push(generation);
			const current = apps.get(generation) ?? scripted();
			apps.set(generation, current);
			return { state: "running", lease: { generation, child: current.child } };
		},
		release: (targetId, oldGeneration) => {
			if (oldGeneration !== generation) return;
			released.push({ targetId, generation: oldGeneration });
			generation += 1;
		},
	};
	const timers: Array<{ run: () => void; cleared: boolean }> = [];
	const sweeps: Array<() => void> = [];
	let clock = 1_000_000;
	const service = new CodexDaemonService({
		targets,
		daemonInstanceId: "daemon-1",
		send: (frame) => sent.push(frame),
		resolveHostCwd: () => "/home/agent",
		now: () => clock,
		setTimer: (run) => {
			const timer = { run, cleared: false };
			timers.push(timer);
			return (timers.length - 1) as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (handle) => {
			const timer = timers[handle as unknown as number];
			if (timer) timer.cleared = true;
		},
		setSweep: (run) => {
			sweeps.push(run);
			return sweeps.length as unknown as ReturnType<typeof setInterval>;
		},
		clearSweep: () => sweeps.splice(0),
	});
	const fireDeadlines = async () => {
		for (const timer of timers.filter((entry) => !entry.cleared)) {
			timer.cleared = true;
			timer.run();
		}
		await settle();
	};
	const sweep = async (byMs = 0) => {
		clock += byMs;
		for (const run of [...sweeps]) run();
		await settle();
	};
	return {
		app,
		apps,
		service,
		sent,
		released,
		acquired,
		timers,
		fireDeadlines,
		sweep,
		advance: (ms: number) => (clock += ms),
	};
}

async function settle() {
	for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

function events(sent: Record<string, unknown>[]) {
	return sent.filter((frame) => frame.type === "codex_event").map((frame) => CodexDaemonEventSchema.parse(frame));
}

function receipts(sent: Record<string, unknown>[]) {
	return sent.filter((frame) => frame.type === "codex_receipt").map((frame) => CodexDaemonReceiptSchema.parse(frame));
}

describe("Codex execution targets", () => {
	it("resolves host hints and container workspaces", () => {
		expect(resolveAgentTarget({ kind: "host", workdirHint: "Codex Support" }, () => "/home/agent")).toEqual({
			kind: "host",
			targetId: "host",
			cwd: "/home/agent",
		});
		expect(
			resolveAgentTarget(
				{ kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
				() => {
					throw new Error("not called");
				},
			),
		).toEqual(RESOLVED_TARGET);
	});

	it("refuses unavailable targets without retaining the refusal", async () => {
		const context = setup({ availability: { state: "unavailable", errorClass: "noSuchContainer" } });
		context.service.handleCommand(startCommand());
		await settle();
		expect(receipts(context.sent)).toMatchObject([{ kind: "rejected", agentId: AGENT_ID }]);
		context.sent.length = 0;
		context.service.replay();
		expect(context.sent).toEqual([]);
	});
});

describe("Codex answer selection", () => {
	it("uses final answers for live and rebuilt turns", async () => {
		const live = setup();
		live.service.handleCommand(startCommand());
		await settle();
		live.sent.length = 0;
		live.app.emit(item("thread-1", "turn-1", { id: "a", text: "thinking", phase: "commentary" }));
		live.app.emit(item("thread-1", "turn-1", { id: "b", text: "THE ANSWER", phase: "final_answer" }));
		live.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		expect(events(live.sent).at(-1)).toMatchObject({ state: "completed", finalResponse: "THE ANSWER" });

		const rebuilt = setup();
		rebuilt.app.setRead(
			read("thread-1", [
				{
					id: "turn-1",
					status: "completed",
					items: [{ type: "agentMessage", id: "b", text: "THE ANSWER", phase: "final_answer" }],
				},
			]),
		);
		rebuilt.service.handleCommand(reconcile("thread-1", "turn-1"));
		await settle();
		expect(events(rebuilt.sent)).toMatchObject([{ kind: "terminal", finalResponse: "THE ANSWER" }]);
	});

	it("does not turn commentary into a final answer", async () => {
		const context = setup();
		context.app.setRead(
			read("thread-1", [
				{
					id: "turn-1",
					status: "completed",
					items: [{ type: "agentMessage", id: "a", text: "working", phase: "commentary" }],
				},
			]),
		);
		context.service.handleCommand(reconcile("thread-1", "turn-1"));
		await settle();
		expect(events(context.sent)).toMatchObject([{ kind: "terminal", state: "completed", finalResponse: "" }]);
	});
});

describe("Codex terminals through the lifecycle", () => {
	it("publishes before archive and handles final-item deadlines", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		expect(events(context.sent)).toEqual([]);
		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
		await context.fireDeadlines();
		expect(events(context.sent)).toMatchObject([{ kind: "terminal", state: "completed", finalResponse: "" }]);
	});

	it("settles event and reconciled terminals through the lifecycle", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.app.emit(item("thread-1", "turn-1", { id: "answer", text: "done", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		expect(events(context.sent)).toMatchObject([{ kind: "terminal", threadId: "thread-1", finalResponse: "done" }]);
		expect(context.app.requests.some((request) => request.method === "thread/archive")).toBe(true);
		context.sent.length = 0;
		context.app.setRead(
			read("thread-1", [
				{
					id: "turn-2",
					status: "completed",
					items: [{ type: "agentMessage", id: "x", text: "recovered", phase: "final_answer" }],
				},
			]),
		);
		context.service.handleCommand(reconcile("thread-1", "turn-2"));
		await settle();
		expect(receipts(context.sent)).toMatchObject([{ kind: "reconciled", turnState: "completed" }]);
		expect(events(context.sent)).toMatchObject([{ kind: "terminal", finalResponse: "recovered" }]);
	});

	it("keeps contradictory held terminals unresolved", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.setRead(read("thread-1", [{ id: "turn-1", status: "inProgress", items: [] }]));
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		await context.fireDeadlines();
		expect(events(context.sent)).toEqual([]);
	});

	it("streams commentary and survives an archive refusal", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.app.failArchive();
		context.app.emit(item("thread-1", "turn-1", { id: "note", text: "reading", phase: "commentary" }));
		await settle();
		expect(events(context.sent)).toMatchObject([{ kind: "activity", itemId: "note", text: "reading" }]);
		context.app.emit(item("thread-1", "turn-1", { id: "answer", text: "done", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		expect(events(context.sent).at(-1)).toMatchObject({ kind: "terminal", finalResponse: "done" });
		expect(context.app.requests.some((request) => request.method === "thread/archive")).toBe(true);
	});
});

describe("Codex poison and reconciliation", () => {
	it("retires a poisoned generation and serves the next command fresh", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.app.failRead();
		context.service.handleCommand(reconcile("thread-1", "turn-1"));
		await settle();
		expect(receipts(context.sent).at(-1)).toMatchObject({ kind: "rejected" });
		expect(context.released).toMatchObject([{ targetId: TARGET_ID, generation: 3 }]);
		context.app.emit(item("thread-1", "turn-late", { id: "late", text: "late", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-late"));
		await settle();
		expect(events(context.sent)).toEqual([]);
		context.sent.length = 0;
		context.service.handleCommand(startCommand({ operationId: "123e4567-e89b-42d3-a456-426614174009" }));
		await settle();
		expect(context.acquired.slice(-2)).toEqual([3, 4]);
		expect(context.service.hello()).toMatchObject({ targets: [{ targetId: TARGET_ID, generation: 4 }] });
	});

	it("releases an open that finishes after shutdown", async () => {
		const context = setup();
		context.app.blockInitialize();
		context.service.handleCommand(startCommand());
		await settle();
		context.service.shutdown();
		context.app.releaseInitialize();
		await settle();
		expect(context.released).toMatchObject([{ targetId: TARGET_ID, generation: 3 }]);
		expect(events(context.sent)).toEqual([]);
	});

	it("releases an opening child that closes before a session exists", async () => {
		const context = setup();
		context.app.blockInitialize();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.exit();
		await settle();
		expect(context.released).toMatchObject([{ targetId: TARGET_ID, generation: 3 }]);
		expect(receipts(context.sent).at(-1)).toMatchObject({ kind: "rejected" });
	});

	it("reports unknown, running, and moved-on reconcile reads", async () => {
		const unknown = setup();
		unknown.service.handleCommand(reconcile("thread-1", "turn-9"));
		await settle();
		expect(receipts(unknown.sent).at(-1)).toMatchObject({ kind: "reconciled", turnId: "turn-9" });
		const unknownReceipt = receipts(unknown.sent).at(-1);
		expect(unknownReceipt && "turnState" in unknownReceipt ? unknownReceipt.turnState : undefined).toBeUndefined();
		expect(events(unknown.sent)).toEqual([]);

		const running = setup();
		running.app.setRead(read("thread-1", [{ id: "turn-1", status: "inProgress", items: [] }]));
		running.service.handleCommand(reconcile("thread-1", "turn-1"));
		await settle();
		expect(receipts(running.sent).at(-1)).toMatchObject({ kind: "reconciled", turnState: "inProgress" });
		expect(events(running.sent)).toEqual([]);

		const moved = setup();
		moved.app.setRead(
			read("thread-1", [
				{
					id: "turn-1",
					status: "completed",
					items: [{ type: "agentMessage", id: "x", text: "old", phase: "final_answer" }],
				},
				{ id: "turn-2", status: "inProgress", items: [] },
			]),
		);
		moved.service.handleCommand(reconcile("thread-1", "turn-1"));
		await settle();
		expect(moved.app.requests.filter((request) => request.method === "thread/read")).toHaveLength(2);
		expect(events(moved.sent)).toMatchObject([{ kind: "terminal", turnId: "turn-1", finalResponse: "old" }]);
	});
});

describe("Codex watchdog and reaping", () => {
	it("reconciles finished work and interrupts silent work", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.setRead(
			read("thread-1", [
				{
					id: "turn-1",
					status: "completed",
					items: [{ type: "agentMessage", id: "x", text: "quietly done", phase: "final_answer" }],
				},
			]),
		);
		await context.sweep(700_000);
		expect(events(context.sent)).toMatchObject([{ kind: "terminal", finalResponse: "quietly done" }]);
		const second = setup();
		second.service.handleCommand(startCommand());
		await settle();
		second.app.setRead(read("thread-1", [{ id: "turn-1", status: "inProgress", items: [] }]));
		await second.sweep(700_000);
		expect(second.app.requests.some((request) => request.method === "turn/interrupt")).toBe(true);
		await second.sweep(700_000);
		expect(second.released).toMatchObject([{ generation: 3 }]);
	});

	it("counts only the named thread as progress", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.setRead(read("thread-1", [{ id: "turn-1", status: "inProgress", items: [] }]));
		context.advance(700_000);
		context.app.emit({
			method: "item/started",
			params: { threadId: "thread-9", turnId: "turn-1", item: { type: "commandExecution", id: "cmd" } },
		});
		await context.sweep();
		expect(context.app.requests.some((request) => request.method === "turn/interrupt")).toBe(true);
	});

	it("counts an unparsed frame from the turn's own thread as progress", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.setRead(read("thread-1", [{ id: "turn-1", status: "inProgress", items: [] }]));
		context.advance(700_000);
		context.app.emit({
			method: "item/started",
			params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "cmd" } },
		});
		await settle();
		await context.sweep();
		expect(context.app.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
	});

	it("reaps parked quiet targets and waits for leased commands", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.emit(item("thread-1", "turn-1", { id: "x", text: "done", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		await context.sweep(REAP_QUIET);
		expect(context.released).toMatchObject([{ generation: 3 }]);
		const fresh = setup();
		fresh.service.handleCommand(startCommand());
		await settle();
		fresh.app.emit(item("thread-1", "turn-1", { id: "x", text: "done", phase: "final_answer" }));
		fresh.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		await fresh.sweep(REAP_QUIET);
		fresh.sent.length = 0;
		fresh.service.handleCommand(message("thread-1", "carry on"));
		await settle();
		expect(fresh.acquired).toEqual([3, 4]);
		expect(receipts(fresh.sent).at(-1)).toMatchObject({ kind: "accepted", delivery: "started" });
		const active = setup();
		active.service.handleCommand(startCommand());
		await settle();
		await active.sweep(REAP_QUIET);
		expect(active.released).toEqual([]);
		const inflight = setup();
		inflight.service.handleCommand(startCommand());
		await settle();
		inflight.app.setRead(read("thread-1", [{ id: "turn-1", status: "completed", items: [] }]));
		inflight.app.blockNextRead();
		inflight.service.handleCommand(reconcile("thread-1", "turn-1"));
		await settle();
		await inflight.sweep(REAP_QUIET);
		expect(inflight.released).toEqual([]);
		inflight.app.releaseRead();
		await settle();
	});
});

describe("Codex bookkeeping under churn", () => {
	it("keeps live bindings and restores a churned thread", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		for (let index = 0; index < 270; index += 1) {
			context.service.handleCommand(reconcile(`spare-${index}`));
			await settle();
		}
		context.sent.length = 0;
		context.app.emit(item("thread-1", "turn-99", { id: "late", text: "done", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-99"));
		await settle();
		expect(events(context.sent)).toMatchObject([{ agentId: AGENT_ID, threadId: "thread-1" }]);
		context.sent.length = 0;
		context.service.handleCommand(reconcile("thread-1"));
		await settle();
		context.app.emit(item("thread-1", "turn-100", { id: "late", text: "restored", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-100"));
		await settle();
		expect(events(context.sent)).toMatchObject([{ threadId: "thread-1", finalResponse: "restored" }]);

		const settled = setup();
		settled.service.handleCommand(startCommand());
		await settle();
		settled.app.emit(item("thread-1", "turn-1", { id: "answer", text: "done", phase: "final_answer" }));
		settled.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		for (let index = 0; index < 270; index += 1) {
			settled.service.handleCommand(reconcile(`settled-${index}`));
			await settle();
		}
		settled.sent.length = 0;
		settled.app.emit(item("thread-1", "turn-late", { id: "late", text: "late", phase: "final_answer" }));
		settled.app.emit(terminal("thread-1", "turn-late"));
		await settle();
		expect(events(settled.sent)).toEqual([]);

		const active = setup();
		active.service.handleCommand(startCommand());
		await settle();
		for (let index = 0; index < 270; index += 1) {
			active.service.handleCommand(reconcile(`active-${index}`));
			await settle();
		}
		active.sent.length = 0;
		active.app.emit(item("thread-1", "turn-late", { id: "late", text: "late", phase: "final_answer" }));
		active.app.emit(terminal("thread-1", "turn-late"));
		await settle();
		expect(events(active.sent)).toMatchObject([{ threadId: "thread-1", agentId: AGENT_ID }]);
	});
});

describe("Codex daemon commands", () => {
	it("starts, steers, interrupts, and reports typed frames", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		expect(receipts(context.sent).at(-1)).toMatchObject({
			kind: "accepted",
			delivery: "started",
			threadId: "thread-1",
			turnId: "turn-1",
		});
		expect(context.app.requests.map((request) => request.method)).toEqual([
			"initialize",
			"initialized",
			"model/list",
			"thread/start",
			"turn/start",
		]);
		context.sent.length = 0;
		context.service.handleCommand(message("thread-1", "continue", "turn-1"));
		await settle();
		expect(receipts(context.sent)).toMatchObject([{ kind: "accepted", delivery: "steered", turnId: "turn-1" }]);
		expect(context.app.requests.at(-1)?.params).toMatchObject({ expectedTurnId: "turn-1" });
		context.sent.length = 0;
		context.service.handleCommand({
			type: "codex_command",
			kind: "interrupt",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();
		expect(receipts(context.sent)).toMatchObject([{ kind: "interruptResult", ok: true, turnId: "turn-1" }]);
		expect(context.app.requests.at(-1)?.method).toBe("turn/interrupt");
	});

	it("starts once after a steer race and refuses an unaccounted failure", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.failSteer();
		context.app.setRead(read("thread-1", [{ id: "turn-1", status: "completed", items: [] }]));
		context.service.handleCommand(message("thread-1", "continue", "turn-1"));
		await settle();
		expect(receipts(context.sent).at(-1)).toMatchObject({
			kind: "accepted",
			delivery: "started",
			turnId: "turn-2",
		});
		const refused = setup();
		refused.service.handleCommand(startCommand());
		await settle();
		refused.app.failSteer();
		refused.app.setRead(read("thread-1", [{ id: "turn-1", status: "inProgress", items: [] }]));
		refused.service.handleCommand(message("thread-1", "again", "turn-1"));
		await settle();
		expect(receipts(refused.sent).at(-1)).toMatchObject({ kind: "rejected" });
	});

	it("reports whether a failed start left a running turn", async () => {
		const running = setup();
		running.app.failStart();
		running.app.setRead(read("thread-1", [{ id: "turn-live", status: "inProgress", items: [] }]));
		running.service.handleCommand(startCommand());
		await settle();
		expect(receipts(running.sent).at(-1)).toMatchObject({ kind: "accepted", turnId: "turn-live" });

		const absent = setup();
		absent.app.failStart();
		absent.service.handleCommand(startCommand());
		await settle();
		expect(receipts(absent.sent).at(-1)).toMatchObject({ kind: "rejected" });
	});

	it("starts one replacement turn when a steer ends concurrently", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.blockSteer();
		context.service.handleCommand(message("thread-1", "continue", "turn-1"));
		await settle();
		context.app.emit(item("thread-1", "turn-1", { id: "answer", text: "done", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		context.app.releaseSteer();
		await settle();
		const accepted = receipts(context.sent).filter((receipt) => receipt.kind === "accepted");
		expect(accepted).toHaveLength(2);
		expect(accepted.at(-1)).toMatchObject({ delivery: "started", turnId: "turn-2" });
		expect(context.app.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
	});

	it("reports delivered interrupts and failed interrupts", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.service.handleCommand({
			type: "codex_command",
			kind: "interrupt",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();
		expect(receipts(context.sent).at(-1)).toMatchObject({ kind: "interruptResult", ok: true });
		expect(events(context.sent)).toEqual([]);
		context.app.emit(item("thread-1", "turn-1", { id: "answer", text: "stopped", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-1", "interrupted"));
		await settle();
		expect(events(context.sent)).toMatchObject([{ kind: "terminal", state: "interrupted" }]);

		const failed = setup();
		failed.service.handleCommand(startCommand());
		await settle();
		failed.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		failed.app.failInterrupt();
		failed.service.handleCommand({
			type: "codex_command",
			kind: "interrupt",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();
		expect(receipts(failed.sent).at(-1)).toMatchObject({ kind: "interruptFailed", ok: false });
	});

	it("does not fire held deadlines after shutdown", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		context.service.shutdown();
		await context.fireDeadlines();
		expect(events(context.sent)).toEqual([]);
	});

	it("replays and acknowledges reliable receipts, and announces live targets", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		expect(context.service.hello()).toEqual({
			type: "codex_hello",
			daemonInstanceId: "daemon-1",
			targets: [{ targetId: TARGET_ID, generation: 3 }],
		});
		context.service.replay();
		expect(receipts(context.sent)).toHaveLength(1);
		context.sent.length = 0;
		context.service.acknowledge({
			type: "codex_ack",
			daemonInstanceId: "daemon-1",
			targetId: TARGET_ID,
			generation: 3,
			throughEventId: 0,
		});
		context.service.replay();
		expect(context.sent).toEqual([]);
	});

	it("rejects malformed commands and closes without acquiring", async () => {
		const context = setup();
		context.service.handleCommand({ ...startCommand(), prompt: "   " });
		await settle();
		expect(context.acquired).toEqual([]);
		context.service.shutdown();
		context.service.handleCommand(startCommand());
		await settle();
		expect(receipts(context.sent)).toMatchObject([{ kind: "rejected" }]);
	});
});
