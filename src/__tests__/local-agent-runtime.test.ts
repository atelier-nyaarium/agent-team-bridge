import { describe, expect, it } from "vitest";
import { LOCAL_IDLE_REAP_MS, LocalAgentRuntime, type LocalBackendSpec } from "../mcp/local/localAgentRuntime.js";
import type { LocalBackendSession, LocalTerminal } from "../mcp/local/localAgentSession.js";
import type { AgentBackendId } from "../shared/agent-backend.js";
import { agentIdForOperation } from "../shared/agent-record.js";
import { CodexListAgentsResultSchema } from "../shared/codexAgentCatalog.js";
import { CODEX_ACTIVITY_MAX_ITEMS } from "../shared/codexAgentIdentity.js";
import { CodexAgentResultSchema } from "../shared/codexAgentState.js";

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
	threadsResumable?: boolean;
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
	/** Parks openThread so a test can hold a child call in flight, which is the window a reaper
	 * decided from turn state alone would close the transport in. */
	openThreadGate?: Promise<void>;

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
		if (this.openThreadGate) await this.openThreadGate;
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
		replaysOperations: false,
		waitBudgetMs: options.waitBudgetMs ?? 100,
		followupDelivery: options.followupDelivery ?? (backendId === "copilot" ? "followup" : "started"),
		maxActivities: options.maxActivities ?? CODEX_ACTIVITY_MAX_ITEMS,
		threadsResumable: options.threadsResumable ?? true,
		...(options.busyMessage ? { busyMessage: options.busyMessage } : {}),
	};
	const runtime = new LocalAgentRuntime(spec, () => timestamp++);
	// Jumps the clock the idle reaper reads, so a test drives it without waiting.
	const advance = (ms: number) => {
		timestamp += ms;
	};
	return { runtime, session, openSession, spec, advance };
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

/**
 * The caller's operation identity, which local mode validated and then threw away.
 *
 * The obvious fix - derive the agent id from it and stop there - is a bug, not a fix: a reused id
 * would overwrite the first agent in the runtime's map, leaving its thread open, its activity
 * unrecorded, no way to address it, and its ACTIVE turn invisible to the idle reaper, which walks
 * only that map. So the id is honoured AND a reuse is refused.
 */
