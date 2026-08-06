import { describe, expect, it } from "vitest";
import type { AppServerSession } from "../mcp/devcontainer/codexDaemonService.js";
import { CodexDaemonService, resolveCodexTarget } from "../mcp/devcontainer/codexDaemonService.js";
import type { CodexChild, TargetAvailability, TargetSupervisor } from "../mcp/devcontainer/codexTargets.js";
import type { CodexResolvedTarget } from "../shared/codex-thinking.js";

const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const TARGET_ID = "container:recipe-app";
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
	read: unknown = { thread: { id: "thread-1", turns: [] } };

	onEvent(listener: (message: { method: string; params?: unknown }) => void) {
		this.listener = listener;
	}
	async startThread() {
		this.calls.push("startThread");
		return "thread-1";
	}
	async resumeThread() {
		this.calls.push("resumeThread");
	}
	async readThread() {
		this.calls.push("readThread");
		return this.read;
	}
	async startTurn() {
		this.calls.push("startTurn");
		if (this.startTurnFails) throw this.startTurnFails;
		this.turnCounter += 1;
		return `turn-${this.turnCounter}`;
	}
	async steerTurn() {
		this.calls.push("steerTurn");
		if (this.steerFails) throw this.steerFails;
	}
	async interruptTurn() {
		this.calls.push("interruptTurn");
	}
	close() {
		this.calls.push("close");
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

function setup(options: { availability?: TargetAvailability } = {}) {
	const session = new FakeSession();
	const child = {} as CodexChild;
	const released: string[] = [];
	const targets: TargetSupervisor = {
		acquire: () => options.availability ?? { state: "running", lease: { generation: 3, child } },
		release: (targetId) => released.push(targetId),
	};
	const sent: Record<string, unknown>[] = [];
	const service = new CodexDaemonService({
		targets,
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => session,
		resolveHostCwd: () => "/home/agent",
	});
	return { service, session, sent, released };
}

/** Let the service's own promise chain drain. Commands are serialized, so a handful of ticks covers
 * every await one command performs. */
async function settle() {
	for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}

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
		expect(resolveCodexTarget({ kind: "host", workdirHint: "Codex Support" }, () => "/home/agent")).toEqual({
			kind: "host",
			targetId: "host",
			cwd: "/home/agent",
		});
	});

	it("resolves a container target to its workspace without consulting the host rule", () => {
		expect(
			resolveCodexTarget(
				{ kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
				() => {
					throw new Error("host rule must not be consulted for a container");
				},
			),
		).toEqual({ kind: "devcontainer", targetId: TARGET_ID, cwd: "/workspace/recipe-app" });
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
		context.session.read = {
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
		context.session.read = { thread: { id: "thread-1", turns: [] } };

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
		context.session.read = {
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
		context.session.read = {
			thread: { id: "thread-1", turns: [{ id: "turn-live", status: "inProgress", items: [] }] },
		};
		context.service.handleCommand(startCommand());
		await settle();

		expect(context.sent).toMatchObject([{ kind: "accepted", threadId: "thread-1", turnId: "turn-live" }]);
	});

	it("refuses a start whose turn App Server confirms never began", async () => {
		const context = setup();
		context.session.startTurnFails = new Error("connection reset");
		context.session.read = { thread: { id: "thread-1", turns: [] } };
		context.service.handleCommand(startCommand());
		await settle();

		expect(context.sent).toMatchObject([{ kind: "rejected", agentId: AGENT_ID }]);
	});

	it("refuses a steer that failed for a reason other than its turn ending", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.steerFails = new Error("thread is busy");
		context.session.read = {
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
		expect(context.session.calls).not.toContain("startTurn2");
	});

	it("starts one new turn when the steered turn finished during delivery", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.sent.length = 0;
		context.session.steerFails = new Error("turn already completed");
		context.session.read = {
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
