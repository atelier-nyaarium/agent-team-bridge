import { expect, it } from "vitest";
import type { AgentChild, TargetSupervisor } from "../mcp/devcontainer/codexTargets.js";
import type { CopilotAcpClient } from "../mcp/devcontainer/copilotAcp.js";
import { CopilotDaemonService } from "../mcp/devcontainer/copilotDaemonService.js";

const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
async function settle(): Promise<void> {
	for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}

it("streams a Copilot ACP turn into accepted, activity, and terminal frames", async () => {
	const child = {} as AgentChild;
	const sent: Record<string, unknown>[] = [];
	let listener: (event: { method: string; params?: unknown }) => void = () => {};
	let finishPrompt: ((result: { stopReason: string }) => void) | undefined;
	const client = {
		onEvent(next: (event: { method: string; params?: unknown }) => void) {
			listener = next;
		},
		async newSession() {
			return { sessionId: "session-1", model: { state: "applied", model: "auto" } };
		},
		prompt: () =>
			new Promise<{ stopReason: string }>((resolve) => {
				finishPrompt = resolve;
			}),
		loadSession: async () => {},
		cancel: () => {},
		close: () => {},
	} as unknown as CopilotAcpClient;
	const targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: 3, child } }),
		release: () => {},
	};
	const service = new CopilotDaemonService({
		targets,
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => client,
		resolveHostCwd: () => "/home/agent",
	});

	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the parser",
	});
	await settle();

	expect(sent).toContainEqual(
		expect.objectContaining({ type: "copilot_receipt", kind: "accepted", sessionId: "session-1" }),
	);
	listener({
		method: "session/update",
		params: {
			sessionId: "session-1",
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
		},
	});
	finishPrompt?.({ stopReason: "end_turn" });
	await settle();

	expect(sent).toContainEqual(expect.objectContaining({ type: "copilot_event", kind: "activity", text: "Done." }));
	expect(sent).toContainEqual(
		expect.objectContaining({
			type: "copilot_event",
			kind: "terminal",
			state: "completed",
			finalResponse: "Done.",
		}),
	);
});

it("rejects an explicitly requested model that ACP did not apply", async () => {
	const sent: Record<string, unknown>[] = [];
	const client = {
		onEvent: () => {},
		newSession: async () => ({
			sessionId: "session-1",
			model: { state: "notApplied" as const, requested: "unavailable", reason: "model option is not offered" },
		}),
		loadSession: async () => {},
		prompt: async () => ({ stopReason: "end_turn" }),
		cancel: () => {},
		close: () => {},
	} as unknown as CopilotAcpClient;
	const targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: 1, child: {} as AgentChild } }),
		release: () => {},
	};
	const service = new CopilotDaemonService({
		targets,
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => client,
		resolveHostCwd: () => "/home/agent",
	});

	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		model: "unavailable",
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the parser",
	});
	await settle();

	expect(sent).toContainEqual(
		expect.objectContaining({
			kind: "rejected",
			error: "requested model was not applied: model option is not offered",
		}),
	);
});

it("refuses a command whose generation retires while it is in flight", async () => {
	const sent: Record<string, unknown>[] = [];
	let started = () => {};
	const opening = new Promise<void>((resolve) => {
		started = resolve;
	});
	const client = {
		onEvent: () => {},
		newSession: async () => ({ sessionId: "session-1", model: { state: "applied", model: "auto" } }),
		loadSession: async () => {},
		prompt: async () => ({ stopReason: "end_turn" }),
		cancel: () => {},
		close: () => {},
	} as unknown as CopilotAcpClient;
	let generation = 1;
	const service = new CopilotDaemonService({
		targets: {
			acquire: () => ({ state: "running", lease: { generation, child: {} as AgentChild } }),
			release: () => {},
		},
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => {
			await opening;
			return client;
		},
		resolveHostCwd: () => "/home/agent",
	});

	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the parser",
	});
	await settle();
	// A newer generation takes the target while the first is still opening.
	generation = 2;
	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: "123e4567-e89b-42d3-a456-426614174005",
		ownerKey: OWNER_KEY,
		agentId: "copilot_fedcba9876543210fedcba9876543210",
		operationId: "123e4567-e89b-42d3-a456-426614174006",
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the lexer",
	});
	started();
	await settle();

	// Losing the acceptance instead would leave that caller waiting on a generation nobody holds.
	expect(sent.filter((message) => message.agentId === AGENT_ID)).toMatchObject([{ kind: "rejected" }]);
});

it("classifies login failures in rejected receipts", async () => {
	const sent: Record<string, unknown>[] = [];
	const targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: 1, child: {} as AgentChild } }),
		release: () => {},
	};
	const service = new CopilotDaemonService({
		targets,
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => {
			throw new Error("Copilot login required");
		},
		resolveHostCwd: () => "/home/agent",
	});

	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the parser",
	});
	await settle();

	expect(sent).toContainEqual(
		expect.objectContaining({
			kind: "rejected",
			daemonInstanceId: "daemon-1",
			failureCode: "authentication_required",
		}),
	);
});
