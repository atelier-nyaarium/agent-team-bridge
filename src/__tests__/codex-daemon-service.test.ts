import { describe, expect, it } from "vitest";
import type { LifecycleHooks } from "../mcp/devcontainer/codexAppServer.js";
import type { AppServerSession } from "../mcp/devcontainer/codexDaemonService.js";
import { CodexDaemonService, resolveAgentTarget } from "../mcp/devcontainer/codexDaemonService.js";
import type { CodexChild, TargetAvailability, TargetSupervisor } from "../mcp/devcontainer/codexTargets.js";
import type { PoisonReason, ThreadPhase } from "../mcp/devcontainer/codexThreadLifecycle.js";
import type { TerminalOutcome } from "../mcp/devcontainer/codexTurnOutcome.js";
import type { CodexResolvedTarget } from "../shared/codex-agent.js";

const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const OPERATION_ID_TWO = "123e4567-e89b-42d3-a456-426614174009";
const TARGET_ID = "container:recipe-app";
/** Past the daemon's own reap quiet period, whatever it is set to. */
const REAP_QUIET = 900_000;
const RESOLVED_TARGET: CodexResolvedTarget = {
	kind: "devcontainer",
	targetId: TARGET_ID,
	cwd: "/workspace/recipe-app",
};

class FakeSession implements AppServerSession {
	listener: (message: { method: string; params?: unknown }) => void = () => {};
	readonly calls: string[] = [];
	turnCounter = 0;
	steerFails?: Error;
	startTurnFails?: Error;
	settleFails?: Error;
	closeFails?: Error;
	/** Held open to prove a terminal reaches the gateway before the thread is unloaded. */
	archiveGate?: Promise<void>;
	/** Held open to land a turn's terminal while its steer is still in flight. */
	steerGate?: Promise<void>;
	/** Held open to keep a command in flight without it starting a turn. */
	readGate?: Promise<void>;
	/** Runs where the owner drains a buffered terminal: after the caller registered, before the return. */
	afterStarted?: (threadId: string, turnId: string) => void;
	/** The snapshot `thread/read` answers with. Tests reassign it per scenario. */
	threadReadResult: unknown = { thread: { id: "thread-1", turns: [] } };
	/** What the real client hands its lifecycle; the daemon's terminals reach the gateway through them. */
	hooks: LifecycleHooks = {};

	private readonly published = new Set<string>();
	private readonly active = new Map<string, string>();
	private readonly phases = new Map<string, ThreadPhase>();

	/** What the owner would say: idle when started, active under a turn, parked once archived. */
	stateOf(threadId: string): ThreadPhase | undefined {
		return this.phases.get(threadId);
	}

	/** Stages a phase directly. */
	setPhase(threadId: string, phase: ThreadPhase): void {
		this.phases.set(threadId, phase);
	}

	onEvent(listener: (message: { method: string; params?: unknown }) => void) {
		this.listener = listener;
	}
	/** What `ThreadLifecycle.accept` does: publish once per turn, and park only an own turn or none. */
	async settleTurn(threadId: string, turnId: string, terminal: TerminalOutcome) {
		this.calls.push("settleTurn");
		if (!this.published.has(turnId)) {
			this.published.add(turnId);
			this.hooks.onTerminal?.(threadId, turnId, terminal);
		}
		const own = this.active.get(threadId);
		if (own !== undefined && own !== turnId) return;
		this.active.delete(threadId);
		if (this.archiveGate) await this.archiveGate;
		if (this.settleFails) throw this.settleFails;
		this.phases.set(threadId, { phase: "parked", epoch: 1 });
		this.calls.push("archive");
	}
	/** A request whose fate the lifecycle could not learn. */
	poison(threadId: string, reason: PoisonReason) {
		this.hooks.onPoisoned?.(threadId, reason);
	}
	async startThread() {
		this.calls.push("startThread");
		this.phases.set("thread-1", { phase: "idle" });
		return "thread-1";
	}
	async resumeThread() {
		this.calls.push("resumeThread");
	}
	async readThread() {
		this.calls.push("readThread");
		if (this.readGate) await this.readGate;
		return this.threadReadResult;
	}
	/** The owner hands the id back before publishing anything for it, so the double must too. */
	async startTurn(threadId: string, _text: string, onStarted: (turnId: string) => void) {
		this.calls.push("startTurn");
		if (this.startTurnFails) throw this.startTurnFails;
		this.turnCounter += 1;
		const turnId = `turn-${this.turnCounter}`;
		this.active.set(threadId, turnId);
		this.phases.set(threadId, { phase: "active", turnId, epoch: 1 });
		onStarted(turnId);
		this.afterStarted?.(threadId, turnId);
		return turnId;
	}
	async steerTurn() {
		this.calls.push("steerTurn");
		if (this.steerGate) await this.steerGate;
		if (this.steerFails) throw this.steerFails;
	}
	async interruptTurn() {
		this.calls.push("interruptTurn");
	}
	close() {
		this.calls.push("close");
		if (this.closeFails) throw this.closeFails;
	}

