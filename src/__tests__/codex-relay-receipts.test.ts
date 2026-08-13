import { describe, expect, it } from "vitest";
import { CodexTransitionError } from "../gateway/codexAgentService.js";
import {
	AGENT_ID,
	currentAgent,
	DEVCONTAINER_TARGET,
	eventBase,
	RESOLVED_TARGET,
	receiptBase,
	START_OPERATION,
	STOP_OPERATION,
	settleRelay,
	setup,
	TARGET_ID,
	working,
} from "./helpers/codex-relay.js";

describe("Codex daemon receipt application", () => {
	function stopping(context: ReturnType<typeof setup>) {
		context.service.beginStop(context.request, { agentId: AGENT_ID, operationId: STOP_OPERATION, at: 12 });
		return context;
	}

	it("keeps the interrupt pending until the turn's own terminal lands", () => {
		const context = stopping(working(setup()));
		const delivered = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 1),
				kind: "interruptResult",
				operationId: STOP_OPERATION,
				threadId: "thread-1",
				turnId: "turn-1",
				ok: true,
			},
			20,
		);

		expect(delivered.disposition).toBe("applied");
		expect(currentAgent(context).pendingInterrupt).toBeDefined();

		context.service.applyEvent({ ...eventBase(context.ownerKey, 2), kind: "terminal", state: "interrupted" }, 21);
		const agent = currentAgent(context);
		expect(agent.pendingInterrupt).toBeUndefined();
		expect(agent.turns[0]?.state).toBe("interrupted");
	});

	it("settles a stop that lost the race to completion", () => {
		const context = stopping(working(setup()));
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "done" },
			20,
		);

		const agent = currentAgent(context);
		expect(agent.turns[0]?.state).toBe("completed");
		expect(agent.operations.find((operation) => operation.kind === "stop")?.state).toBe("accepted");
		expect(agent.pendingInterrupt).toBeUndefined();
	});

	it("clears the pending interrupt when the daemon could not deliver it", () => {
		const context = stopping(working(setup()));
		const failed = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 1),
				kind: "interruptFailed",
				operationId: STOP_OPERATION,
				threadId: "thread-1",
				turnId: "turn-1",
				ok: false,
				error: "app server exited",
			},
			20,
		);

		expect(failed.disposition).toBe("applied");
		const agent = currentAgent(context);
		expect(agent.pendingInterrupt).toBeUndefined();
		expect(agent.operations.find((operation) => operation.kind === "stop")?.state).toBe("indeterminate");
	});

	it("marks a refused start unavailable rather than leaving it being created", () => {
		const context = setup();
		context.service.beginStart(context.request, {
			agentId: AGENT_ID,
			operationId: START_OPERATION,
			prompt: "Audit",
			target: DEVCONTAINER_TARGET,
			at: 10,
		});
		const refused = context.service.applyReceipt(
			{
				type: "codex_receipt",
				kind: "rejected",
				requestId: "123e4567-e89b-42d3-a456-4266141740aa",
				ownerKey: context.ownerKey,
				daemonInstanceId: "daemon-1",
				eventId: 1,
				agentId: AGENT_ID,
				operationId: START_OPERATION,
				error: "execution target is unavailable",
			},
			20,
		);

		expect(refused.disposition).toBe("applied");
		const agent = currentAgent(context);
		expect(agent.agentState).toBe("unavailable");
		expect(agent.exchanges[0]?.status).toBe("indeterminate");
	});

	it("records a steer whose receipt was overtaken by its own turn's terminal", () => {
		const context = working(setup());
		const MESSAGE_OPERATION = "123e4567-e89b-42d3-a456-42661417400a";
		context.service.beginMessage(context.request, {
			agentId: AGENT_ID,
			operationId: MESSAGE_OPERATION,
			prompt: "Also check the lexer",
			at: 12,
		});
		// The terminal wins the race to the gateway, which is what the transport's own ordering used to
		// guarantee: a reply only schedules its continuation, while a notification fired inline.
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "both" },
			13,
		);

		const accepted = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 2),
				kind: "accepted",
				operationId: MESSAGE_OPERATION,
				resolvedTarget: RESOLVED_TARGET,
				threadId: "thread-1",
				turnId: "turn-1",
				delivery: "steered",
			},
			14,
		);

		expect(accepted.disposition).toBe("applied");
		const agent = currentAgent(context);
		// The delivery is recorded against the turn that answered it, and that turn stays settled.
		expect(agent.exchanges.at(-1)).toMatchObject({ delivery: "steered", turnId: "turn-1", status: "accepted" });
		expect(agent.turns[0]?.state).toBe("completed");
		expect(agent.activeTurnId).toBeUndefined();
		expect(agent.agentState).toBe("idle");
	});

	it("settles a delivery it refuses instead of leaving the agent wedged", () => {
		const context = working(setup());
		const MESSAGE_OPERATION = "123e4567-e89b-42d3-a456-42661417400b";
		context.service.beginMessage(context.request, {
			agentId: AGENT_ID,
			operationId: MESSAGE_OPERATION,
			prompt: "Continue",
			at: 12,
		});

		// A delivery naming a turn this record has never seen, while its own turn is still running.
		const refused = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 2),
				kind: "accepted",
				operationId: MESSAGE_OPERATION,
				resolvedTarget: RESOLVED_TARGET,
				threadId: "thread-1",
				turnId: "turn-9",
				delivery: "started",
			},
			14,
		);

		expect(refused.disposition).toBe("ignored");
		const agent = currentAgent(context);
		expect(agent.operations.at(-1)?.state).toBe("indeterminate");
		expect(agent.agentState).toBe("recovering");
	});

	it("holds a refused message in recovery so a second prompt cannot follow it", () => {
		const context = working(setup());
		const MESSAGE_OPERATION = "123e4567-e89b-42d3-a456-426614174007";
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "first" },
			13,
		);
		context.service.beginMessage(context.request, {
			agentId: AGENT_ID,
			operationId: MESSAGE_OPERATION,
			prompt: "Continue",
			at: 14,
		});

		context.service.applyReceipt(
			{
				type: "codex_receipt",
				kind: "rejected",
				requestId: "123e4567-e89b-42d3-a456-4266141740aa",
				ownerKey: context.ownerKey,
				daemonInstanceId: "daemon-1",
				eventId: 2,
				agentId: AGENT_ID,
				operationId: MESSAGE_OPERATION,
				error: "codex thread produced no turn",
			},
			15,
		);

		// The daemon can only prove non-delivery as far as it could read, so the agent waits for
		// reconciliation rather than accepting another prompt that might run the same work twice.
		expect(currentAgent(context).agentState).toBe("recovering");
		expect(() =>
			context.service.beginMessage(context.request, {
				agentId: AGENT_ID,
				operationId: "123e4567-e89b-42d3-a456-426614174008",
				prompt: "Continue again",
				at: 16,
			}),
		).toThrowError(CodexTransitionError);
	});

	it("re-fences a reconciled agent so the terminal that follows applies", () => {
		const context = working(setup());
		const reconciled = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 5),
				generation: 4,
				kind: "reconciled",
				resolvedTarget: RESOLVED_TARGET,
				threadId: "thread-1",
				turnId: "turn-1",
				turnState: "completed",
			},
			20,
		);

		expect(reconciled.disposition).toBe("applied");
		expect(currentAgent(context).agentState).toBe("recovering");

		const terminal = context.service.applyEvent(
			{
				...eventBase(context.ownerKey, 6),
				generation: 4,
				kind: "terminal",
				state: "completed",
				finalResponse: "recovered",
			},
			21,
		);
		expect(terminal.disposition).toBe("applied");
		expect(currentAgent(context).turns[0]).toMatchObject({ state: "completed", finalResponse: "recovered" });
	});

	it("accepts a new turn for a message whose steered turn finished during delivery", () => {
		const context = working(setup());
		const MESSAGE_OPERATION = "123e4567-e89b-42d3-a456-426614174005";
		context.service.beginMessage(context.request, {
			agentId: AGENT_ID,
			operationId: MESSAGE_OPERATION,
			prompt: "Also check the lexer",
			at: 12,
		});
		// The turn the message was aimed at ends before the daemon's steer lands.
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "first" },
			13,
		);

		const accepted = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 2),
				kind: "accepted",
				operationId: MESSAGE_OPERATION,
				resolvedTarget: RESOLVED_TARGET,
				threadId: "thread-1",
				turnId: "turn-2",
				delivery: "started",
			},
			14,
		);

		expect(accepted.disposition).toBe("applied");
		const agent = currentAgent(context);
		expect(agent.activeTurnId).toBe("turn-2");
		expect(agent.exchanges.at(-1)).toMatchObject({ delivery: "started", turnId: "turn-2" });
	});

	it("withholds acknowledgement of an acceptance it could not place", async () => {
		const context = working(setup());
		const MESSAGE_OPERATION = "123e4567-e89b-42d3-a456-426614174006";
		context.service.beginMessage(context.request, {
			agentId: AGENT_ID,
			operationId: MESSAGE_OPERATION,
			prompt: "Continue",
			at: 12,
		});
		context.sent.length = 0;

		context.relay.handleHostMessage({
			...receiptBase(context.ownerKey, 4),
			generation: 9,
			kind: "accepted",
			operationId: MESSAGE_OPERATION,
			resolvedTarget: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "steered",
		});
		await settleRelay();

		expect(context.sent.filter((message) => message.type === "codex_ack")).toEqual([]);
		expect(context.sent.filter((message) => message.type === "codex_command")).toMatchObject([
			{ kind: "reconcile" },
		]);
	});

	it("asks again after a refused reconcile instead of going quiet for good", async () => {
		const context = working(setup());
		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-1",
			targets: [{ targetId: TARGET_ID, generation: 1 }],
		});
		await settleRelay();
		expect(context.sent.filter((message) => message.type === "codex_command")).toHaveLength(1);

		// The daemon cannot reach the target. A refused reconcile carries no operationId at all.
		context.relay.handleHostMessage({
			type: "codex_receipt",
			kind: "rejected",
			requestId: "123e4567-e89b-42d3-a456-4266141740bb",
			ownerKey: context.ownerKey,
			daemonInstanceId: "daemon-1",
			eventId: 1,
			agentId: AGENT_ID,
			error: "execution target is unavailable",
		});
		await settleRelay();

		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-1",
			targets: [{ targetId: TARGET_ID, generation: 2 }],
		});
		await settleRelay();

		expect(context.sent.filter((message) => message.type === "codex_command")).toHaveLength(2);
	});

	it("returns a survived turn to working", () => {
		const context = working(setup());
		context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 5),
				generation: 4,
				kind: "reconciled",
				resolvedTarget: RESOLVED_TARGET,
				threadId: "thread-1",
				turnId: "turn-1",
				turnState: "inProgress",
			},
			20,
		);

		expect(currentAgent(context).agentState).toBe("working");
	});
});
