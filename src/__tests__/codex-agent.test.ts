import { describe, expect, it } from "vitest";
import { decideAcceptance } from "../gateway/codexAgentReducers.js";
import { CodexAgentService } from "../gateway/codexAgentService.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/websocket.js";
import { processAmbient } from "../shared/ambient.js";
import {
	CODEX_ACTIVITY_MAX_BYTES,
	CODEX_ERROR_MAX_BYTES,
	CODEX_PROMPT_MAX_BYTES,
	CodexActivitySchema,
	CodexAgentCatalogSchema,
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
	CodexStartAgentInputSchema,
	codexOperationFingerprint,
	projectCodexListAgent,
	projectCodexListResult,
	restoreCodexAgentCatalog,
	sanitizeCodexErrorText,
} from "../shared/codex-agent.js";
import { type CodexCatalogWriter, SessionStore } from "../shared/session-store.js";

const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const TARGET = { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/trusted/recipe-app" } as const;
const RESOLVED = { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" } as const;
const fence = (lastEventId: number) => ({
	daemonInstanceId: "daemon-1",
	targetId: "container:recipe-app",
	generation: 1,
	lastEventId,
});

function requestedAgent(agentId = AGENT_ID, operationId = OPERATION_ID): CodexPersistedAgent {
	return CodexPersistedAgentSchema.parse({
		version: 1,
		agentId,
		agentState: "creating",
		requestedTarget: TARGET,
		exchanges: [
			{
				exchangeId: operationId,
				operationId,
				kind: "start",
				prompt: "Review",
				status: "requested",
				createdAt: 10,
			},
		],
		turns: [],
		operations: [
			{
				operationId,
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

function ownedService() {
	let writer: CodexCatalogWriter | undefined;
	const sessionStore = new SessionStore({
		ambient: processAmbient(),
		codexCatalogPersistence: { persistChecked: () => {}, receiveWriter: (value) => (writer = value) },
	});
	const auth = createSessionAuthority({
		sessionStore,
		registry: new Map() as TeamRegistry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	const offlineCatalog = new Map<string, string>();
	const service = new CodexAgentService({ auth, sessionStore, offlineCatalog, catalogWriter: writer! });
	return { service, sessionStore, offlineCatalog, writer: writer! };
}

function owner(sessionStore: SessionStore, spawn: string) {
	const record = sessionStore.mint({ spawn, sessionLabel: "Work" });
	sessionStore.ensureBindToken(record);
	sessionStore.activateBinding(record);
	sessionStore.confirm(sessionStore.teamOf(record));
	return record;
}

describe("Codex agent contracts", () => {
	it("accepts public inputs and private gateway requests at their boundaries", () => {
		expect(CodexStartAgentInputSchema.parse({ prompt: "Review" })).toEqual({ prompt: "Review" });
		expect(CodexStartAgentInputSchema.safeParse({ prompt: "Review", operationId: OPERATION_ID }).success).toBe(
			false,
		);
		expect(
			CodexGatewayRequestSchema.safeParse({ kind: "start", operationId: OPERATION_ID, prompt: "Review" }).success,
		).toBe(true);
		expect(CodexGatewayRequestSchema.safeParse({ kind: "list" }).success).toBe(true);
	});

	it("bounds UTF-8 prompts and activity text", () => {
		expect(CodexStartAgentInputSchema.safeParse({ prompt: "x".repeat(CODEX_PROMPT_MAX_BYTES) }).success).toBe(true);
		expect(CodexStartAgentInputSchema.safeParse({ prompt: "x".repeat(CODEX_PROMPT_MAX_BYTES + 1) }).success).toBe(
			false,
		);
		expect(CodexStartAgentInputSchema.safeParse({ prompt: "  \n" }).success).toBe(false);
		expect(
			CodexActivitySchema.safeParse({ kind: "commentary", text: "x".repeat(CODEX_ACTIVITY_MAX_BYTES + 1) })
				.success,
		).toBe(false);
	});

	it("sanitizes error text into an idempotent bounded value", () => {
		const value = sanitizeCodexErrorText(` daemon\nfailed\u0000 ${"🙂".repeat(CODEX_ERROR_MAX_BYTES)} `);
		expect(sanitizeCodexErrorText(value)).toBe(value);
		expect(CodexErrorTextSchema.safeParse(value).success).toBe(true);
		expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(CODEX_ERROR_MAX_BYTES);
	});

	it("keeps result observations consistent with native turn state", () => {
		const base = { agentId: AGENT_ID, activities: [] };
		expect(
			CodexAgentResultSchema.safeParse({ ...base, agentState: "creating", observation: "waitTimedOut" }).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "accepted",
				turn: { id: "turn-1", state: "inProgress" },
				delivery: "started",
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({ ...base, agentState: "working", observation: "accepted" }).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "idle",
				observation: "idle",
				turn: { id: "turn-1", state: "inProgress" },
			}).success,
		).toBe(false);
	});

	it("validates daemon commands, receipts, events, and App Server projections", () => {
		const command = {
			type: "codex_command",
			kind: "start",
			requestId: OPERATION_ID,
			ownerKey: "recipe-app.owner",
			operationId: OPERATION_ID,
			agentId: AGENT_ID,
			target: TARGET,
			prompt: "Review",
		};
		expect(CodexDaemonCommandSchema.safeParse(command).success).toBe(true);
		expect(
			CodexDaemonCommandSchema.safeParse({ ...command, target: { ...TARGET, project: "../other" } }).success,
		).toBe(false);
		const accepted = {
			type: "codex_receipt",
			kind: "accepted",
			requestId: OPERATION_ID,
			ownerKey: "recipe-app.owner",
			operationId: OPERATION_ID,
			daemonInstanceId: "daemon-1",
			targetId: RESOLVED.targetId,
			generation: 1,
			eventId: 2,
			agentId: AGENT_ID,
			resolvedTarget: RESOLVED,
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
		};
		expect(CodexDaemonReceiptSchema.safeParse(accepted).success).toBe(true);
		expect(CodexDaemonReceiptSchema.safeParse({ ...accepted, turnId: undefined }).success).toBe(false);
		const event = {
			type: "codex_event",
			kind: "terminal",
			ownerKey: "recipe-app.owner",
			daemonInstanceId: "daemon-1",
			targetId: "host",
			generation: 1,
			eventId: 3,
			agentId: AGENT_ID,
			threadId: "thread-1",
			turnId: "turn-1",
		};
		expect(CodexDaemonEventSchema.safeParse({ ...event, state: "completed", finalResponse: "Done" }).success).toBe(
			true,
		);
		expect(CodexDaemonEventSchema.safeParse({ ...event, state: "completed" }).success).toBe(false);
		const notification = {
			method: "item/completed",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				item: { type: "agentMessage", id: "item-1", text: "Done", phase: "final_answer" },
			},
		};
		expect(CodexAppServerAgentMessageCompletedSchema.safeParse(notification).success).toBe(true);
		expect(CodexAppServerResponseSchema.safeParse({ id: 1, result: { ok: true } }).success).toBe(true);
		expect(CodexAppServerResponseSchema.safeParse({ id: 1 }).success).toBe(false);
		expect(CodexAppServerThreadStartResultSchema.safeParse({ thread: { id: "thread-1" } }).success).toBe(true);
		expect(CodexAppServerThreadReadResultSchema.safeParse({ thread: { id: "thread-1", turns: [] } }).success).toBe(
			true,
		);
		expect(
			CodexAppServerTurnStartResultSchema.safeParse({ turn: { id: "turn-1", status: "inProgress", items: [] } })
				.success,
		).toBe(true);
		expect(
			CodexAppServerTurnCompletedSchema.safeParse({
				method: "turn/completed",
				params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
			}).success,
		).toBe(true);
		expect(CodexAppServerTurnSteerResultSchema.safeParse({ turnId: "turn-1" }).success).toBe(true);
		expect(CodexAppServerEmptyResultSchema.safeParse({}).success).toBe(true);
		expect(
			CodexAppServerRequestSchema.safeParse({ id: 7, method: "item/fileChange/requestApproval" }).success,
		).toBe(true);
	});

	it("projects persisted state into bounded public list output", () => {
		const first = requestedAgent();
		const second = requestedAgent("codex_abcdef0123456789abcdef0123456789", "223e4567-e89b-42d3-a456-426614174000");
		const result = projectCodexListResult([first, second], undefined, { detail: "full", limit: 1 });
		expect(result).toMatchObject({
			detail: "full",
			omitted: 1,
			agents: [{ agentId: "codex_abcdef0123456789abcdef0123456789" }],
		});
		expect(projectCodexListAgent(first)).not.toHaveProperty("operations");
		expect(CodexListAgentsResultSchema.safeParse(result).success).toBe(true);
	});

	it("restores valid catalog entries and drops malformed or ambiguous entries", () => {
		const valid = requestedAgent();
		const duplicate = requestedAgent(
			"codex_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"123e4567-e89b-42d3-a456-426614174001",
		);
		const restored = restoreCodexAgentCatalog({
			version: 1,
			revision: 7,
			agents: [
				valid,
				{ broken: true },
				{ ...duplicate, operations: [{ ...duplicate.operations[0]!, operationId: OPERATION_ID }] },
			],
		});
		expect(restored).toEqual({ version: 1, revision: 7, agents: [valid] });
		expect(restoreCodexAgentCatalog({ version: 1, revision: Number.MAX_VALUE, agents: [valid] })).toBeUndefined();
		expect(CodexAgentCatalogSchema.safeParse({ version: 1, revision: 0, agents: [valid] }).success).toBe(true);
	});

	it("accepts a valid persisted lifecycle and rejects dangling references", () => {
		const persisted = requestedAgent();
		const accepted = {
			...persisted,
			agentState: "idle",
			resolvedTarget: RESOLVED,
			threadId: "thread-1",
			turns: [{ id: "turn-1", state: "completed", activities: [], finalResponse: "Done", updatedAt: 12 }],
			exchanges: [
				{
					...persisted.exchanges[0]!,
					status: "accepted",
					delivery: "started",
					turnId: "turn-1",
					acceptedAt: 11,
				},
			],
			operations: [
				{
					...persisted.operations[0]!,
					state: "accepted",
					turnId: "turn-1",
					acceptanceFence: fence(2),
					updatedAt: 11,
				},
			],
			fence: fence(2),
			updatedAt: 12,
		};
		expect(CodexPersistedAgentSchema.safeParse(accepted).success).toBe(true);
		expect(
			CodexPersistedAgentSchema.safeParse({ ...accepted, activeTurnId: "missing", agentState: "working" })
				.success,
		).toBe(false);
		expect(CodexPersistedAgentSchema.safeParse({ ...persisted, unknown: true }).success).toBe(false);
	});

	it("resolves owners and execution targets from SessionStore state", () => {
		const { service, sessionStore, offlineCatalog } = ownedService();
		const record = owner(sessionStore, "recipe-app");
		const request = new Request("http://gateway/codex?session=other", {
			headers: { "x-session-token": record.bindToken! },
		});
		expect(service.resolveOwner(request)).toBe(record);
		expect(service.resolveOwner(new Request("http://gateway/codex"))).toBeNull();
		expect(service.resolveExecutionTarget(record)).toBeNull();
		offlineCatalog.set("recipe-app", "/trusted/recipe-app");
		expect(service.resolveExecutionTarget(record)).toEqual(TARGET);
		const host = sessionStore.mint({ spawn: "host", workdirHint: "Original", workdirPath: "/projects/chosen" });
		expect(service.resolveExecutionTarget(host)).toEqual({ kind: "host", workdirHint: "/projects/chosen" });
	});

	it.each([
		["advanced fence", fence(3), "accept"],
		["foreign daemon", { ...fence(3), daemonInstanceId: "daemon-2" }, "unresolved"],
		["stale fence", fence(2), "unresolved"],
	] as const)("decideAcceptance handles %s", (_name, receiptFence, kind) => {
		const { service, sessionStore } = ownedService();
		const record = owner(sessionStore, "recipe-app");
		const request = new Request("http://gateway/codex", { headers: { "x-session-token": record.bindToken! } });
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
		service.beginMessage(request, {
			agentId: AGENT_ID,
			operationId: "123e4567-e89b-42d3-a456-426614174001",
			prompt: "Continue",
			at: 22,
		});
		const agent = sessionStore.codexCatalog(record)!.agents[0]!;
		const operation = agent.operations[1]!;
		const exchange = agent.exchanges[1]!;
		expect(
			decideAcceptance({
				current: agent,
				operation,
				exchange,
				input: { turnId: "turn-1", delivery: "steered", threadId: "thread-1" },
				resolvedTarget: RESOLVED,
				fence: receiptFence,
			}),
		).toMatchObject({ kind });
	});
});