	/** Drive the App Server events one turn produces, in the order a real one emits them. */
	completeTurn(turnId: string, text: string) {
		this.listener({
			method: "item/completed",
			params: {
				threadId: "thread-1",
				turnId,
				item: { type: "agentMessage", id: "item-1", text, phase: "final_answer" },
			},
		});
		this.listener({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } },
		});
	}
}

function setup(
	options: { availability?: TargetAvailability; poisonOnOpen?: PoisonReason; openGate?: Promise<void> } = {},
) {
	const session = new FakeSession();
	const child = {} as CodexChild;
	const released: string[] = [];
	// A released target's next acquire is a new generation, as the supervisor mints them.
	let generation = 3;
	const targets: TargetSupervisor = {
		acquire: () => options.availability ?? { state: "running", lease: { generation, child } },
		// The manager reaps only the generation named, so a stale release takes nothing.
		release: (targetId, reaped) => {
			if (reaped !== generation) return;
			released.push(targetId);
			generation += 1;
		},
	};
	const sent: Record<string, unknown>[] = [];
	/** Deadlines the test fires by hand, so a held terminal needs no clock. */
	const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
	/** The watchdog and reaper sweep, fired by hand against a clock the test moves. */
	const sweeps: Array<() => void> = [];
	let clock = 1_000_000;
	const service = new CodexDaemonService({
		targets,
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async (_child, _model, hooks) => {
			session.hooks = hooks;
			// A client that condemns itself while the daemon is still awaiting it.
			if (options.poisonOnOpen) hooks.onPoisoned?.("thread-1", options.poisonOnOpen);
			if (options.openGate) await options.openGate;
			return session;
		},
		resolveHostCwd: () => "/home/agent",
		now: () => clock,
		setTimer: (run, ms) => {
			const timer = { run, ms, cleared: false };
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
		clearSweep: () => {
			sweeps.length = 0;
		},
	});
	const fireDeadlines = async () => {
		for (const timer of timers.filter((candidate) => !candidate.cleared)) {
			timer.cleared = true;
			timer.run();
		}
		await settle();
	};
	/** Advance the clock and run the sweeps, refusing to pass for want of one to run. */
	const sweep = async (byMs = 0) => {
		clock += byMs;
		if (sweeps.length === 0) throw new Error(`no sweep was installed, so nothing was swept`);
		for (const run of [...sweeps]) run();
		await settle();
	};
	return {
		service,
		session,
		sent,
		released,
		timers,
		fireDeadlines,
		sweep,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

/** Let the service's own promise chain drain. Commands are serialized, so a bounded run of ticks
 * covers every await one performs, including the lease and the session acquire around it. */
async function settle() {
	for (let tick = 0; tick < 40; tick += 1) await Promise.resolve();
}

const terminalsOf = (sent: Record<string, unknown>[]) => sent.filter((message) => message.kind === "terminal");

function startCommand() {
	return {
		type: "codex_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Audit the parser",
	};
}

describe("Codex execution targets", () => {
	it("resolves a host workdir hint through the daemon's own rule", () => {
		// A host hint is NOT a path: it can be a bare human label. Passing one straight through as a cwd
		// makes the resolved target fail its own schema, which the daemon reports as an unavailable
		// target and an owner sees as a start that refused itself for no stated reason.
		expect(resolveAgentTarget({ kind: "host", workdirHint: "Codex Support" }, () => "/home/agent")).toEqual({
			kind: "host",
			targetId: "host",
			cwd: "/home/agent",
		});
	});

	it("resolves a container target to its workspace without consulting the host rule", () => {
		expect(
			resolveAgentTarget(
				{ kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
				() => {
					throw new Error("host rule must not be consulted for a container");
				},
			),
		).toEqual({ kind: "devcontainer", targetId: TARGET_ID, cwd: "/workspace/recipe-app" });
	});
});

describe("Codex answer selection", () => {
	/** The same turn, seen live and rebuilt from a read, must yield the same answer. */
	async function liveAnswer(items: Array<{ id: string; text: string; phase?: string }>) {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		for (const item of items) {
			context.session.listener({
				method: "item/completed",
				params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", ...item } },
			});
		}
		context.session.listener({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
		});
		await settle();
		return (context.sent.find((message) => message.kind === "terminal") as { finalResponse?: string })
			?.finalResponse;
	}

	async function rebuiltAnswer(items: Array<{ id: string; text: string; phase?: string }>) {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.threadReadResult = {
			thread: {
				id: "thread-1",
				turns: [
					{ id: "turn-1", status: "completed", items: items.map((i) => ({ type: "agentMessage", ...i })) },
				],
			},
		};
		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();
		return (context.sent.find((message) => message.kind === "terminal") as { finalResponse?: string })
			?.finalResponse;
	}

	it("agrees between the live path and the rebuild when a final answer exists", async () => {
		const items = [
			{ id: "a", text: "thinking about it", phase: "commentary" },
			{ id: "b", text: "THE ANSWER", phase: "final_answer" },
		];
		expect(await liveAnswer(items)).toBe("THE ANSWER");
		expect(await rebuiltAnswer(items)).toBe("THE ANSWER");
	});

	it("never rebuilds commentary into the answer when a turn produced none", async () => {
		// A turn that only acted. Handing its narration back as a final response would tell the caller
		// their prompt was answered, quoting a line that was never an answer.
		const items = [{ id: "a", text: "reading the parser", phase: "commentary" }];
		expect(await rebuiltAnswer(items)).toBe("");
		// The live path holds such a turn instead, waiting for an answer that never comes - a real
		// asymmetry, but the deliberate one: it would rather say nothing yet than say the wrong thing.
		expect(await liveAnswer(items)).toBeUndefined();
	});
});

describe("Codex terminals through the thread lifecycle", () => {
	it("settles an event terminal through the lifecycle, publishing before the thread is archived", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.calls.length = 0;
		let unblock = () => {};
		context.session.archiveGate = new Promise((resolve) => {
			unblock = () => resolve();
		});

		context.session.completeTurn("turn-1", "done");
		await settle();

		// The gateway has its copy while the archive is still in flight, which is what park-after means.
		expect(terminalsOf(context.sent)).toMatchObject([{ state: "completed", finalResponse: "done" }]);
		expect(context.session.calls).toEqual(["settleTurn"]);

		unblock();
		await settle();
		expect(context.session.calls).toEqual(["settleTurn", "archive"]);
	});

	it("reports a terminal drained during its own start to the agent that asked for it", async () => {
		const context = setup();
		// The owner publishes mid-start, before beginTurn has returned. The thread binding runStart
		// installed is what catches it, since the turn binding is being written in the same breath.
		context.session.afterStarted = (threadId, turnId) => {
			context.session.hooks.onTerminal?.(threadId, turnId, { status: "completed", finalResponse: "beat it" });
		};

		context.service.handleCommand(startCommand());
		await settle();

		expect(terminalsOf(context.sent)).toMatchObject([
			{ agentId: AGENT_ID, turnId: "turn-1", finalResponse: "beat it" },
		]);
	});

	it("publishes a terminal for a turn the thread does not own without unloading it", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.calls.length = 0;

		context.session.listener({
			method: "item/completed",
			params: {
				threadId: "thread-1",
				turnId: "turn-stale",
				item: { type: "agentMessage", id: "item-1", text: "from an older turn", phase: "final_answer" },
			},
		});
		context.session.listener({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-stale", status: "completed" } },
		});
		await settle();

		expect(context.session.calls).toEqual(["settleTurn"]);
		expect(terminalsOf(context.sent)).toMatchObject([{ turnId: "turn-stale" }]);
	});

	it("settles a reconciled terminal through the lifecycle rather than straight to the gateway", async () => {
		const context = setup();
		context.session.threadReadResult = {
			thread: {
				id: "thread-1",
				turns: [
					{
						id: "turn-1",
						status: "completed",
						items: [{ type: "agentMessage", id: "item-1", text: "recovered", phase: "final_answer" }],
					},
				],
			},
		};
		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();

		expect(context.session.calls).toContain("settleTurn");
		expect(terminalsOf(context.sent)).toMatchObject([{ state: "completed", finalResponse: "recovered" }]);
	});

	it("parks a thread whose terminal arrives for a binding the session does not hold", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.calls.length = 0;

		// A thread of a previous generation, which this session has no binding for.
		context.session.listener({
			method: "item/completed",
			params: {
				threadId: "thread-inherited",
				turnId: "turn-9",
				item: { type: "agentMessage", id: "item-1", text: "orphan", phase: "final_answer" },
			},
		});
		context.session.listener({
			method: "turn/completed",
			params: { threadId: "thread-inherited", turn: { id: "turn-9", status: "completed" } },
		});
		await settle();

		expect(context.session.calls).toEqual(["settleTurn", "archive"]);
		expect(terminalsOf(context.sent)).toEqual([]);
	});

	it("settles a turn whose final item never arrives, rather than holding it forever", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;

		// The terminal alone, with no final item behind it: the tracker holds it.
		context.session.listener({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
		});
		await settle();
		expect(terminalsOf(context.sent)).toEqual([]);

		await context.fireDeadlines();

		expect(terminalsOf(context.sent)).toMatchObject([{ state: "completed", finalResponse: "" }]);
		expect(context.session.calls).toContain("archive");
	});

	it("invents no terminal when a read contradicts the one it is holding", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.calls.length = 0;
		context.session.threadReadResult = {
			thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] },
		};

		context.session.listener({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
		});
		await settle();
		await context.fireDeadlines();

		expect(terminalsOf(context.sent)).toEqual([]);
		expect(context.session.calls).not.toContain("settleTurn");
		// One read, and no deadline left running: a turn the server still calls live is Step 5's.
		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
	});

	it("arms one deadline for a held terminal, and none for one it already settled", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		const completed = {
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
		};

		context.session.listener(completed);
		context.session.listener(completed);
		await settle();
		expect(context.timers).toHaveLength(1);

		context.session.listener({
			method: "item/completed",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				item: { type: "agentMessage", id: "item-1", text: "late", phase: "final_answer" },
			},
		});
		await settle();
		context.session.listener(completed);
		await settle();

		expect(context.timers).toHaveLength(1);
		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
	});

	it("drops the deadline when a reconcile settles the turn instead", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.listener({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
		});
		await settle();
		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(1);

		context.session.threadReadResult = {
			thread: {
				id: "thread-1",
				turns: [
					{
						id: "turn-1",
						status: "completed",
						items: [{ type: "agentMessage", id: "item-1", text: "recovered", phase: "final_answer" }],
					},
				],
			},
		};
		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();

		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
		expect(terminalsOf(context.sent).at(-1)).toMatchObject({ finalResponse: "recovered" });
	});

	it("lets no deadline of a shut-down daemon fire", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.listener({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
		});
		await settle();
		// Asserting only that none is left running would pass against a daemon that arms none.
		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(1);

		context.service.shutdown();

		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
	});

	it("takes the read's answer for a held turn over the empty one the tracker holds", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.threadReadResult = {
			thread: {
				id: "thread-1",
				turns: [
					{
						id: "turn-1",
						status: "completed",
						items: [{ type: "agentMessage", id: "item-1", text: "the answer", phase: "final_answer" }],
					},
				],
			},
		};

		context.session.listener({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
		});
		await settle();
		await context.fireDeadlines();

		expect(terminalsOf(context.sent)).toMatchObject([{ state: "completed", finalResponse: "the answer" }]);
	});

	it("drops the deadline when the final item lands in time", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();

		context.session.listener({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
		});
		await settle();
		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(1);

		context.session.listener({
			method: "item/completed",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				item: { type: "agentMessage", id: "item-1", text: "late", phase: "final_answer" },
			},
		});
		await settle();

		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
		expect(terminalsOf(context.sent)).toMatchObject([{ state: "completed", finalResponse: "late" }]);
	});

	it("retires the generation when the lifecycle cannot learn a request's fate", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();

		context.session.listener({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
		});
		await settle();
		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(1);

		context.session.poison("thread-1", { kind: "exhausted", attempts: 3 });
		await settle();

		expect(context.released).toEqual([TARGET_ID]);
		// Nothing of that generation is asked again, the pending deadline included.
		expect(context.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
	});

	it("serves the target's other agent from a fresh generation after one poisons it", async () => {
		const context = setup();
		const other = "codex_fedcba9876543210fedcba9876543210";
		context.service.handleCommand(startCommand());
		await settle();
		context.service.handleCommand({ ...startCommand(), agentId: other, operationId: OPERATION_ID_TWO });
		await settle();
		expect(context.sent.at(-1)).toMatchObject({ agentId: other, generation: 3 });
		context.sent.length = 0;

		context.session.poison("thread-1", { kind: "failure", failure: { kind: "timeout" } as never });
		await settle();
		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: other,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
		});
		await settle();

		expect(context.released).toEqual([TARGET_ID]);
		expect(context.sent.at(-1)).toMatchObject({ kind: "reconciled", agentId: other, generation: 4 });
	});

	it("releases a target whose client condemns itself before the session exists", async () => {
		const context = setup({ poisonOnOpen: { kind: "exhausted", attempts: 3 } });
		context.service.handleCommand(startCommand());
		await settle();

		// Nothing was asked of the child, and the lease it holds is not left to it.
		expect(context.session.calls).toEqual(["close"]);
		expect(context.released).toEqual([TARGET_ID]);
		expect(context.sent).toMatchObject([{ kind: "rejected", agentId: AGENT_ID }]);
	});

	it("releases a condemned target even when closing its client throws", async () => {
		const context = setup({ poisonOnOpen: { kind: "exhausted", attempts: 3 } });
		context.session.closeFails = new Error("close said no");
		context.service.handleCommand(startCommand());
		await settle();

		expect(context.released).toEqual([TARGET_ID]);
	});

	it("lets an open that finishes after a shutdown serve nobody", async () => {
		let opened = () => {};
		const context = setup({
			openGate: new Promise<void>((resolve) => {
				opened = resolve;
			}),
		});
		context.service.handleCommand(startCommand());
		await settle();

		context.service.shutdown();
		opened();
		await settle();

		// Nothing was asked of the child, and the lease it holds does not outlive the daemon.
		expect(context.session.calls).toEqual(["close"]);
		expect(context.released).toEqual([TARGET_ID]);
	});

	it("acquires no target for a command that arrives after a shutdown", async () => {
		const context = setup();
		context.service.shutdown();

		context.service.handleCommand(startCommand());
		await settle();

		// Acquiring would spawn the very child the shutdown exists to stop spawning.
		expect(context.session.calls).toEqual([]);
		expect(context.sent).toMatchObject([{ kind: "rejected", agentId: AGENT_ID }]);
	});

	it("reports a terminal under the thread it happened on, not a stale binding's", async () => {
		const context = setup();
		const other = "codex_fedcba9876543210fedcba9876543210";
		context.service.handleCommand(startCommand());
		await settle();

		// A second agent takes thread-2 while turn-1 is still bound to thread-1.
		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: other,
			target: RESOLVED_TARGET,
			threadId: "thread-2",
		});
		await settle();
		context.sent.length = 0;

		context.session.hooks.onTerminal?.("thread-2", "turn-1", { status: "completed", finalResponse: "done" });
		await settle();

		expect(terminalsOf(context.sent)).toMatchObject([{ agentId: other, threadId: "thread-2" }]);

		// That terminal was never turn-1's on thread-1, so it did not take its binding either.
		context.session.calls.length = 0;
		context.service.handleCommand({
			type: "codex_command",
			kind: "message",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: OPERATION_ID_TWO,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			expectedTurnId: "turn-1",
			prompt: "Also check the lexer",
		});
		await settle();

		expect(context.session.calls).toEqual(["steerTurn"]);
	});

	it("publishes nothing more from a generation it has retired", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.poison("thread-1", { kind: "exhausted", attempts: 3 });
		await settle();
		context.sent.length = 0;

		context.session.completeTurn("turn-1", "done");
		await settle();

		expect(context.sent).toEqual([]);
	});

	it("refuses a command whose generation retires while it is in flight", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;

		let landed = () => {};
		context.session.steerGate = new Promise<void>((resolve) => {
			landed = resolve;
		});
		context.service.handleCommand({
			type: "codex_command",
			kind: "message",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: OPERATION_ID_TWO,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			expectedTurnId: "turn-1",
			prompt: "Also check the lexer",
		});
		await settle();

		context.session.poison("thread-1", { kind: "exhausted", attempts: 3 });
		await settle();
		landed();
		await settle();

		// An acceptance on a retired fence is dropped at the gateway, so the caller would never hear.
		expect(context.sent.at(-1)).toMatchObject({ kind: "rejected", agentId: AGENT_ID });
	});

	it("lets a terminal held over a generation change reach nobody", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		const stale = context.session.hooks.onTerminal;

		context.session.poison("thread-1", { kind: "exhausted", attempts: 3 });
		await settle();
		context.service.handleCommand({ ...startCommand(), operationId: OPERATION_ID_TWO });
		await settle();
		context.sent.length = 0;

		stale?.("thread-1", "turn-1", { status: "completed", finalResponse: "answered too late" });
		await settle();

		expect(context.sent).toEqual([]);
	});

	it("reports the terminal even when the archive behind it fails", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.settleFails = new Error("archive said no");

		context.session.completeTurn("turn-1", "done");
		await settle();

		// Through the lifecycle, not straight to the gateway: the archive it drives is what failed.
		expect(context.session.calls).toContain("settleTurn");
		expect(terminalsOf(context.sent)).toMatchObject([{ state: "completed", finalResponse: "done" }]);
		// Retiring the generation is the lifecycle's call, not this catch's.
		expect(context.released).toEqual([]);
	});
});

