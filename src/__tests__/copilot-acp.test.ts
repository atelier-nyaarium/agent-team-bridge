import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AgentChild } from "../mcp/devcontainer/codexTargets.js";
import { CopilotAcpClient, createAcpTransport } from "../mcp/devcontainer/copilotAcp.js";

function fakeChild() {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const written: unknown[] = [];
	stdin.on("data", (chunk: Buffer) => written.push(JSON.parse(chunk.toString())));
	let onExit: (info: { code: number | null; signal: string | null }) => void = () => {};
	const child: AgentChild = {
		stdin,
		stdout,
		kill: () => {},
		onExit(listener) {
			onExit = listener;
		},
	};
	return {
		child,
		written,
		feed(message: unknown) {
			stdout.write(`${JSON.stringify(message)}\n`);
		},
		exit() {
			onExit({ code: 1, signal: null });
		},
	};
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Copilot ACP transport", () => {
	it("correlates ACP requests, streams updates, and enables agent permissions", async () => {
		const context = fakeChild();
		const transport = createAcpTransport(context.child);
		const events: Array<{ method: string; params?: unknown }> = [];
		transport.onEvent((event) => events.push(event));

		const open = CopilotAcpClient.open(transport);
		await tick();
		expect(context.written).toMatchObject([{ id: 1, method: "initialize" }]);
		context.feed({ id: 1, result: { protocolVersion: 1 } });
		const client = await open;
		expect(context.written).toContainEqual({ jsonrpc: "2.0", method: "initialized", params: {} });

		const session = client.newSession("/workspace/project", "auto");
		await tick();
		context.feed({ id: 2, result: { sessionId: "session-1" } });
		await tick();
		context.feed({ id: 3, result: {} });
		await tick();
		context.feed({ id: 4, result: {} });
		expect(await session).toEqual({ sessionId: "session-1", model: { state: "applied", model: "auto" } });
		expect(context.written).toContainEqual({
			jsonrpc: "2.0",
			id: 3,
			method: "session/set_config_option",
			params: { sessionId: "session-1", configId: "model", value: "auto" },
		});
		expect(context.written).toContainEqual({
			jsonrpc: "2.0",
			id: 4,
			method: "session/set_config_option",
			params: { sessionId: "session-1", configId: "allow_all", value: "on" },
		});

		const prompt = client.prompt("session-1", "Hello.");
		await tick();
		context.feed({
			method: "session/update",
			params: {
				sessionId: "session-1",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi." } },
			},
		});
		context.feed({ id: 5, result: { stopReason: "end_turn" } });
		expect(await prompt).toEqual({ stopReason: "end_turn" });
		await tick();
		expect(events).toHaveLength(1);
		expect(events[0]?.method).toBe("session/update");
	});

	it("reports a requested model as not applied when ACP does not offer it", async () => {
		const context = fakeChild();
		const transport = createAcpTransport(context.child);
		const open = CopilotAcpClient.open(transport);
		await tick();
		context.feed({ id: 1, result: { protocolVersion: 1 } });
		const client = await open;

		const session = client.newSession("/workspace/project", "requested-model");
		await tick();
		context.feed({ id: 2, result: { sessionId: "session-2", configOptions: [{ id: "allow_all" }] } });
		await tick();
		context.feed({ id: 3, result: {} });

		expect(await session).toEqual({
			sessionId: "session-2",
			model: { state: "notApplied", requested: "requested-model", reason: "model option is not offered" },
		});
		expect(context.written).not.toContainEqual(
			expect.objectContaining({
				method: "session/set_config_option",
				params: expect.objectContaining({ configId: "model" }),
			}),
		);
		transport.close();
	});

	it("reports an applied requested model when ACP offers it", async () => {
		const context = fakeChild();
		const transport = createAcpTransport(context.child);
		const open = CopilotAcpClient.open(transport);
		await tick();
		context.feed({ id: 1, result: { protocolVersion: 1 } });
		const client = await open;

		const session = client.newSession("/workspace/project", "requested-model");
		await tick();
		context.feed({
			id: 2,
			result: { sessionId: "session-3", configOptions: [{ id: "model" }, { id: "allow_all" }] },
		});
		await tick();
		context.feed({ id: 3, result: {} });
		await tick();
		context.feed({ id: 4, result: {} });

		expect(await session).toEqual({
			sessionId: "session-3",
			model: { state: "applied", model: "requested-model" },
		});
		transport.close();
	});

	it("answers an ACP permission request by cancelling it", async () => {
		const context = fakeChild();
		const transport = createAcpTransport(context.child);
		context.feed({ id: "permission-1", method: "session/request_permission", params: {} });
		await tick();

		expect(context.written).toContainEqual({
			jsonrpc: "2.0",
			id: "permission-1",
			result: { outcome: { outcome: "cancelled" } },
		});
		transport.close();
	});
});
