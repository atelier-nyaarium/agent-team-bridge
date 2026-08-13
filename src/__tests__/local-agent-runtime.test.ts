import { describe, expect, it } from "vitest";
import { LocalAgentRuntime, type LocalBackendSpec } from "../mcp/local/localAgentRuntime.js";
import type { LocalBackendSession, LocalTerminal } from "../mcp/local/localAgentSession.js";
import type { AgentBackendId } from "../shared/agent-backend.js";
import { CodexAgentResultSchema } from "../shared/codexThinkingAgentState.js";
import { CodexListAgentsResultSchema } from "../shared/codexThinkingCatalog.js";
import { CODEX_ACTIVITY_MAX_ITEMS } from "../shared/codexThinkingIdentity.js";

////////////////////////////////
//  Interfaces & Types

interface FakeTurn {
	id: string;
	threadId: string;
	prompt: string;
	resolve: (terminal: LocalTerminal) => void;
}

interface FakeSessionOptions {
	canSteer?: boolean;
	openThreadError?: Error;
}

interface HarnessOptions {
	backendId?: AgentBackendId;
	waitBudgetMs?: number;
	followupDelivery?: string;
	maxActivities?: number;
	busyMessage?: string;
	canSteer?: boolean;
	openThreadError?: Error;
}

////////////////////////////////
//  Fakes

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

class FakeBackendSession implements LocalBackendSession {
	readonly calls: string[] = [];
	readonly openThreadCalls: Array<{ cwd: string; model?: string }> = [];
	readonly startTurnCalls: Array<{ threadId: string; prompt: string; turnId: string }> = [];
	readonly steerTurnCalls: Array<{ threadId: string; turnId: string; prompt: string }> = [];
	readonly interruptTurnCalls: Array<{ threadId: string; turnId: string }> = [];
	readonly turns: FakeTurn[] = [];
	steerTurn: LocalBackendSession["steerTurn"];

	private activityListener?: (turnId: string, text: string) => void;
	private closedListener?: () => void;
	private readonly openThreadError?: Error;

	constructor(options: FakeSessionOptions = {}) {
		this.openThreadError = options.openThreadError;
		if (options.canSteer !== false) {
			this.steerTurn = async (threadId, turnId, prompt) => {
				this.calls.push("steerTurn");
				this.steerTurnCalls.push({ threadId, turnId, prompt });
			};
		}
	}

	async openThread(options: { cwd: string; model?: string }): Promise<string> {
		this.calls.push("openThread");
		this.openThreadCalls.push(options);
		if (this.openThreadError) throw this.openThreadError;
		return "thread-1";
	}

	async startTurn(threadId: string, prompt: string) {
		this.calls.push("startTurn");
		const turnId = `turn-${this.turns.length + 1}`;
		const turn = deferred<LocalTerminal>();
		this.turns.push({ id: turnId, threadId, prompt, resolve: turn.resolve });
		this.startTurnCalls.push({ threadId, prompt, turnId });
		return { turnId, settled: turn.promise };
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		this.calls.push("interruptTurn");
		this.interruptTurnCalls.push({ threadId, turnId });
	}

	onActivity(listener: (turnId: string, text: string) => void): void {
		this.calls.push("onActivity");
		this.activityListener = listener;
	}

	onClosed(listener: () => void): void {
		this.calls.push("onClosed");
		this.closedListener = listener;
	}

	close(): void {
		this.calls.push("close");
	}

	emitActivity(turnId: string, text: string): void {
		if (!this.activityListener) throw new Error("activity listener was not registered");
		this.activityListener(turnId, text);
	}

	/** What a real adapter fires from its child's exit. */
	emitClosed(): void {
		if (!this.closedListener) throw new Error("closed listener was not registered");
		this.closedListener();
	}

	resolveTurn(turnId: string, terminal: LocalTerminal): void {
		const turn = this.turns.find((candidate) => candidate.id === turnId);
		if (!turn) throw new Error(`unknown fake turn: ${turnId}`);
		turn.resolve(terminal);
	}
}