describe("Codex watchdog and reaping", () => {
	it("settles a turn the watchdog finds already finished", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.threadReadResult = {
			thread: {
				id: "thread-1",
				turns: [
					{
						id: "turn-1",
						status: "completed",
						items: [{ type: "agentMessage", id: "item-1", text: "quietly done", phase: "final_answer" }],
					},
				],
			},
		};

		await context.sweep(200_000);

		// The turn ended without an event this daemon ever saw, which is the silence being answered.
		expect(terminalsOf(context.sent)).toMatchObject([{ finalResponse: "quietly done" }]);
	});

	it("interrupts a turn that only ever reports itself in progress, then retires the generation", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.threadReadResult = {
			thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] },
		};
		context.session.calls.length = 0;

		await context.sweep(200_000);
		expect(context.session.calls).toContain("interruptTurn");
		expect(context.released).toEqual([]);

		await context.sweep(200_000);

		// Another identical inProgress is not progress, which is the whole point of asking twice.
		expect(context.released).toEqual([TARGET_ID]);
	});

	it("counts a frame the tracker does not parse as progress all the same", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.threadReadResult = {
			thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] },
		};
		context.session.calls.length = 0;

		context.advance(200_000);
		// A turn that only ever runs commands emits no agent message, and is working the whole time.
		context.session.listener({
			method: "item/started",
			params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "cmd-1" } },
		});
		await context.sweep();

		expect(context.session.calls).not.toContain("interruptTurn");
	});

	it("counts a turn's own frames as the progress the watchdog is looking for", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.threadReadResult = {
			thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] },
		};
		context.session.calls.length = 0;

		context.advance(200_000);
		context.session.listener({
			method: "item/completed",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				item: { type: "agentMessage", id: "item-1", text: "still working", phase: "commentary" },
			},
		});
		await context.sweep();

		expect(context.session.calls).not.toContain("interruptTurn");
	});

	it("takes no frame from another thread as this turn's progress", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.threadReadResult = {
			thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] },
		};
		context.session.calls.length = 0;

		context.advance(200_000);
		// The same turn id on a thread this turn does not belong to says nothing about this turn.
		context.session.listener({
			method: "item/started",
			params: { threadId: "thread-9", turnId: "turn-1", item: { type: "commandExecution", id: "cmd-1" } },
		});
		await context.sweep();

		expect(context.session.calls).toContain("interruptTurn");
	});

	it("keeps a turn's strikes when the gateway reconciles it again", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.threadReadResult = {
			thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] },
		};

		await context.sweep(200_000);
		expect(context.released).toEqual([]);

		// A reconcile is the gateway asking, not the turn working, so it buys no second chance.
		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();
		await context.sweep(200_000);

		expect(context.released).toEqual([TARGET_ID]);
	});

	it("starts the quiet period when a long command ends, not when it began", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.completeTurn("turn-1", "done");
		await settle();

		let read = () => {};
		context.session.readGate = new Promise<void>((resolve) => {
			read = resolve;
		});
		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();

		// The command outlives the quiet period, and finishing it must not make the target instantly stale.
		context.advance(REAP_QUIET);
		read();
		await settle();
		await context.sweep();

		expect(context.released).toEqual([]);
	});

	it("reaps a target whose threads are all parked and quiet", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.completeTurn("turn-1", "done");
		await settle();

		await context.sweep(REAP_QUIET);

		expect(context.released).toEqual([TARGET_ID]);
	});

	it("serves a follow-up after a reap from a fresh generation, without reconciling", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.completeTurn("turn-1", "done");
		await settle();
		await context.sweep(REAP_QUIET);
		expect(context.released).toEqual([TARGET_ID]);
		context.sent.length = 0;
		context.session.calls.length = 0;

		context.service.handleCommand({
			type: "codex_command",
			kind: "message",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: OPERATION_ID_TWO,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			prompt: "carry on",
		});
		await settle();

		// The reaped thread is resumed on the new child rather than reconciled back into existence.
		expect(context.session.calls).toEqual(["resumeThread", "startTurn"]);
		expect(context.sent.at(-1)).toMatchObject({ kind: "accepted", delivery: "started", generation: 4 });
	});

	it("reaps nothing while the owner still calls a thread active", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		// The daemon lets the turn go, so only the owner's own phase can refuse the reap.
		context.session.hooks.onTerminal?.("thread-1", "turn-1", { status: "completed", finalResponse: "done" });
		await settle();

		await context.sweep(REAP_QUIET);

		expect(context.released).toEqual([]);
	});

	it("reaps nothing while a command is in flight", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.completeTurn("turn-1", "done");
		await settle();

		// A reconcile held inside its read: no turn of its own, so only the lease can refuse the reap.
		let read = () => {};
		context.session.readGate = new Promise<void>((resolve) => {
			read = resolve;
		});
		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();

		await context.sweep(REAP_QUIET);
		expect(context.released).toEqual([]);

		read();
		await settle();
	});
});

