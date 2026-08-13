import { describe, expect, it } from "vitest";
import { decideAcceptance, withActivity } from "../gateway/codexAgentReducers.js";
import { CodexPersistedAgentSchema } from "../shared/codex-thinking.js";
import { setup } from "./helpers/codex-persistence.js";
import { AGENT_ID, OPERATION_ID } from "./helpers/codex-thinking.js";

////////////////////////////////
//  Tests
//
//  The verdict decides whether the daemon may retire its only copy of a receipt: refuse retires,
//  unresolved holds. Driven directly, with records built by the real service.

const MESSAGE_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const TARGET = { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/trusted/recipe-app" } as const;
const RESOLVED = { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" } as const;
const fence = (lastEventId: number) => ({
	daemonInstanceId: "daemon-1",
	targetId: "container:recipe-app",
	generation: 1,
	lastEventId,
});

/** A working agent with an accepted start and one REQUESTED follow-up message. */
function workingAgentWithPendingMessage() {
	const { request, owner, service, sessionStore } = setup();
	service.beginStart(request, {
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		prompt: "Review",
		target: TARGET,
		at: 20,
	});
	service.acceptDelivery(request, {
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		resolvedTarget: RESOLVED,
		threadId: "thread-1",
		turnId: "turn-1",
		delivery: "started",
		fence: fence(2),
		at: 21,
	});
	service.beginMessage(request, { agentId: AGENT_ID, operationId: MESSAGE_OPERATION_ID, prompt: "Continue", at: 22 });
	const agent = sessionStore.codexCatalog(owner)!.agents[0]!;
	const operation = agent.operations.find((op) => op.operationId === MESSAGE_OPERATION_ID)!;
	const exchange = agent.exchanges.find((ex) => ex.operationId === MESSAGE_OPERATION_ID)!;
	return { agent, operation, exchange };
}

describe("decideAcceptance", () => {
	it("accepts a steer of the active turn when the fence advances", () => {
		const { agent, operation, exchange } = workingAgentWithPendingMessage();
		const verdict = decideAcceptance({
			current: agent,
			operation,
			exchange,
			input: { turnId: "turn-1", delivery: "steered", threadId: "thread-1" },
			resolvedTarget: RESOLVED,
			fence: fence(3),
		});
		expect(verdict).toEqual({ kind: "accept", steeredIntoSettledTurn: false });
	});

	it("holds a receipt it cannot place instead of retiring it: a foreign fence is unresolved, never refuse", () => {
		const { agent, operation, exchange } = workingAgentWithPendingMessage();
		const verdict = decideAcceptance({
			current: agent,
			operation,
			exchange,
			input: { turnId: "turn-1", delivery: "steered", threadId: "thread-1" },
			resolvedTarget: RESOLVED,
			fence: { ...fence(9), daemonInstanceId: "daemon-2" },
		});
		expect(verdict).toEqual({ kind: "unresolved" });
	});

	it("splits the adjacent boundary right: a moved record refuses, a non-advancing fence holds", () => {
		const { agent, operation, exchange } = workingAgentWithPendingMessage();
		const input = { turnId: "turn-1", delivery: "steered", threadId: "thread-1" } as const;
		// An activity landed between dispatch and receipt, so the record no longer matches what the
		// prompt was dispatched against: the receipt never applies, retire it.
		const moved = withActivity(agent, 0, "item-1", "thinking", 23, fence(3));
		expect(
			decideAcceptance({ current: moved, operation, exchange, input, resolvedTarget: RESOLVED, fence: fence(4) }),
		).toEqual({ kind: "refuse" });
		// The record untouched, but the fence does not advance the pre-dispatch one: hold.
		expect(
			decideAcceptance({ current: agent, operation, exchange, input, resolvedTarget: RESOLVED, fence: fence(2) }),
		).toEqual({ kind: "unresolved" });
	});

	it("refuses what will never apply: a started delivery for a message aimed at a working agent", () => {
		const { agent, operation, exchange } = workingAgentWithPendingMessage();
		const verdict = decideAcceptance({
			current: agent,
			operation,
			exchange,
			input: { turnId: "turn-9", delivery: "started", threadId: "thread-1" },
			resolvedTarget: RESOLVED,
			fence: fence(3),
		});
		expect(verdict).toEqual({ kind: "refuse" });
	});

	it("accepts a steer that landed in the settled turn without reopening it", () => {
		const { agent, operation, exchange } = workingAgentWithPendingMessage();
		// The expected turn settled while the daemon was steering: idle, no active turn, fence moved.
		const settled = CodexPersistedAgentSchema.parse({
			...agent,
			agentState: "idle",
			activeTurnId: undefined,
			turns: agent.turns.map((turn) =>
				turn.id === "turn-1"
					? { id: turn.id, state: "completed", activities: [], finalResponse: "done", updatedAt: 23 }
					: turn,
			),
			fence: fence(4),
			updatedAt: 23,
		});
		const verdict = decideAcceptance({
			current: settled,
			operation,
			exchange,
			input: { turnId: "turn-1", delivery: "steered", threadId: "thread-1" },
			resolvedTarget: RESOLVED,
			fence: fence(5),
		});
		expect(verdict).toEqual({ kind: "accept", steeredIntoSettledTurn: true });
	});

	it("replays an accepted receipt that matches, and calls the one that contradicts a conflict", () => {
		const { agent } = workingAgentWithPendingMessage();
		const startOperation = agent.operations.find((op) => op.operationId === OPERATION_ID)!;
		const startExchange = agent.exchanges.find((ex) => ex.operationId === OPERATION_ID)!;
		const matches = decideAcceptance({
			current: agent,
			operation: startOperation,
			exchange: startExchange,
			input: { turnId: "turn-1", delivery: "started", threadId: "thread-1" },
			resolvedTarget: RESOLVED,
			fence: fence(2),
		});
		expect(matches).toEqual({ kind: "replayed" });
		const contradicts = decideAcceptance({
			current: agent,
			operation: startOperation,
			exchange: startExchange,
			input: { turnId: "turn-OTHER", delivery: "started", threadId: "thread-1" },
			resolvedTarget: RESOLVED,
			fence: fence(2),
		});
		expect(contradicts).toEqual({ kind: "conflict" });
	});

	it("calls an accepted-but-unfenced operation unplaceable, since only reconciliation can place it", () => {
		const { agent } = workingAgentWithPendingMessage();
		const startOperation = agent.operations.find((op) => op.operationId === OPERATION_ID)!;
		const startExchange = agent.exchanges.find((ex) => ex.operationId === OPERATION_ID)!;
		const verdict = decideAcceptance({
			current: agent,
			operation: { ...startOperation, acceptanceUnverified: true },
			exchange: startExchange,
			input: { turnId: "turn-1", delivery: "started", threadId: "thread-1" },
			resolvedTarget: RESOLVED,
			fence: fence(2),
		});
		expect(verdict).toEqual({ kind: "unplaceable" });
	});

	it("refuses a stop receipt outright: stops settle through turn terminals, never deliveries", () => {
		const { agent, operation, exchange } = workingAgentWithPendingMessage();
		// An exchange's kind can never be "stop" by type, so the stop rule and the kind-mismatch rule
		// beside it are inseparable by construction: every stop receipt trips both.
		const verdict = decideAcceptance({
			current: agent,
			operation: { ...operation, kind: "stop" },
			exchange,
			input: { turnId: "turn-1", delivery: "steered", threadId: "thread-1" },
			resolvedTarget: RESOLVED,
			fence: fence(3),
		});
		expect(verdict).toEqual({ kind: "refuse" });
	});
});
