import { describe, expect, it } from "vitest";
import type { AppServerTransport } from "../mcp/devcontainer/codexAppServer.js";
import { CodexAppServerClient } from "../mcp/devcontainer/codexAppServer.js";

const MODEL = "gpt-5-codex";
const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

class RecordingTransport implements AppServerTransport {
	readonly requests: Array<{ method: string; params: unknown }> = [];
	readonly notifications: Array<{ method: string; params: unknown }> = [];

	async request(method: string, params: unknown): Promise<unknown> {
		this.requests.push({ method, params });
		switch (method) {
			case "model/list":
				return { data: [{ id: MODEL, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
			case "thread/start":
			case "thread/resume":
				return { thread: { id: THREAD_ID } };
			case "turn/start":
				return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
			case "thread/read":
				return { thread: { id: THREAD_ID, turns: [] } };
			default:
				return {};
		}
	}

	notify(method: string, params: unknown): void {
		this.notifications.push({ method, params });
	}

	onEvent(): void {}
	close(): void {}

	paramsOf(method: string): Record<string, unknown> {
		const found = this.requests.find((r) => r.method === method);
		if (!found) throw new Error(`${method} was never requested`);
		return found.params as Record<string, unknown>;
	}
}

async function openClient(): Promise<{ client: CodexAppServerClient; transport: RecordingTransport }> {
	const transport = new RecordingTransport();
	const client = await CodexAppServerClient.open(transport, MODEL);
	return { client, transport };
}

describe("App Server request params", () => {
	it("names the steered turn expectedTurnId, which is not what interrupt calls it", async () => {
		const { client, transport } = await openClient();

		await client.startTurn(THREAD_ID, "do the thing", () => {});
		await client.steerTurn(THREAD_ID, TURN_ID, "changed my mind");
		await client.interruptTurn(THREAD_ID, TURN_ID);

		// A steer sent as `turnId` is refused for a missing field, and the refusal reads as an unwell
		// agent rather than a malformed request.
		expect(transport.paramsOf("turn/steer")).toEqual({
			threadId: THREAD_ID,
			expectedTurnId: TURN_ID,
			input: [{ type: "text", text: "changed my mind" }],
		});
		expect(transport.paramsOf("turn/interrupt")).toEqual({ threadId: THREAD_ID, turnId: TURN_ID });
	});

	it("starts a thread at the caller's cwd with approvals refused and a sandbox named", async () => {
		const { client, transport } = await openClient();

		await client.startThread({ cwd: "/workspace/recipe-app" });

		// An omitted sandbox is not a neutral default: the App Server picks read-only, and approvals
		// refused up front means the thread cannot escalate, so every write fails for its whole life.
		expect(transport.paramsOf("thread/start")).toEqual({
			cwd: "/workspace/recipe-app",
			model: MODEL,
			reasoningEffort: "high",
			approvalPolicy: "never",
			sandbox: "workspace-write",
		});
	});

	it("carries a turn's text as a typed input array rather than a bare string", async () => {
		const { client, transport } = await openClient();

		await client.startTurn(THREAD_ID, "do the thing", () => {});

		expect(transport.paramsOf("turn/start")).toEqual({
			threadId: THREAD_ID,
			input: [{ type: "text", text: "do the thing" }],
		});
	});

	it("asks thread/read for turns, which it otherwise answers without", async () => {
		const { client, transport } = await openClient();

		await client.readThread(THREAD_ID);

		expect(transport.paramsOf("thread/read")).toEqual({ threadId: THREAD_ID, includeTurns: true });
	});

	it("resumes and archives a thread by its id alone", async () => {
		const { client, transport } = await openClient();

		await client.resumeThread(THREAD_ID);
		await client.startTurn(THREAD_ID, "do the thing", () => {});
		await client.settleTurn(THREAD_ID, TURN_ID, { status: "completed", finalResponse: "done" });

		expect(transport.paramsOf("thread/resume")).toEqual({ threadId: THREAD_ID });
		expect(transport.paramsOf("thread/archive")).toEqual({ threadId: THREAD_ID });
	});

	it("handshakes before it will hand out a thread", async () => {
		const { transport } = await openClient();

		expect(transport.requests.map((r) => r.method)).toEqual(["initialize", "model/list"]);
		expect(transport.notifications.map((n) => n.method)).toEqual(["initialized"]);
	});

	it("refuses a model the server never offered", async () => {
		const transport = new RecordingTransport();

		await expect(CodexAppServerClient.open(transport, "gpt-4-imaginary")).rejects.toThrow("model not offered");
	});
});