describe("Codex bookkeeping under churn", () => {
	/** Binds without starting a turn. */
	function reconcileOn(threadId: string, agentId: string) {
		return {
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId,
			target: RESOLVED_TARGET,
			threadId,
		};
	}

	it("keeps the agent of a thread the owner is still working, however many follow it", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;

		// Far past any bound, on threads the owner never loaded.
		for (let index = 0; index < 400; index += 1) {
			context.service.handleCommand(reconcileOn(`spare-${index}`, AGENT_ID));
			await settle();
		}
		context.sent.length = 0;

		// A turn this daemon never bound, so only the thread's own binding can answer for it.
		context.session.hooks.onTerminal?.("thread-1", "turn-99", { status: "completed", finalResponse: "done" });
		await settle();

		expect(terminalsOf(context.sent)).toMatchObject([{ agentId: AGENT_ID, threadId: "thread-1" }]);
	});

	it("forgets the binding of a settled thread once enough follow it", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();

		for (let index = 0; index < 400; index += 1) {
			context.service.handleCommand(reconcileOn(`spare-${index}`, AGENT_ID));
			await settle();
		}
		context.sent.length = 0;

		// Bound out, and the turn never bound.
		context.session.hooks.onTerminal?.("spare-0", "turn-77", { status: "completed", finalResponse: "late" });
		await settle();

		expect(terminalsOf(context.sent)).toEqual([]);
	});

	it("keeps the binding it just made, even with nothing else evictable", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();

		// Only the newest is evictable.
		for (let index = 0; index < 300; index += 1) {
			context.session.setPhase(`busy-${index}`, { phase: "active", turnId: `t-${index}`, epoch: 1 });
			context.service.handleCommand(reconcileOn(`busy-${index}`, AGENT_ID));
			await settle();
		}
		context.service.handleCommand(reconcileOn("fresh", AGENT_ID));
		await settle();
		context.sent.length = 0;

		context.session.hooks.onTerminal?.("fresh", "turn-55", { status: "completed", finalResponse: "done" });
		await settle();

		expect(terminalsOf(context.sent)).toMatchObject([{ agentId: AGENT_ID, threadId: "fresh" }]);
	});

	it("drains to the bound when threads the owner was working settle together", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();

		for (let index = 0; index < 300; index += 1) {
			context.session.setPhase(`busy-${index}`, { phase: "active", turnId: `t-${index}`, epoch: 1 });
			context.service.handleCommand(reconcileOn(`busy-${index}`, AGENT_ID));
			await settle();
		}
		// A backlog to clear, not one entry.
		for (let index = 0; index < 300; index += 1) {
			context.session.setPhase(`busy-${index}`, { phase: "parked", epoch: 1 });
		}
		context.service.handleCommand(reconcileOn("last", AGENT_ID));
		await settle();
		context.sent.length = 0;

		// Goes only if the bind drained.
		context.session.hooks.onTerminal?.("busy-1", "turn-56", { status: "completed", finalResponse: "late" });
		await settle();

		expect(terminalsOf(context.sent)).toEqual([]);
	});

	it("answers a turn on a churned-out thread from the gateway's own reconcile", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.session.completeTurn("turn-1", "done");
		await settle();

		for (let index = 0; index < 400; index += 1) {
			context.service.handleCommand(reconcileOn(`spare-${index}`, AGENT_ID));
			await settle();
		}
		context.sent.length = 0;

		// Its binding is gone, so the gateway asking again is what restores it.
		context.service.handleCommand(reconcileOn("thread-1", AGENT_ID));
		await settle();
		context.session.hooks.onTerminal?.("thread-1", "turn-9", { status: "completed", finalResponse: "late" });
		await settle();

		expect(terminalsOf(context.sent)).toMatchObject([{ agentId: AGENT_ID, threadId: "thread-1" }]);
	});
});

