import { describe, expect, it } from "vitest";
import { CodexAgentService } from "../gateway/codexAgentService.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/websocket.js";
import {
	CODEX_ACTIVITY_MAX_BYTES,
	CODEX_ERROR_MAX_BYTES,
	CODEX_PROMPT_MAX_BYTES,
	CodexActivitySchema,
	CodexAgentResultSchema,
	CodexAppServerAgentMessageCompletedSchema,
	CodexAppServerEmptyResultSchema,
	CodexAppServerRequestSchema,
	CodexAppServerResponseSchema,
	CodexAppServerThreadReadResultSchema,
	CodexAppServerThreadStartResultSchema,
	CodexAppServerTurnCompletedSchema,
	CodexAppServerTurnStartResultSchema,
	CodexAppServerTurnSteerResultSchema,
	CodexDaemonCommandSchema,
	CodexDaemonEventSchema,
	CodexDaemonReceiptSchema,
	CodexErrorTextSchema,
	CodexGatewayRequestSchema,
	CodexListAgentsResultSchema,
	type CodexPersistedAgent,
	CodexPersistedAgentSchema,
	CodexRequestErrorSchema,
	CodexStartAgentInputSchema,
	codexOperationFingerprint,
	projectCodexListAgent,
	projectCodexListResult,
	sanitizeCodexErrorText,
} from "../shared/codex-thinking.js";
import { type CodexCatalogWriter, type SessionRecord, SessionStore } from "../shared/session-store.js";

const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const ACCEPTANCE_FENCE = {
	daemonInstanceId: "daemon-1",
	targetId: "container:recipe-app",
	generation: 1,
	lastEventId: 2,
};

function setup(opts: { persistChecked?: (sessionStore: SessionStore) => void } = {}) {
	let sessionStore!: SessionStore;
	let catalogWriter: CodexCatalogWriter | undefined;
	sessionStore = new SessionStore({
		codexCatalogPersistence: {
			persistChecked: () => opts.persistChecked?.(sessionStore),
			receiveWriter: (writer) => {
				catalogWriter = writer;
			},
		},
	});
	const registry: TeamRegistry = new Map();
	const auth = createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	const offlineCatalog = new Map<string, string>();
	if (!catalogWriter) throw new Error("catalog writer unavailable");
	const service = new CodexAgentService({ auth, sessionStore, offlineCatalog, catalogWriter });
	const writer = catalogWriter;
	const setAgents = (owner: SessionRecord, agents: CodexPersistedAgent[]) =>
		writer.commit(owner, sessionStore.codexCatalog(owner)?.revision ?? 0, agents);
	return { auth, sessionStore, offlineCatalog, service, setAgents };
}

function confirmManaged(sessionStore: SessionStore, spawn: string) {
	const record = sessionStore.mint({ spawn, sessionLabel: "Work" });
	const token = sessionStore.ensureBindToken(record);
	sessionStore.activateBinding(record);
	sessionStore.confirm(sessionStore.teamOf(record));
	return { record, token };
}

function requestedAgent(agentId = AGENT_ID): CodexPersistedAgent {
	return CodexPersistedAgentSchema.parse({
		version: 1,
		agentId,
		agentState: "creating",
		requestedTarget: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		exchanges: [
			{
				exchangeId: OPERATION_ID,
				operationId: OPERATION_ID,
				kind: "start",
				prompt: "Review",
				status: "requested",
				createdAt: 10,
			},
		],
		turns: [],
		operations: [
			{
				operationId: OPERATION_ID,
				kind: "start",
				fingerprint: codexOperationFingerprint("start", agentId, "Review"),
				state: "requested",
				preDispatch: { agentState: "creating" },
				createdAt: 10,
				updatedAt: 10,
			},
		],
		createdAt: 10,
		updatedAt: 10,
	});
}

