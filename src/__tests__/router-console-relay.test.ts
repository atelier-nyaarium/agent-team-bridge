import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { type RouterClient, startRouterClient } from "../gateway/router/routerClient.js";
import { ConsoleRelayFrameSchema } from "../shared/schemas.js";

interface FakeRouter {
	wss: WebSocketServer;
	port: number;
	sockets: WebSocket[];
}

function startFakeRouter(onMessage: (sock: WebSocket, msg: Record<string, unknown>) => void): Promise<FakeRouter> {
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

function closeAll(client: RouterClient | null, router: FakeRouter | null): Promise<void> {
	client?.stop();
	return new Promise((resolve) => (router ? router.wss.close(() => resolve()) : resolve()));
}

describe("RouterClient console relay", () => {
	let client: RouterClient | null = null;
	let router: FakeRouter | null = null;

	afterEach(async () => {
		await closeAll(client, router);
		client = null;
		router = null;
	});

	it("console_relay in -> onConsoleRelay -> reply out as a tool_call that resolves", async () => {
		const toolCalls: Record<string, unknown>[] = [];
		router = await startFakeRouter((sock, msg) => {
			if (msg.type === "tool_call") {
				toolCalls.push(msg);
				sock.send(JSON.stringify({ type: "tool_result", callId: msg.callId, result: { consumed: true } }));
			}
		});

		const relayed = new Promise<unknown>((resolve) => {
			client = startRouterClient({
				url: `ws://localhost:${router?.port}`,
				headers: { Authorization: "Bearer test-token" },
				gatewayId: "test-host",
				domainId: "alice",
				onConsoleRelay: resolve,
			});
		});

		// Wait for the client to connect, then push a console_relay like the Router would.
		await new Promise<void>((resolve) => {
			const t = setInterval(() => {
				if (client?.isConnected()) {
					clearInterval(t);
					resolve();
				}
			}, 10);
		});
		router.sockets[0].send(
			JSON.stringify({
				type: "console_relay",
				v: 1,
				opId: "op-abc",
				signerSignPub: "console-key",
				sealed: { ephemeralPub: "a", nonce: "b", ciphertext: "c", signature: "d" },
			}),
		);

		// The handler receives the frame as unknown (the relay pump owns full
		// validation + the seal-open in production); the test re-parses to assert the
		// transport carried the sealed envelope intact.
		const frame = ConsoleRelayFrameSchema.parse(await relayed);
		expect(frame.opId).toBe("op-abc");
		expect(frame.signerSignPub).toBe("console-key");
		expect(frame.sealed.ciphertext).toBe("c");

		// The gateway-side wiring answers via callTool; assert the round trip resolves.
		const reply = {
			type: "console_relay_reply",
			v: 1,
			opId: frame.opId,
			sealed: { ephemeralPub: "a", nonce: "b", ciphertext: "c", signature: "d" },
		};
		const result = await client!.callTool("console_relay_reply", reply);
		expect(result.error).toBeUndefined();
		expect(result.result).toEqual({ consumed: true });
		// The client registers its Gateway on connect, then answers the relay.
		expect(toolCalls[0]).toMatchObject({ action: "gateway_register", params: { gatewayId: "test-host" } });
		expect(toolCalls.find((c) => c.action === "console_relay_reply")).toMatchObject({
			action: "console_relay_reply",
			params: reply,
		});
	});

	it("in-flight calls fail fast when the socket closes instead of waiting out the timeout", async () => {
		router = await startFakeRouter(() => {
			// Never reply; the close should settle the call.
		});

		client = startRouterClient({
			url: `ws://localhost:${router.port}`,
			headers: { Authorization: "Bearer test-token" },
			gatewayId: "test-host",
			domainId: "alice",
		});
		await new Promise<void>((resolve) => {
			const t = setInterval(() => {
				if (client?.isConnected()) {
					clearInterval(t);
					resolve();
				}
			}, 10);
		});

		const pending = client!.callTool("console_relay_reply", { opId: "op-1" });
		router.sockets[0].close();

		const started = Date.now();
		const result = await pending;
		expect(result.error).toContain("Disconnected");
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