describe("Codex daemon commands", () => {
	it("starts a thread and reports the accepted delivery", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();

		expect(context.session.calls).toEqual(["startThread", "startTurn"]);
		expect(context.sent).toMatchObject([
			{
				type: "codex_receipt",
				kind: "accepted",
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				threadId: "thread-1",
				turnId: "turn-1",
				delivery: "started",
				generation: 3,
				eventId: 0,
			},
		]);
	});

	it("steers a live turn and starts a new one only once that turn has settled", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();

		const message = {
			type: "codex_command",
			kind: "message",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: "123e4567-e89b-42d3-a456-426614174002",
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			expectedTurnId: "turn-1",
			prompt: "Also check the lexer",
		};
		context.service.handleCommand(message);
		await settle();
		expect(context.sent.at(-1)).toMatchObject({ kind: "accepted", delivery: "steered", turnId: "turn-1" });

		context.session.completeTurn("turn-1", "done");
		await settle();
		context.service.handleCommand({ ...message, operationId: "123e4567-e89b-42d3-a456-426614174003" });
		await settle();

		expect(context.sent.at(-1)).toMatchObject({ kind: "accepted", delivery: "started", turnId: "turn-2" });
	});

	it("starts a new turn when a steered turn ends while the steer is still in flight", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;

		let landed = () => {};
		context.session.steerGate = new Promise<void>((resolve) => {
			landed = resolve;
		});
		context.service.handleCommand({
			type: "codex_command",
			kind: "message",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: OPERATION_ID_TWO,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			expectedTurnId: "turn-1",
			prompt: "Also check the lexer",
		});
		await settle();

		context.session.completeTurn("turn-1", "done");
		await settle();
		landed();
		await settle();

		// Reporting the steer accepted would leave the gateway waiting on a turn that already ended.
		expect(context.sent.at(-1)).toMatchObject({ kind: "accepted", delivery: "started", turnId: "turn-2" });
	});

	it("refuses to re-send a steered prompt while App Server still has the thread working", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.calls.length = 0;

		let landed = () => {};
		context.session.steerGate = new Promise<void>((resolve) => {
			landed = resolve;
		});
		context.service.handleCommand({
			type: "codex_command",
			kind: "message",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: OPERATION_ID_TWO,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			expectedTurnId: "turn-1",
			prompt: "Also check the lexer",
		});
		await settle();

		context.session.completeTurn("turn-1", "done");
		await settle();
		context.session.threadReadResult = {
			thread: { id: "thread-1", turns: [{ id: "turn-9", status: "inProgress", items: [] }] },
		};
		landed();
		await settle();

		// Re-sending would run one prompt twice, with the write and network access it carries.
		expect(context.session.calls).not.toContain("startTurn");
		expect(context.sent.at(-1)).toMatchObject({ kind: "rejected", agentId: AGENT_ID });
	});

	it("refuses a command whose target cannot run, without retaining the refusal", async () => {
		const context = setup({ availability: { state: "unavailable", errorClass: "noSuchContainer" } });
		context.service.handleCommand(startCommand());
		await settle();

		expect(context.sent).toMatchObject([{ kind: "rejected", agentId: AGENT_ID, operationId: OPERATION_ID }]);
		context.sent.length = 0;
		context.service.replay();
		expect(context.sent).toEqual([]);
	});

	it("reports a turn's terminal to the agent that owns it", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;

		context.session.completeTurn("turn-1", "391");
		await settle();

		expect(context.sent).toMatchObject([
			{
				type: "codex_event",
				kind: "terminal",
				state: "completed",
				finalResponse: "391",
				agentId: AGENT_ID,
				ownerKey: OWNER_KEY,
				turnId: "turn-1",
			},
		]);
	});

	it("streams commentary as its own event without retaining it", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;

		context.session.listener({
			method: "item/completed",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				item: { type: "agentMessage", id: "item-9", text: "reading the parser", phase: "commentary" },
			},
		});
		await settle();

		expect(context.sent).toMatchObject([{ kind: "activity", itemId: "item-9", text: "reading the parser" }]);
		context.sent.length = 0;
		context.service.replay();
		expect(context.sent.filter((message) => message.kind === "activity")).toEqual([]);
	});

	it("replays unacknowledged receipts and retires acknowledged ones", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;

		context.service.replay();
		expect(context.sent).toHaveLength(1);

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

	it("keeps a receipt an acknowledgement for another generation cannot retire", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;

		context.service.acknowledge({
			type: "codex_ack",
			daemonInstanceId: "daemon-1",
			targetId: TARGET_ID,
			generation: 2,
			throughEventId: 99,
		});
		context.service.replay();

		expect(context.sent).toHaveLength(1);
	});

	it("announces its instance and every live generation", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();

		expect(context.service.hello()).toEqual({
			type: "codex_hello",
			daemonInstanceId: "daemon-1",
			targets: [{ targetId: TARGET_ID, generation: 3 }],
		});
	});

	it("reconciles a settled turn by re-fencing first and reporting the outcome after", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.threadReadResult = {
			thread: {
				id: "thread-1",
				turns: [
					{
						id: "turn-1",
						status: "completed",
						items: [{ type: "agentMessage", id: "item-4", text: "recovered", phase: "final_answer" }],
					},
				],
			},
		};

		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();

		expect(context.sent).toMatchObject([
			{ type: "codex_receipt", kind: "reconciled", turnId: "turn-1", turnState: "completed" },
			{ type: "codex_event", kind: "terminal", state: "completed", finalResponse: "recovered" },
		]);
		expect((context.sent[0] as { eventId: number }).eventId).toBeLessThan(
			(context.sent[1] as { eventId: number }).eventId,
		);
	});

	it("says nothing about a turn App Server cannot account for, rather than inventing a failure", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.threadReadResult = { thread: { id: "thread-1", turns: [] } };

		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-9",
		});
		await settle();

		// No turnState and no terminal: the record stays recovering and eligible to be asked again.
		expect(context.sent).toMatchObject([{ kind: "reconciled", turnId: "turn-9" }]);
		expect(context.sent[0]?.turnState).toBeUndefined();
	});

	it("reports a turn App Server still calls in-progress as in-progress, even after a restart", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.threadReadResult = {
			thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] },
		};

		context.service.handleCommand({
			type: "codex_command",
			kind: "reconcile",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
		});
		await settle();

		expect(context.sent).toMatchObject([{ kind: "reconciled", turnId: "turn-1", turnState: "inProgress" }]);
	});

	it("reports a turn that started despite a failed startTurn rather than refusing it", async () => {
		const context = setup();
		context.session.startTurnFails = new Error("connection reset");
		context.session.threadReadResult = {
			thread: { id: "thread-1", turns: [{ id: "turn-live", status: "inProgress", items: [] }] },
		};
		context.service.handleCommand(startCommand());
		await settle();

		expect(context.sent).toMatchObject([{ kind: "accepted", threadId: "thread-1", turnId: "turn-live" }]);
		// Adopted, never sent again: the prompt may already have run.
		expect(context.session.calls.filter((call) => call === "startTurn")).toHaveLength(1);
	});

	it("refuses a start whose turn App Server confirms never began", async () => {
		const context = setup();
		context.session.startTurnFails = new Error("connection reset");
		context.session.threadReadResult = { thread: { id: "thread-1", turns: [] } };
		context.service.handleCommand(startCommand());
		await settle();

		expect(context.sent).toMatchObject([{ kind: "rejected", agentId: AGENT_ID }]);
	});

	it("refuses a steer that failed for a reason other than its turn ending", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.calls.length = 0;
		context.session.steerFails = new Error("thread is busy");
		context.session.threadReadResult = {
			thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] },
		};

		context.service.handleCommand({
			type: "codex_command",
			kind: "message",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: "123e4567-e89b-42d3-a456-426614174002",
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			expectedTurnId: "turn-1",
			prompt: "Also check the lexer",
		});
		await settle();

		// The turn is still running, so this was not the completed-during-delivery race. Starting a
		// second turn here would run the prompt twice.
		expect(context.sent).toMatchObject([{ kind: "rejected" }]);
		expect(context.session.calls).not.toContain("startTurn");
	});

	it("starts one new turn when the steered turn finished during delivery", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.steerFails = new Error("turn already completed");
		context.session.threadReadResult = {
			thread: {
				id: "thread-1",
				turns: [
					{ id: "turn-1", status: "completed", items: [{ type: "agentMessage", id: "i", text: "done" }] },
				],
			},
		};

		context.service.handleCommand({
			type: "codex_command",
			kind: "message",
			requestId: REQUEST_ID,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: "123e4567-e89b-42d3-a456-426614174002",
			target: RESOLVED_TARGET,
			threadId: "thread-1",
			expectedTurnId: "turn-1",
			prompt: "Also check the lexer",
		});
		await settle();

		expect(context.sent).toMatchObject([{ kind: "accepted", delivery: "started", turnId: "turn-2" }]);
	});

	it("reports a delivered interrupt without ending the turn", async () => {
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

		expect(context.sent).toMatchObject([{ kind: "interruptResult", ok: true, turnId: "turn-1" }]);
	});

	it("drops a malformed command instead of dispatching it", async () => {
		const context = setup();
		context.service.handleCommand({ ...startCommand(), prompt: "   " });
		await settle();

		expect(context.session.calls).toEqual([]);
		expect(context.sent).toEqual([]);
	});
});
