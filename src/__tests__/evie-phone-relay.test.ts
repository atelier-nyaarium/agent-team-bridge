import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { type EvieClient, startEvieClient } from "../arbiter/evie/evieClient.js";
import { PhoneRelayFrameSchema } from "../shared/schemas.js";

interface FakeEvie {
	wss: WebSocketServer;
	port: number;
	sockets: WebSocket[];
}

function startFakeEvie(onMessage: (sock: WebSocket, msg: Record<string, unknown>) => void): Promise<FakeEvie> {
	return new Promise((resolve) => {
		const sockets: WebSocket[] = [];
		const wss = new WebSocketServer({ port: 0 }, () => {
			resolve({ wss, port: (wss.address() as AddressInfo).port, sockets });
		});
		wss.on("connection", (sock) => {
			sockets.push(sock);
			sock.on("message", (raw) => onMessage(sock, JSON.parse(raw.toString())));
		});
	});
}

function closeAll(client: EvieClient | null, evie: FakeEvie | null): Promise<void> {
	client?.stop();
	return new Promise((resolve) => (evie ? evie.wss.close(() => resolve()) : resolve()));
}

describe("evieClient phone relay", () => {
	let client: EvieClient | null = null;
	let evie: FakeEvie | null = null;

	afterEach(async () => {
		await closeAll(client, evie);
		client = null;
		evie = null;
	});

	it("phone_relay in -> onPhoneRelay -> reply out as a tool_call that resolves", async () => {
		const toolCalls: Record<string, unknown>[] = [];
		evie = await startFakeEvie((sock, msg) => {
			if (msg.type === "tool_call") {
				toolCalls.push(msg);
				sock.send(JSON.stringify({ type: "tool_result", callId: msg.callId, result: { consumed: true } }));
			}
		});

		const relayed = new Promise<unknown>((resolve) => {
			client = startEvieClient({
				url: `ws://localhost:${evie?.port}`,
				authToken: "test-token",
				onPhoneRelay: resolve,
			});
		});

		// Wait for the client to connect, then push a phone_relay like evie would.
		await new Promise<void>((resolve) => {
			const t = setInterval(() => {
				if (client?.isConnected()) {
					clearInterval(t);
					resolve();
				}
			}, 10);
		});
		evie.sockets[0].send(
			JSON.stringify({
				type: "phone_relay",
				v: 1,
				device: "pixel",
				conversationId: "conv-1",
				opId: "op-abc",
				op: { kind: "register" },
			}),
		);

		// The handler receives the frame as unknown (the relay pump owns full
		// validation in production); the test re-parses to assert the shape.
		const frame = PhoneRelayFrameSchema.parse(await relayed);
		expect(frame.opId).toBe("op-abc");
		expect(frame.op.kind).toBe("register");

		// The arbiter-side wiring answers via callTool; assert the round trip resolves.
		const reply = { type: "phone_relay_reply", v: 1, opId: frame.opId, ok: true, result: { device: "pixel" } };
		const result = await client!.callTool("phone_relay_reply", reply);
		expect(result.error).toBeUndefined();
		expect(result.result).toEqual({ consumed: true });
		expect(toolCalls[0]).toMatchObject({ action: "phone_relay_reply", params: reply });
	});

	it("in-flight calls fail fast when the socket closes instead of waiting out the timeout", async () => {
		evie = await startFakeEvie(() => {
			// Never reply; the close should settle the call.
		});

		client = startEvieClient({ url: `ws://localhost:${evie.port}`, authToken: "test-token" });
		await new Promise<void>((resolve) => {
			const t = setInterval(() => {
				if (client?.isConnected()) {
					clearInterval(t);
					resolve();
				}
			}, 10);
		});

		const pending = client!.callTool("phone_relay_reply", { opId: "op-1" });
		evie.sockets[0].close();

		const started = Date.now();
		const result = await pending;
		expect(result.error).toContain("Disconnected");
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
