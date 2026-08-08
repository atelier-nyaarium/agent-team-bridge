import { describe, expect, it } from "vitest";
import {
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
} from "../shared/codex-thinking.js";
import { AGENT_ID, OPERATION_ID } from "./helpers/codex-thinking.js";

const OWNER_KEY = "recipe-app.owner";

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
			ownerKey: OWNER_KEY,
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
			ownerKey: OWNER_KEY,
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
			ownerKey: OWNER_KEY,
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
		expect(CodexDaemonReceiptSchema.safeParse({ ...accepted, ownerKey: undefined }).success).toBe(false);
		expect(CodexDaemonReceiptSchema.safeParse({ ...accepted, ownerKey: "recipe.app.owner" }).success).toBe(false);
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
			ownerKey: OWNER_KEY,
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
			ownerKey: OWNER_KEY,
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
			ownerKey: OWNER_KEY,
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
			ownerKey: OWNER_KEY,
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