describe("Codex tool contracts", () => {
	it("defaults waiting and rejects private or unknown tool fields", () => {
		expect(CodexStartAgentInputSchema.parse({ prompt: "Review this" })).toEqual({
			prompt: "Review this",
			awaitResponse: true,
		});
		expect(CodexStartAgentInputSchema.safeParse({ prompt: "Review", operationId: OPERATION_ID }).success).toBe(
			false,
		);
		expect(CodexGatewayRequestSchema.safeParse({ kind: "start", prompt: "Review" }).success).toBe(false);
	});

	it.each([
		{ kind: "start", operationId: OPERATION_ID, prompt: "Review", awaitResponse: true },
		{ kind: "message", operationId: OPERATION_ID, agentId: AGENT_ID, prompt: "Continue", awaitResponse: false },
		{ kind: "await", agentId: AGENT_ID },
		{ kind: "stop", operationId: OPERATION_ID, agentId: AGENT_ID },
		{ kind: "list" },
	])("accepts the private gateway $kind request", (request) => {
		expect(CodexGatewayRequestSchema.safeParse(request).success).toBe(true);
	});

	it("bounds prompts by encoded bytes without altering their text", () => {
		const boundary = "x".repeat(CODEX_PROMPT_MAX_BYTES);
		const emoji = "\u{1F600}";
		const multibyteBoundary = emoji.repeat(CODEX_PROMPT_MAX_BYTES / 4);
		expect(CodexStartAgentInputSchema.parse({ prompt: boundary }).prompt).toBe(boundary);
		expect(CodexStartAgentInputSchema.parse({ prompt: multibyteBoundary }).prompt).toBe(multibyteBoundary);
		expect(CodexStartAgentInputSchema.safeParse({ prompt: `${boundary}x` }).success).toBe(false);
		expect(
			CodexStartAgentInputSchema.safeParse({ prompt: emoji.repeat(CODEX_PROMPT_MAX_BYTES / 4 + 1) }).success,
		).toBe(false);
		expect(CodexStartAgentInputSchema.safeParse({ prompt: "  \n" }).success).toBe(false);
	});

	it("normalizes untrusted errors before they cross protocol or persistence boundaries", () => {
		const raw = `  daemon\nfailed\u0000 with\u200b detail ${"🙂".repeat(CODEX_ERROR_MAX_BYTES)}  `;
		const sanitized = sanitizeCodexErrorText(raw);

		expect(sanitized).toBe(sanitizeCodexErrorText(sanitized));
		expect(sanitized).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u);
		expect(new TextEncoder().encode(sanitized).byteLength).toBeLessThanOrEqual(CODEX_ERROR_MAX_BYTES);
		expect(CodexErrorTextSchema.safeParse(sanitized).success).toBe(true);
		expect(CodexErrorTextSchema.safeParse(raw).success).toBe(false);
	});

	it("rejects contradictory result observations and misplaced truncation markers", () => {
		const inProgress = { id: "turn-1", state: "inProgress" };
		const base = { agentId: AGENT_ID, activities: [] };
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "accepted",
				turn: inProgress,
				delivery: "started",
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({ ...base, agentState: "working", observation: "accepted" }).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "waitTimedOut",
				turn: { id: "turn-1", state: "completed" },
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "waitTimedOut",
				turn: inProgress,
				activities: [{ kind: "truncated", omitted: 2 }],
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "idle",
				observation: "idle",
				turn: inProgress,
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "unavailable",
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "waitTimedOut",
				turn: inProgress,
				activities: [
					{ kind: "truncated", omitted: 2 },
					{ kind: "commentary", text: "later" },
				],
			}).success,
		).toBe(false);
	});

	it("represents a creation timeout without inventing a native turn", () => {
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "creating",
				observation: "waitTimedOut",
				activities: [],
			}).success,
		).toBe(true);
	});

	it("bounds individual commentary before it reaches a result", () => {
		expect(
			CodexActivitySchema.safeParse({
				kind: "commentary",
				text: "x".repeat(CODEX_ACTIVITY_MAX_BYTES + 1),
			}).success,
		).toBe(false);
	});

	it("keeps accepted delivery and terminal output tied to a native turn", () => {
		const completed = {
			agentId: AGENT_ID,
			agentState: "idle",
			observation: "terminal",
			turn: { id: "turn-1", state: "completed" },
			delivery: "started",
			activities: [{ kind: "commentary", text: "Checking" }],
			finalResponse: "Done",
		};
		expect(CodexAgentResultSchema.safeParse(completed).success).toBe(true);
		expect(CodexAgentResultSchema.safeParse({ ...completed, finalResponse: undefined }).success).toBe(false);
		expect(CodexAgentResultSchema.safeParse({ ...completed, turn: undefined }).success).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({ ...completed, turn: { id: "turn-1", state: "failed" } }).success,
		).toBe(false);
	});

	it("represents stable rejection and interrupt-pending errors", () => {
		const error = { message: "Unavailable", retryable: false };
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "working",
				observation: "interruptRequested",
				turn: { id: "turn-1", state: "inProgress" },
				activities: [],
				error: { ...error, code: "interrupt_in_progress" },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "unavailable",
				observation: "unavailable",
				activities: [],
				error: { ...error, code: "not_found" },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "creating",
				observation: "unavailable",
				activities: [],
				error: { ...error, code: "feature_disabled" },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "working",
				observation: "unavailable",
				turn: { id: "turn-1", state: "inProgress" },
				activities: [],
				error: { ...error, code: "interrupt_in_progress" },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "working",
				observation: "unavailable",
				turn: { id: "turn-1", state: "inProgress" },
				activities: [],
				error: { ...error, code: "not_found" },
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "working",
				observation: "unavailable",
				turn: { id: "turn-1", state: "inProgress" },
				delivery: "started",
				activities: [],
				error: { ...error, code: "feature_disabled" },
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "working",
				observation: "interruptRequested",
				turn: { id: "turn-1", state: "inProgress" },
				delivery: "steered",
				activities: [],
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "recovering",
				observation: "indeterminate",
				activities: [],
				error: { ...error, code: "indeterminate" },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "idle",
				observation: "indeterminate",
				turn: { id: "turn-1", state: "completed" },
				delivery: "started",
				activities: [],
				error: { ...error, code: "indeterminate" },
			}).success,
		).toBe(false);
		expect(
			CodexRequestErrorSchema.safeParse({
				error: { code: "invalid_input", message: "Prompt is blank", retryable: false },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "unavailable",
				observation: "unavailable",
				activities: [],
				error: { ...error, code: "invalid_input" },
			}).success,
		).toBe(false);
	});
});