describe("local operation identity", () => {
	const OP = "123e4567-e89b-42d3-a456-426614174000";

	it("names the agent from the caller's operation id rather than a fresh one", async () => {
		const harness = makeHarness();
		const pending = harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Inspect" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "done" });
		expect(parseCodex(await pending).agentId).toBe(agentIdForOperation("codex", OP));
	});

	// The orphan the naive version creates. One agent, one thread, and the second call never reaches
	// the child at all.
	it("refuses a reuse instead of starting a second operation over the first", async () => {
		const harness = makeHarness();
		const first = harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Inspect" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "done" });
		await first;

		const again = await harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Inspect" });
		expect(again).toMatchObject({ refused: expect.stringContaining("already used") });
		expect(harness.runtime.list()).toHaveLength(1);
		// The refusal happens before dispatch, so the child is never asked for a second thread. That
		// thread is what would have been orphaned.
		expect(harness.session.openThreadCalls).toHaveLength(1);
	});

	// The gateway's own wording for the same condition, so the two answers do not read as different
	// problems. The gateway would REPLAY the matching case; this one cannot, and says so.
	it("separates a reuse with different input from a plain repeat", async () => {
		const harness = makeHarness();
		const pending = harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Inspect" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "done" });
		await pending;

		expect(await harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Something else" })).toEqual({
			refused: "operation ID was reused with different input",
		});
	});

	// A start's model is part of its identity on the gateway path, so it has to be here too or the
	// same two calls are one operation on one path and two on the other.
	it("counts a changed model as different input", async () => {
		const harness = makeHarness();
		const pending = harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Inspect", model: "a" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "done" });
		await pending;

		expect(await harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Inspect", model: "b" })).toEqual(
			{
				refused: "operation ID was reused with different input",
			},
		);
	});

	// Reads claim nothing: awaiting or listing twice is not a second operation.
	it("does not claim an identity for a read", async () => {
		const harness = makeHarness({ waitBudgetMs: 5 });
		const pending = harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Long" });
		await waitForTurns(harness.session, 1);
		const started = parseCodex(await pending);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "done" });

		expect(await harness.runtime.handle({ kind: "await", agentId: started.agentId })).not.toHaveProperty("refused");
		expect(await harness.runtime.handle({ kind: "await", agentId: started.agentId })).not.toHaveProperty("refused");
	});

	/**
	 * An identity is spent by an operation that HAPPENED.
	 *
	 * Found by Luna after the first version shipped the opposite: the claim was taken before dispatch
	 * and never released, so a child that could not be opened burned the id permanently and the retry
	 * the caller was explicitly invited to make answered "already used". The gateway does not have
	 * this problem because it returns before persisting anything.
	 */
	it("gives the identity back when nothing reached the child", async () => {
		const harness = makeHarness({ openThreadError: new Error("child is not running") });
		const failed = parseCodex(await harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Inspect" }));
		expect(failed).toMatchObject({ observation: "unavailable", error: { retryable: true } });

		// Same id, same input: a retry, not a reuse.
		const retry = harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Inspect" });
		expect(await retry).not.toHaveProperty("refused");
	});

	// The other half of the same rule: a turn that ran and FAILED did happen, so its id stays spent.
	it("keeps the identity when the operation ran and failed", async () => {
		const harness = makeHarness();
		const pending = harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Inspect" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "failed", error: "the tool exploded" });
		await pending;

		expect(await harness.runtime.handle({ kind: "start", operationId: OP, prompt: "Inspect" })).toMatchObject({
			refused: expect.stringContaining("already used"),
		});
	});

	// Nothing changes for a caller that names none; the runtime still mints its own.
	it("still works when no identity is supplied", async () => {
		const harness = makeHarness();
		const pending = harness.runtime.handle({ kind: "start", prompt: "Inspect" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "done" });
		expect(parseCodex(await pending).agentState).toBe("idle");
	});
});

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

	it("reaps an idle child, and the next call transparently opens a replacement", async () => {
		// The child is otherwise released only when the MCP's stdin closes, so an agent that ran once
		// and then idled held its whole footprint for the rest of a long session.
		const harness = makeHarness();
		const startPending = harness.runtime.handle({ kind: "start", prompt: "Index the workspace" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "First" });
		const started = parseCodex(await startPending);
		expect(harness.openSession.count).toBe(1);

		expect(harness.runtime.reapIfIdle()).toBe(false); // not idle long enough yet
		harness.advance(LOCAL_IDLE_REAP_MS);
		expect(harness.runtime.reapIfIdle()).toBe(true);
		expect(harness.session.calls).toContain("close");

		// The agent stays messageable: a replacement child adopts the thread.
		const again = harness.runtime.handle({ kind: "message", agentId: started.agentId, prompt: "Once more" });
		await waitForTurns(harness.session, 2);
		harness.session.resolveTurn("turn-2", { status: "completed", finalResponse: "Second" });
		expect(parseCodex(await again).turn?.state).toBe("completed");
		expect(harness.openSession.count).toBe(2);
	});

	it("never reaps a child with a turn in flight, however long it has run", async () => {
		// close() settles every pending turn as failed, so reaping here would convert working agents
		// into errors in order to reclaim memory - the one trade this must never make.
		const harness = makeHarness();
		const pending = harness.runtime.handle({ kind: "start", prompt: "A long job" });
		await waitForTurns(harness.session, 1);
		harness.advance(LOCAL_IDLE_REAP_MS * 10);

		expect(harness.runtime.reapIfIdle()).toBe(false);
		expect(harness.session.calls).not.toContain("close");

		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Done" });
		await pending;
	});

	it("never reaps while a child call is in flight, before any turn exists to guard it", async () => {
		// The window the turn marker cannot see: openThread is issued before any turn record, so a
		// reap decided from turn state alone closes the transport under the call. Same shape for
		// startTurn until it resolves, and for a steer or interrupt that owns no turn of its own.
		// Pins that SOMETHING guards beyond activeTurnId, which is the regression worth catching; it
		// cannot distinguish a per-request lease from a per-call one, since the difference is a
		// single microtask that no test can stand inside.
		const harness = makeHarness();
		let release = () => {};
		harness.session.openThreadGate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const startPending = harness.runtime.handle({ kind: "start", prompt: "A slow opener" });
		await Promise.resolve();
		harness.advance(LOCAL_IDLE_REAP_MS * 10);
		expect(harness.runtime.reapIfIdle()).toBe(false);
		expect(harness.session.calls).not.toContain("close");

		release();
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Done" });
		await startPending;
	});

	it("starts the idle clock at the TERMINAL, with the request long since returned", async () => {
		// Ordered so applyTerminal's own stamp is the only thing that can set the clock: the wait
		// budget expires first, so the request lease is already released and cannot mask a missing
		// stamp. Without it the clock still reads the request's return, three windows ago, and the
		// child is reaped the instant its turn finishes.
		const harness = makeHarness({ waitBudgetMs: 5 });
		const startPending = harness.runtime.handle({ kind: "start", prompt: "A long job" });
		await waitForTurns(harness.session, 1);
		await startPending; // returns on the budget; the turn keeps running

		harness.advance(LOCAL_IDLE_REAP_MS * 3);
		expect(harness.runtime.reapIfIdle()).toBe(false); // still guarded by the active turn

		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Done" });
		await new Promise((resolve) => setTimeout(resolve, 0)); // let applyTerminal run
		// The turn guard is gone now, so only the terminal's stamp keeps this false.
		expect(harness.runtime.reapIfIdle()).toBe(false);

		harness.advance(LOCAL_IDLE_REAP_MS);
		expect(harness.runtime.reapIfIdle()).toBe(true);
	});

	it("never reaps a backend whose threads die with the child", async () => {
		// An ACP session lives inside the Copilot process, so a reap would destroy agents the caller
		// may still message - a memory saving that silently loses work is not a saving.
		const harness = makeHarness({ backendId: "copilot", threadsResumable: false });
		const startPending = harness.runtime.handle({ kind: "start", prompt: "A copilot job" });
		await waitForTurns(harness.session, 1);
		harness.session.resolveTurn("turn-1", { status: "completed", finalResponse: "Done" });
		await startPending;

		harness.advance(LOCAL_IDLE_REAP_MS * 10);
		expect(harness.runtime.reapIfIdle()).toBe(false);
		expect(harness.session.calls).not.toContain("close");
	});
});
