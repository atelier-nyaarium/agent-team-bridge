import { describe, expect, it } from "vitest";
import {
	CodexListAgentsResultSchema,
	CodexPersistedAgentSchema,
	codexOperationFingerprint,
	projectCodexListAgent,
	projectCodexListResult,
} from "../shared/codex-thinking.js";
import { AGENT_ID, requestedAgent } from "./helpers/codex-thinking.js";

const ACCEPTANCE_FENCE = {
	daemonInstanceId: "daemon-1",
	targetId: "container:recipe-app",
	generation: 1,
	lastEventId: 2,
};

describe("Codex persisted and list contracts", () => {
	it("projects validated persisted agents without recovery-only fields", () => {
		const persisted = requestedAgent();
		const projected = projectCodexListAgent(persisted);
		const result = projectCodexListResult([persisted], {
			code: "daemon_unavailable",
			message: "Reconnect pending",
			retryable: true,
		});
		const serialized = JSON.stringify(result);

		expect(projected).toMatchObject({
			agentId: AGENT_ID,
			agentState: "creating",
			exchanges: [{ kind: "start", prompt: "Review", status: "requested", createdAt: 10 }],
		});
		expect(result.observation).toBe("unavailable");
		expect(serialized).not.toContain("operationId");
		expect(serialized).not.toContain("exchangeId");
		expect(serialized).not.toContain("requestedTarget");
		expect(serialized).not.toContain("threadId");
	});

	it("validates a requested agent without exposing internal recovery fields in list output", () => {
		const persisted = requestedAgent();
		expect(CodexPersistedAgentSchema.safeParse(persisted).success).toBe(true);
		expect(CodexPersistedAgentSchema.safeParse({ ...persisted, agentState: "running" }).success).toBe(false);
		expect(CodexPersistedAgentSchema.safeParse({ ...persisted, unknown: true }).success).toBe(false);

		const listRow = {
			agentId: AGENT_ID,
			agentState: "creating",
			exchanges: [{ kind: "start", prompt: "Review", status: "requested", createdAt: 10 }],
			turns: [],
			createdAt: 10,
			updatedAt: 10,
		};
		expect(CodexListAgentsResultSchema.safeParse({ agents: [listRow] }).success).toBe(true);
		expect(
			CodexListAgentsResultSchema.safeParse({ agents: [{ ...listRow, operations: persisted.operations }] })
				.success,
		).toBe(false);
		expect(
			CodexListAgentsResultSchema.safeParse({ agents: [{ ...listRow, exchanges: persisted.exchanges }] }).success,
		).toBe(false);
		expect(
			CodexListAgentsResultSchema.safeParse({ agents: [{ ...listRow, activeTurnId: "turn-1" }] }).success,
		).toBe(false);
		expect(
			CodexListAgentsResultSchema.safeParse({
				agents: [
					{
						...listRow,
						exchanges: [
							...listRow.exchanges,
							{ kind: "message", prompt: "Queued", status: "requested", createdAt: 10 },
						],
					},
				],
			}).success,
		).toBe(false);
	});

	it("rejects persisted agents whose active turn cannot be recovered", () => {
		const persisted = requestedAgent();
		const dangling = {
			...persisted,
			agentState: "working",
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			threadId: "thread-1",
			activeTurnId: "missing",
		};

		expect(CodexPersistedAgentSchema.safeParse(dangling).success).toBe(false);
	});

	it("rejects dangling or contradictory persisted operation references", () => {
		const persisted = requestedAgent();
		const exchange = persisted.exchanges[0]!;
		const operation = persisted.operations[0]!;

		expect(
			CodexPersistedAgentSchema.safeParse({
				...persisted,
				exchanges: [{ ...exchange, operationId: "123e4567-e89b-42d3-a456-426614174001" }],
			}).success,
		).toBe(false);
		expect(
			CodexPersistedAgentSchema.safeParse({
				...persisted,
				operations: [{ ...operation, kind: "message" }],
			}).success,
		).toBe(false);
		expect(
			CodexPersistedAgentSchema.safeParse({
				...persisted,
				exchanges: [
					{ ...exchange, status: "accepted", delivery: "started", turnId: "missing", acceptedAt: 11 },
				],
				operations: [{ ...operation, state: "accepted", turnId: "missing" }],
			}).success,
		).toBe(false);
	});

	it("ties native history to its thread and represents idle stop as an explicit no-op", () => {
		const persisted = requestedAgent();
		const turn = { id: "turn-1", state: "completed", activities: [], finalResponse: "Done", updatedAt: 12 };
		const accepted = {
			...persisted,
			agentState: "idle",
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			threadId: "thread-1",
			exchanges: [
				{
					...persisted.exchanges[0]!,
					status: "accepted",
					delivery: "started",
					turnId: "turn-1",
					acceptedAt: 11,
				},
			],
			turns: [turn],
			operations: [
				{
					...persisted.operations[0]!,
					state: "accepted",
					turnId: "turn-1",
					acceptanceFence: ACCEPTANCE_FENCE,
					updatedAt: 11,
				},
			],
			fence: ACCEPTANCE_FENCE,
			updatedAt: 12,
		};

		expect(CodexPersistedAgentSchema.safeParse(accepted).success).toBe(true);
		expect(
			CodexPersistedAgentSchema.safeParse({
				...accepted,
				turns: [{ ...turn, finalResponse: undefined }],
			}).success,
		).toBe(false);
		expect(CodexPersistedAgentSchema.safeParse({ ...accepted, agentState: "creating" }).success).toBe(false);
		expect(
			CodexPersistedAgentSchema.safeParse({ ...accepted, resolvedTarget: undefined, threadId: undefined })
				.success,
		).toBe(false);
		expect(
			CodexPersistedAgentSchema.safeParse({
				...accepted,
				turns: [
					{
						...turn,
						activities: [
							{ kind: "commentary", itemId: "item-1", text: "First" },
							{ kind: "commentary", itemId: "item-1", text: "Replay" },
						],
					},
				],
			}).success,
		).toBe(false);
		const steered = {
			...accepted,
			exchanges: [
				...accepted.exchanges,
				{
					exchangeId: "123e4567-e89b-42d3-a456-426614174004",
					operationId: "123e4567-e89b-42d3-a456-426614174004",
					kind: "message",
					prompt: "Steer",
					status: "accepted",
					delivery: "steered",
					turnId: "turn-1",
					createdAt: 12,
					acceptedAt: 12,
				},
			],
			operations: [
				...accepted.operations,
				{
					operationId: "123e4567-e89b-42d3-a456-426614174004",
					kind: "message",
					fingerprint: codexOperationFingerprint("message", AGENT_ID, "Steer"),
					state: "accepted",
					turnId: "turn-1",
					expectedTurnId: "turn-1",
					acceptanceFence: ACCEPTANCE_FENCE,
					preDispatch: {
						agentState: "working",
						threadId: "thread-1",
						turnId: "turn-1",
						fence: ACCEPTANCE_FENCE,
					},
					createdAt: 12,
					updatedAt: 12,
				},
			],
		};
		expect(CodexPersistedAgentSchema.safeParse(steered).success).toBe(true);
		const projected = projectCodexListAgent(
			CodexPersistedAgentSchema.parse({
				...accepted,
				turns: [
					{
						...turn,
						finalItemId: "item-final",
						activities: [{ kind: "commentary", itemId: "item-commentary", text: "Checking" }],
					},
				],
			}),
		);
		expect(projected.turns[0]).toEqual({
			id: "turn-1",
			state: "completed",
			activities: [{ kind: "commentary", text: "Checking" }],
			finalResponse: "Done",
			updatedAt: 12,
		});
		expect(JSON.stringify(projected)).not.toContain("item-final");
		expect(JSON.stringify(projected)).not.toContain("item-commentary");
		expect(
			CodexPersistedAgentSchema.safeParse({
				...steered,
				operations: [steered.operations[0]!, { ...steered.operations[1]!, expectedTurnId: undefined }],
			}).success,
		).toBe(false);
		expect(
			CodexPersistedAgentSchema.safeParse({
				...accepted,
				exchanges: [{ ...accepted.exchanges[0]!, delivery: "steered" }],
			}).success,
		).toBe(false);
		expect(
			CodexPersistedAgentSchema.safeParse({
				...accepted,
				exchanges: [
					...accepted.exchanges,
					{
						exchangeId: "123e4567-e89b-42d3-a456-426614174003",
						operationId: "123e4567-e89b-42d3-a456-426614174003",
						kind: "message",
						prompt: "Again",
						status: "accepted",
						delivery: "started",
						turnId: "turn-1",
						createdAt: 12,
						acceptedAt: 12,
					},
				],
				operations: [
					...accepted.operations,
					{
						operationId: "123e4567-e89b-42d3-a456-426614174003",
						kind: "message",
						fingerprint: codexOperationFingerprint("message", AGENT_ID, "Again"),
						state: "accepted",
						turnId: "turn-1",
						preDispatch: { agentState: "idle", threadId: "thread-1", fence: ACCEPTANCE_FENCE },
						createdAt: 12,
						updatedAt: 12,
					},
				],
			}).success,
		).toBe(false);
		expect(
			CodexPersistedAgentSchema.safeParse({
				...persisted,
				exchanges: [{ ...persisted.exchanges[0]!, createdAt: 9 }],
				operations: [{ ...persisted.operations[0]!, createdAt: 9, updatedAt: 9 }],
			}).success,
		).toBe(false);
		expect(
			CodexPersistedAgentSchema.safeParse({
				...accepted,
				exchanges: [{ ...accepted.exchanges[0]!, prompt: "Changed after hashing" }],
			}).success,
		).toBe(false);
		expect(
			CodexPersistedAgentSchema.safeParse({
				...accepted,
				updatedAt: 13,
				operations: [
					...accepted.operations,
					{
						operationId: "123e4567-e89b-42d3-a456-426614174002",
						kind: "stop",
						fingerprint: codexOperationFingerprint("stop", AGENT_ID),
						state: "accepted",
						preDispatch: { agentState: "idle", threadId: "thread-1", fence: ACCEPTANCE_FENCE },
						createdAt: 13,
						updatedAt: 13,
					},
				],
			}).success,
		).toBe(false);
		expect(
			CodexPersistedAgentSchema.safeParse({
				...accepted,
				updatedAt: 13,
				operations: [
					...accepted.operations,
					{
						operationId: "123e4567-e89b-42d3-a456-426614174002",
						kind: "stop",
						fingerprint: codexOperationFingerprint("stop", AGENT_ID),
						state: "accepted",
						preDispatch: { agentState: "idle", threadId: "thread-1", fence: ACCEPTANCE_FENCE },
						noOp: true,
						createdAt: 13,
						updatedAt: 13,
					},
				],
			}).success,
		).toBe(true);
	});

	it("keeps list lifecycle state coherent and reports stale-state availability", () => {
		const inProgress = { id: "turn-1", state: "inProgress", activities: [], updatedAt: 11 };
		const working = {
			agentId: AGENT_ID,
			agentState: "working",
			activeTurnId: "turn-1",
			exchanges: [
				{
					kind: "start",
					prompt: "Review",
					status: "accepted",
					delivery: "started",
					turnId: "turn-1",
					createdAt: 10,
					acceptedAt: 11,
				},
			],
			turns: [inProgress],
			createdAt: 10,
			updatedAt: 11,
		};

		expect(CodexListAgentsResultSchema.safeParse({ agents: [working] }).success).toBe(true);
		expect(
			CodexListAgentsResultSchema.safeParse({
				agents: [
					{
						...working,
						exchanges: [
							...working.exchanges,
							{
								kind: "message",
								prompt: "Start another turn",
								status: "accepted",
								delivery: "started",
								turnId: "turn-2",
								createdAt: 11,
								acceptedAt: 11,
							},
						],
						turns: [...working.turns, { ...inProgress, id: "turn-2" }],
					},
				],
			}).success,
		).toBe(false);
		expect(CodexListAgentsResultSchema.safeParse({ agents: [working, working] }).success).toBe(false);
		expect(
			CodexListAgentsResultSchema.safeParse({ agents: [{ ...working, agentState: "creating" }] }).success,
		).toBe(false);
		expect(CodexListAgentsResultSchema.safeParse({ agents: [{ ...working, agentState: "idle" }] }).success).toBe(
			false,
		);
		expect(
			CodexListAgentsResultSchema.safeParse({
				agents: [{ ...working, agentState: "working", activeTurnId: undefined, turns: [] }],
			}).success,
		).toBe(false);
		expect(
			CodexListAgentsResultSchema.safeParse({
				agents: [
					{
						...working,
						exchanges: [{ ...working.exchanges[0]!, delivery: "steered" }],
					},
				],
			}).success,
		).toBe(false);
		expect(CodexListAgentsResultSchema.safeParse({ agents: [{ ...working, threadId: "private" }] }).success).toBe(
			false,
		);
		expect(
			CodexListAgentsResultSchema.safeParse({
				agents: [
					{
						...working,
						agentState: "idle",
						activeTurnId: undefined,
						exchanges: [{ ...working.exchanges[0]!, turnId: "missing" }],
						turns: [],
					},
				],
			}).success,
		).toBe(false);
		expect(
			CodexListAgentsResultSchema.safeParse({
				agents: [
					{
						...working,
						turns: [
							{
								...inProgress,
								activities: [{ kind: "commentary", itemId: "private", text: "Checking" }],
							},
						],
					},
				],
			}).success,
		).toBe(false);
		expect(
			CodexListAgentsResultSchema.safeParse({
				agents: [working],
				observation: "unavailable",
				error: { code: "daemon_unavailable", message: "Reconnect pending", retryable: true },
			}).success,
		).toBe(true);
		expect(CodexListAgentsResultSchema.safeParse({ agents: [working], observation: "unavailable" }).success).toBe(
			false,
		);
		expect(
			CodexListAgentsResultSchema.safeParse({
				agents: [working],
				observation: "unavailable",
				error: { code: "turn_failed", message: "Wrong level", retryable: false },
			}).success,
		).toBe(false);
	});
});
