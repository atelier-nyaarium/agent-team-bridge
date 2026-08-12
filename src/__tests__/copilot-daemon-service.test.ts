import { expect, it } from "vitest";
import type { TargetSupervisor } from "../mcp/devcontainer/codexTargets.js";
import type { CopilotAcpClient } from "../mcp/devcontainer/copilotAcp.js";
import { CopilotDaemonService } from "../mcp/devcontainer/copilotDaemonService.js";
import type { CopilotChild } from "../mcp/devcontainer/copilotTargets.js";

const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
async function settle(): Promise<void> {
	for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}

it("streams a Copilot ACP turn into accepted, activity, and terminal frames", async () => {
	const child = {} as CopilotChild;
	const sent: Record<string, unknown>[] = [];
	let listener: (event: { method: string; params?: unknown }) => void = () => {};
	let finishPrompt: ((result: { stopReason: string }) => void) | undefined;
	const client = {
		onEvent(next: (event: { method: string; params?: unknown }) => void) {
			listener = next;
		},
		async newSession() {
			return { sessionId: "session-1", model: "auto" };
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

it("classifies login failures in rejected receipts", async () => {
	const sent: Record<string, unknown>[] = [];
	const targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: 1, child: {} as CopilotChild } }),
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