describe("Codex internal protocol projections", () => {
	it("accepts additive App Server fields but rejects unsupported message phases", () => {
		const notification = {
			method: "item/completed",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				newField: true,
				item: { type: "agentMessage", id: "item-1", text: "Done", phase: "final_answer", extra: 1 },
			},
		};
		expect(CodexAppServerAgentMessageCompletedSchema.safeParse(notification).success).toBe(true);
		expect(
			CodexAppServerAgentMessageCompletedSchema.safeParse({
				...notification,
				params: { ...notification.params, item: { ...notification.params.item, phase: null } },
			}).success,
		).toBe(true);
		expect(
			CodexAppServerAgentMessageCompletedSchema.safeParse({
				...notification,
				params: { ...notification.params, item: { ...notification.params.item, phase: "future_phase" } },
			}).success,
		).toBe(true);
	});

	it("validates trusted daemon targets independently of Claude-facing inputs", () => {
		const command = {
			type: "codex_command",
			kind: "start",
			requestId: OPERATION_ID,
			operationId: OPERATION_ID,
			agentId: AGENT_ID,
			target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
			prompt: "Review",
		};
		expect(CodexDaemonCommandSchema.safeParse(command).success).toBe(true);
		expect(
			CodexDaemonCommandSchema.safeParse({
				...command,
				target: { ...command.target, project: "../recipe-app" },
			}).success,
		).toBe(false);
	});

	it("requires canonical targets for every command after start", () => {
		const resolvedTarget = { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" };
		const common = {
			type: "codex_command",
			requestId: OPERATION_ID,
			agentId: AGENT_ID,
			target: resolvedTarget,
			threadId: "thread-1",
		};
		const commands = [
			{ ...common, kind: "message", operationId: OPERATION_ID, prompt: "Continue" },
			{ ...common, kind: "interrupt", operationId: OPERATION_ID, turnId: "turn-1" },
			{ ...common, kind: "reconcile", turnId: "turn-1" },
		];
		for (const command of commands) expect(CodexDaemonCommandSchema.safeParse(command).success).toBe(true);
		expect(
			CodexDaemonCommandSchema.safeParse({
				...commands[0],
				target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/changed" },
			}).success,
		).toBe(false);
	});

	it("requires durable native identifiers on accepted receipts", () => {
		const accepted = {
			type: "codex_receipt",
			kind: "accepted",
			requestId: OPERATION_ID,
			operationId: OPERATION_ID,
			daemonInstanceId: "daemon-1",
			targetId: "container:recipe-app",
			generation: 1,
			eventId: 2,
			agentId: AGENT_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
		};
		expect(CodexDaemonReceiptSchema.safeParse(accepted).success).toBe(true);
		expect(CodexDaemonReceiptSchema.safeParse({ ...accepted, turnId: undefined }).success).toBe(false);
		expect(CodexDaemonReceiptSchema.safeParse({ ...accepted, resolvedTarget: undefined }).success).toBe(false);
		expect(
			CodexDaemonReceiptSchema.safeParse({
				...accepted,
				resolvedTarget: { ...accepted.resolvedTarget, targetId: "container:other" },
			}).success,
		).toBe(false);
	});

	it.each([
		{
			type: "codex_receipt",
			kind: "rejected",
			requestId: OPERATION_ID,
			operationId: OPERATION_ID,
			daemonInstanceId: "daemon-1",
			eventId: 4,
			agentId: AGENT_ID,
			error: "Unavailable",
		},
		{
			type: "codex_receipt",
			kind: "interruptResult",
			requestId: OPERATION_ID,
			operationId: OPERATION_ID,
			daemonInstanceId: "daemon-1",
			targetId: "host",
			generation: 1,
			eventId: 5,
			agentId: AGENT_ID,
			threadId: "thread-1",
			turnId: "turn-1",
			ok: true,
		},
		{
			type: "codex_receipt",
			kind: "reconciled",
			requestId: OPERATION_ID,
			daemonInstanceId: "daemon-1",
			targetId: "host",
			generation: 1,
			eventId: 6,
			agentId: AGENT_ID,
			resolvedTarget: { kind: "host", targetId: "host", cwd: "/projects/work" },
			threadId: "thread-1",
			turnId: "turn-1",
			turnState: "inProgress",
		},
	])("accepts the $kind receipt contract", (receipt) => {
		expect(CodexDaemonReceiptSchema.safeParse(receipt).success).toBe(true);
	});

	it("keeps terminal daemon outcomes state-specific", () => {
		const base = {
			type: "codex_event",
			kind: "terminal",
			daemonInstanceId: "daemon-1",
			targetId: "host",
			generation: 1,
			eventId: 3,
			agentId: AGENT_ID,
			threadId: "thread-1",
			turnId: "turn-1",
		};
		expect(CodexDaemonEventSchema.safeParse({ ...base, state: "completed", finalResponse: "Done" }).success).toBe(
			true,
		);
		expect(CodexDaemonEventSchema.safeParse({ ...base, state: "completed" }).success).toBe(false);
		expect(CodexDaemonEventSchema.safeParse({ ...base, state: "failed", error: "Model failed" }).success).toBe(
			true,
		);
		expect(CodexDaemonEventSchema.safeParse({ ...base, state: "interrupted" }).success).toBe(true);
		expect(
			CodexDaemonEventSchema.safeParse({ ...base, state: "failed", error: "Model failed", finalResponse: "No" })
				.success,
		).toBe(false);
		expect(CodexDaemonEventSchema.safeParse({ ...base, state: "completed", error: "No" }).success).toBe(false);
	});

	it("projects App Server responses and terminal turns without requiring version-specific extras", () => {
		expect(CodexAppServerResponseSchema.safeParse({ id: 1, result: { ok: true }, extra: true }).success).toBe(true);
		expect(CodexAppServerResponseSchema.safeParse({ id: 1, error: { code: -1, message: "No" } }).success).toBe(
			true,
		);
		expect(CodexAppServerResponseSchema.safeParse({ id: 1 }).success).toBe(false);
		expect(
			CodexAppServerResponseSchema.safeParse({ id: 1, result: {}, error: { code: -1, message: "No" } }).success,
		).toBe(false);
		expect(
			CodexAppServerTurnCompletedSchema.safeParse({
				method: "turn/completed",
				params: {
					threadId: "thread-1",
					turn: { id: "turn-1", status: "completed", error: null, newField: true },
				},
			}).success,
		).toBe(true);
	});

	it("validates the App Server result fields Switchboard consumes", () => {
		expect(
			CodexAppServerThreadStartResultSchema.safeParse({ thread: { id: "thread-1", extra: true } }).success,
		).toBe(true);
		expect(CodexAppServerThreadStartResultSchema.safeParse({ thread: {} }).success).toBe(false);
		expect(
			CodexAppServerThreadReadResultSchema.safeParse({
				thread: {
					id: "thread-1",
					turns: [
						{
							id: "turn-1",
							status: "completed",
							items: [{ id: "item-1", type: "agentMessage", text: "Done", phase: "final_answer" }],
							extra: true,
						},
					],
				},
			}).success,
		).toBe(true);
		expect(
			CodexAppServerThreadReadResultSchema.safeParse({
				thread: {
					id: "thread-1",
					turns: [{ id: "turn-1", status: "completed", items: [{ id: 2, type: "agentMessage" }] }],
				},
			}).success,
		).toBe(false);
		expect(
			CodexAppServerTurnStartResultSchema.safeParse({
				turn: { id: "turn-1", status: "inProgress", items: [] },
			}).success,
		).toBe(true);
		expect(CodexAppServerTurnSteerResultSchema.safeParse({ turnId: "turn-1" }).success).toBe(true);
		expect(CodexAppServerEmptyResultSchema.safeParse({ future: true }).success).toBe(true);
		expect(
			CodexAppServerRequestSchema.safeParse({ id: 7, method: "item/fileChange/requestApproval" }).success,
		).toBe(true);
	});
});

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