function makeHarness(options: HarnessOptions = {}) {
	const session = new FakeBackendSession({
		canSteer: options.canSteer,
		openThreadError: options.openThreadError,
	});
	const openSession = { count: 0 };
	let timestamp = 1_000;
	const backendId = options.backendId ?? "codex";
	const spec: LocalBackendSpec = {
		backendId,
		openSession: async () => {
			openSession.count += 1;
			return session;
		},
		defaultCwd: () => "/workspace/project",
		waitBudgetMs: options.waitBudgetMs ?? 100,
		followupDelivery: options.followupDelivery ?? (backendId === "copilot" ? "followup" : "started"),
		maxActivities: options.maxActivities ?? CODEX_ACTIVITY_MAX_ITEMS,
		...(options.busyMessage ? { busyMessage: options.busyMessage } : {}),
	};
	const runtime = new LocalAgentRuntime(spec, () => timestamp++);
	return { runtime, session, openSession, spec };
}

async function waitForTurns(session: FakeBackendSession, count: number): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (session.turns.length >= count) return;
		await Promise.resolve();
	}
	throw new Error(`expected ${count} fake turns, got ${session.turns.length}`);
}

function parseCodex(answer: unknown) {
	return CodexAgentResultSchema.parse(answer);
}

function parseList(runtime: LocalAgentRuntime) {
	return CodexListAgentsResultSchema.parse({ agents: runtime.list() });
}

const UNKNOWN_AGENT_ID = `codex_${"f".repeat(32)}`;

////////////////////////////////
//  Journeys