describe("Codex session ownership and target resolution", () => {
	it("returns the exact bound session and ignores all caller-supplied identity", () => {
		const { sessionStore, service } = setup();
		const { record, token } = confirmManaged(sessionStore, "recipe-app");
		const req = new Request("http://gateway/codex?session=host.other", {
			headers: { "x-session-token": token },
		});

		expect(service.resolveOwner(req)).toBe(record);
		expect(service.resolveOwner(new Request("http://gateway/codex"))).toBeNull();
	});

	it("resolves devcontainers only from the authenticated offline catalog", () => {
		const { sessionStore, offlineCatalog, service } = setup();
		const { record } = confirmManaged(sessionStore, "recipe-app");

		expect(service.resolveExecutionTarget(record)).toBeNull();
		offlineCatalog.set("recipe-app", "/trusted/recipe-app");
		expect(service.resolveExecutionTarget(record)).toEqual({
			kind: "devcontainer",
			project: "recipe-app",
			hostProjectPath: "/trusted/recipe-app",
		});
		offlineCatalog.set("recipe-app", "../other-project");
		expect(service.resolveExecutionTarget(record)).toBeNull();
		offlineCatalog.set("recipe-app", "");
		expect(service.resolveExecutionTarget(record)).toBeNull();
	});

	it("uses the session store's frozen host workdir precedence", () => {
		const { sessionStore, service } = setup();
		const record = sessionStore.mint({
			spawn: "host",
			sessionLabel: "Renamed",
			workdirHint: "Original",
			workdirPath: "/projects/chosen",
		});

		expect(service.resolveExecutionTarget(record)).toEqual({
			kind: "host",
			workdirHint: "/projects/chosen",
		});
	});

	it("looks up agents and operations only inside the confirmed owner's catalog", () => {
		const { sessionStore, service, setAgents } = setup();
		const mine = confirmManaged(sessionStore, "recipe-app");
		const foreign = confirmManaged(sessionStore, "other-app");
		const foreignAgent = requestedAgent();
		setAgents(foreign.record, [foreignAgent]);
		const mineRequest = new Request("http://gateway/codex", {
			headers: { "x-session-token": mine.token },
		});
		const foreignRequest = new Request("http://gateway/codex", {
			headers: { "x-session-token": foreign.token },
		});

		expect(service.resolveOwnedAgent(mineRequest, AGENT_ID)).toBeNull();
		expect(service.resolveOwnedAgent(mineRequest, "codex_ffffffffffffffffffffffffffffffff")).toBeNull();
		expect(service.resolveOwnedAgent(foreignRequest, AGENT_ID)).toEqual({
			owner: foreign.record,
			agent: foreignAgent,
		});
		expect(service.resolveOwnedOperation(mineRequest, AGENT_ID, OPERATION_ID)).toBeNull();
		expect(service.resolveOwnedOperation(foreignRequest, AGENT_ID, OPERATION_ID)).toEqual({
			owner: foreign.record,
			agent: foreignAgent,
			operation: foreignAgent.operations[0],
		});
	});
});