describe("LocalAgentRuntime", () => {
	it("returns a completed start when the terminal beats the wait budget", async () => {
		const harness = makeHarness();
		const pending = harness.runtime.handle({ kind: "start", prompt: "Inspect the change" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Inspection complete" });

		expect(harness.session.calls).toEqual(["onActivity", "onClosed", "openThread", "startTurn"]);
		const answer = parseCodex(await pending);
		expect(answer).toMatchObject({
			agentState: "idle",
			observation: "terminal",
			turn: { id: "turn-1", state: "completed" },
			delivery: "started",
			finalResponse: "Inspection complete",
		});
	});

	it("reports a timed out start as working and await later collects its terminal", async () => {
		const harness = makeHarness({ waitBudgetMs: 5 });
		const pending = harness.runtime.handle({ kind: "start", prompt: "Run the long check" });
		await waitForTurns(harness.session, 1);

		const timedOut = parseCodex(await pending);
		expect(harness.session.calls).toEqual(["onActivity", "onClosed", "openThread", "startTurn"]);
		expect(timedOut).toMatchObject({
			agentState: "working",
			observation: "waitTimedOut",
			turn: { id: "turn-1", state: "inProgress" },
			delivery: "started",
		});

		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Long check complete" });
		const terminal = parseCodex(await harness.runtime.handle({ kind: "await", agentId: timedOut.agentId }));
		expect(terminal).toMatchObject({
			agentState: "idle",
			observation: "terminal",
			turn: { id: "turn-1", state: "completed" },
			finalResponse: "Long check complete",
		});
	});

	it("pairs a failed turn with a turn_failed error", async () => {
		const harness = makeHarness();
		const pending = harness.runtime.handle({ kind: "start", prompt: "Run the failing check" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "failed", error: "The check failed" });

		expect(harness.session.calls).toEqual(["onActivity", "onClosed", "openThread", "startTurn"]);
		const answer = parseCodex(await pending);
		expect(answer).toMatchObject({
			observation: "terminal",
			turn: { id: "turn-1", state: "failed" },
			error: { code: "turn_failed" },
		});
	});

	it("reports an interrupted turn without an error or final response", async () => {
		const harness = makeHarness();
		const pending = harness.runtime.handle({ kind: "start", prompt: "Run the interrupted check" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "interrupted" });

		expect(harness.session.calls).toEqual(["onActivity", "onClosed", "openThread", "startTurn"]);
		const answer = parseCodex(await pending);
		expect(answer).toMatchObject({
			observation: "terminal",
			turn: { id: "turn-1", state: "interrupted" },
		});
		expect(answer.error).toBeUndefined();
		expect(answer.finalResponse).toBeUndefined();
	});

	it("steers a running turn without starting another one", async () => {
		const harness = makeHarness({ waitBudgetMs: 5 });
		const startPending = harness.runtime.handle({ kind: "start", prompt: "Begin the investigation" });
		await waitForTurns(harness.session, 1);
		const started = parseCodex(await startPending);

		const messagePending = harness.runtime.handle({
			kind: "message",
			agentId: started.agentId,
			prompt: "Prioritize the regression",
		});
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Regression isolated" });

		expect(harness.session.calls).toEqual(["onActivity", "onClosed", "openThread", "startTurn", "steerTurn"]);
		expect(harness.session.startTurnCalls).toHaveLength(1);
		expect(harness.session.steerTurnCalls).toEqual([
			{ threadId: "thread-1", turnId: "turn-1", prompt: "Prioritize the regression" },
		]);
		const answer = parseCodex(await messagePending);
		expect(answer).toMatchObject({
			agentId: started.agentId,
			observation: "terminal",
			turn: { id: "turn-1", state: "completed" },
			delivery: "steered",
			finalResponse: "Regression isolated",
		});
	});

	// A steerless backend refuses the REQUEST rather than reporting an unwell agent. Both result
	// schemas reject a busy code under `unavailable`, so a result-shaped answer here cannot exist.
	it("refuses a follow-up to a working steerless agent without starting a second turn", async () => {
		const busyMessage = "Copilot is still working";
		const harness = makeHarness({
			canSteer: false,
			busyMessage,
			waitBudgetMs: 5,
		});
		const startPending = harness.runtime.handle({ kind: "start", prompt: "Begin the investigation" });
		await waitForTurns(harness.session, 1);
		const started = parseCodex(await startPending);

		const answer = await harness.runtime.handle({
			kind: "message",
			agentId: started.agentId,
			prompt: "Try to interrupt the running work",
		});
		expect(answer).toEqual({ refused: busyMessage });
		expect(harness.session.calls).toEqual(["onActivity", "onClosed", "openThread", "startTurn"]);
		expect(harness.session.startTurnCalls).toHaveLength(1);

		// The refusal left the running turn alone, so its own outcome still arrives intact.
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Investigation done" });
		const settled = parseCodex(await harness.runtime.handle({ kind: "await", agentId: started.agentId }));
		expect(settled).toMatchObject({
			agentState: "idle",
			observation: "terminal",
			turn: { id: "turn-1", state: "completed" },
			finalResponse: "Investigation done",
		});
	});

	it("starts a follow-up turn when the agent is idle", async () => {
		const harness = makeHarness({ followupDelivery: "started" });
		const startPending = harness.runtime.handle({ kind: "start", prompt: "Begin the investigation" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Initial result" });
		const started = parseCodex(await startPending);

		const messagePending = harness.runtime.handle({
			kind: "message",
			agentId: started.agentId,
			prompt: "Continue with the follow-up",
		});
		await waitForTurns(harness.session, 2);
		harness.session.resolveTurn("turn-2", { status: "completed", finalResponse: "Follow-up result" });

		expect(harness.session.calls).toEqual(["onActivity", "onClosed", "openThread", "startTurn", "startTurn"]);
		expect(harness.session.startTurnCalls).toEqual([
			{ threadId: "thread-1", prompt: "Begin the investigation", turnId: "turn-1" },
			{ threadId: "thread-1", prompt: "Continue with the follow-up", turnId: "turn-2" },
		]);
		const answer = parseCodex(await messagePending);
		expect(answer).toMatchObject({
			agentId: started.agentId,
			observation: "terminal",
			turn: { id: "turn-2", state: "completed" },
			delivery: "started",
			finalResponse: "Follow-up result",
		});
	});

	it("requests an interrupt without ending the running turn", async () => {
		const harness = makeHarness({ waitBudgetMs: 5 });
		const startPending = harness.runtime.handle({ kind: "start", prompt: "Keep working" });
		await waitForTurns(harness.session, 1);
		const started = parseCodex(await startPending);

		const answer = parseCodex(await harness.runtime.handle({ kind: "stop", agentId: started.agentId }));
		expect(harness.session.calls).toEqual(["onActivity", "onClosed", "openThread", "startTurn", "interruptTurn"]);
		expect(harness.session.interruptTurnCalls).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
		expect(answer).toMatchObject({
			agentId: started.agentId,
			agentState: "working",
			observation: "interruptRequested",
			turn: { id: "turn-1", state: "inProgress" },
		});

		harness.session.resolveTurn("turn-1", { status: "interrupted" });
	});

	it("returns an idle answer when stopping an idle agent", async () => {
		const harness = makeHarness();
		const startPending = harness.runtime.handle({ kind: "start", prompt: "Finish first" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Finished" });
		const started = parseCodex(await startPending);

		const answer = parseCodex(await harness.runtime.handle({ kind: "stop", agentId: started.agentId }));
		expect(harness.session.calls).toEqual(["onActivity", "onClosed", "openThread", "startTurn"]);
		expect(harness.session.interruptTurnCalls).toHaveLength(0);
		expect(answer).toMatchObject({
			agentId: started.agentId,
			agentState: "idle",
			observation: "idle",
			activities: [],
		});
		expect(answer.turn).toBeUndefined();
	});

	it.each(["message", "await", "stop"] as const)("reports %s for an unknown agent", async (kind) => {
		const harness = makeHarness();
		const request =
			kind === "message"
				? { kind, agentId: UNKNOWN_AGENT_ID, prompt: "Unknown" }
				: { kind, agentId: UNKNOWN_AGENT_ID };

		const answer = parseCodex(await harness.runtime.handle(request));
		expect(answer).toMatchObject({
			agentId: UNKNOWN_AGENT_ID,
			agentState: "unavailable",
			observation: "unavailable",
			activities: [],
			error: { code: "not_found", retryable: false },
		});
		// An agent nobody started is answered without ever reaching for a child.
		expect(harness.openSession.count).toBe(0);
	});

	it("does not list an agent when openThread fails", async () => {
		const harness = makeHarness({ openThreadError: new Error("thread creation failed") });
		const answer = parseCodex(await harness.runtime.handle({ kind: "start", prompt: "Open a thread" }));

		expect(harness.session.calls).toEqual(["onActivity", "onClosed", "openThread"]);
		expect(answer).toMatchObject({
			agentState: "unavailable",
			observation: "unavailable",
			error: { code: "app_server_unavailable", retryable: true },
		});
		const listed = parseList(harness.runtime);
		expect(listed.agents).toEqual([]);
	});

	it("reopens the session after the cached child closes", async () => {
		const harness = makeHarness();
		const startPending = harness.runtime.handle({ kind: "start", prompt: "Finish before closing" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Finished" });
		const started = parseCodex(await startPending);

		harness.session.emitClosed();
		const messagePending = harness.runtime.handle({
			kind: "message",
			agentId: started.agentId,
			prompt: "Use the replacement session",
		});
		await waitForTurns(harness.session, 2);
		harness.session.resolveTurn("turn-2", { status: "completed", finalResponse: "Reopened" });
		const answer = parseCodex(await messagePending);

		expect(harness.openSession.count).toBe(2);
		expect(harness.session.calls).toEqual([
			"onActivity",
			"onClosed",
			"openThread",
			"startTurn",
			"onActivity",
			"onClosed",
			"startTurn",
		]);
		expect(answer).toMatchObject({
			agentId: started.agentId,
			observation: "terminal",
			turn: { id: "turn-2", state: "completed" },
			finalResponse: "Reopened",
		});
	});

	it("projects a completed start through the real list schema", async () => {
		const harness = makeHarness();
		const pending = harness.runtime.handle({ kind: "start", prompt: "Record this exchange" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Recorded" });
		const answer = parseCodex(await pending);
		const listed = parseList(harness.runtime);

		expect(answer.observation).toBe("terminal");
		expect(listed.agents).toHaveLength(1);
		expect(listed.agents[0]?.exchanges).toHaveLength(1);
		expect(listed.agents[0]?.exchanges[0]).toMatchObject({
			kind: "start",
			delivery: "started",
			turnId: "turn-1",
		});
		expect(listed.agents[0]?.turns).toEqual([
			expect.objectContaining({ state: "completed", finalResponse: "Recorded" }),
		]);
		expect(listed.agents[0]?.createdAt).toBe(1_000);
	});

	it("truncates a running turn to the configured activity window", async () => {
		const maxActivities = CODEX_ACTIVITY_MAX_ITEMS;
		const omitted = 3;
		const harness = makeHarness({ maxActivities, waitBudgetMs: 5 });
		const pending = harness.runtime.handle({ kind: "start", prompt: "Narrate the work" });
		await waitForTurns(harness.session, 1);
		for (let index = 0; index < maxActivities + omitted; index += 1) {
			harness.session.emitActivity("turn-1", `activity-${index}`);
		}

		const answer = parseCodex(await pending);
		expect(answer.observation).toBe("waitTimedOut");
		expect(answer.activities).toHaveLength(maxActivities + 1);
		expect(answer.activities.filter((activity) => activity.kind === "commentary")).toHaveLength(maxActivities);
		expect(answer.activities.slice(-1)).toEqual([{ kind: "truncated", omitted }]);
		expect(answer.activities[0]).toEqual({ kind: "commentary", text: `activity-${omitted}` });

		harness.session.resolveTurn("turn-1", { status: "interrupted" });
	});

	it("keeps the real Codex activity cap parseable at its array boundary", async () => {
		const harness = makeHarness({ maxActivities: CODEX_ACTIVITY_MAX_ITEMS, waitBudgetMs: 5 });
		const pending = harness.runtime.handle({ kind: "start", prompt: "Fill the activity window" });
		await waitForTurns(harness.session, 1);
		for (let index = 0; index <= CODEX_ACTIVITY_MAX_ITEMS; index += 1) {
			harness.session.emitActivity("turn-1", `item-${index}`);
		}

		const answer = parseCodex(await pending);
		expect(answer.activities).toHaveLength(CODEX_ACTIVITY_MAX_ITEMS + 1);
		expect(answer.activities.at(-1)).toEqual({ kind: "truncated", omitted: 1 });

		harness.session.resolveTurn("turn-1", { status: "interrupted" });
	});

	it("shares one session opening across concurrent starts", async () => {
		const harness = makeHarness();
		const firstPending = harness.runtime.handle({ kind: "start", prompt: "First concurrent start" });
		const secondPending = harness.runtime.handle({ kind: "start", prompt: "Second concurrent start" });
		await waitForTurns(harness.session, 2);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "First" });
		harness.session.resolveTurn("turn-2", { status: "completed", finalResponse: "Second" });

		const answers = [parseCodex(await firstPending), parseCodex(await secondPending)];
		expect(harness.openSession.count).toBe(1);
		expect(harness.session.calls).toEqual([
			"onActivity",
			"onClosed",
			"openThread",
			"openThread",
			"startTurn",
			"startTurn",
		]);
		expect(answers.map((answer) => answer.turn?.state)).toEqual(["completed", "completed"]);
	});

	// The reuse leg matters as much as the reopen: without it, a count of two could equally mean the
	// runtime opens a child per call.
	it("reuses one session across calls and only reopens once the child closes", async () => {
		const harness = makeHarness();
		const startPending = harness.runtime.handle({ kind: "start", prompt: "Begin the investigation" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "First" });
		const started = parseCodex(await startPending);

		const reusePending = harness.runtime.handle({
			kind: "message",
			agentId: started.agentId,
			prompt: "Keep going",
		});
		await waitForTurns(harness.session, 2);
		harness.session.resolveTurn("turn-2", { status: "completed", finalResponse: "Second" });
		await reusePending;
		expect(harness.openSession.count).toBe(1);

		harness.session.emitClosed();
		const afterClosePending = harness.runtime.handle({
			kind: "message",
			agentId: started.agentId,
			prompt: "After the child died",
		});
		await waitForTurns(harness.session, 3);
		harness.session.resolveTurn("turn-3", { status: "completed", finalResponse: "Third" });
		expect(parseCodex(await afterClosePending).turn?.state).toBe("completed");
		expect(harness.openSession.count).toBe(2);
	});
});
