import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { type RouterClient, startRouterClient } from "../gateway/router/routerClient.js";
import { processAmbient } from "../shared/ambient.js";

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

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const t = setInterval(() => {
			if (predicate()) {
				clearInterval(t);
				resolve();
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(t);
				reject(new Error("waitFor timed out"));
			}
		}, 5);
	});
}

describe("routerClient pending-Domain re-register", () => {
	let client: RouterClient | null = null;
	let router: FakeRouter | null = null;

	afterEach(async () => {
		await closeAll(client, router);
		client = null;
		router = null;
	});

	it("retries after a pending refusal and registers once the Domain roots", async () => {
		// Pending registration retries; accepted registration stops retries.
		const registers: Record<string, unknown>[] = [];
		router = await startFakeRouter((sock, msg) => {
			if (msg.type !== "tool_call" || msg.action !== "gateway_register") return;
			registers.push(msg.params as Record<string, unknown>);
			const reply =
				registers.length === 1
					? { ok: false, pending: true, error: "registration_denied: admitted-identity proof required" }
					: { ok: true, gateways: [], domainStatus: "rooted" };
			sock.send(JSON.stringify({ type: "tool_result", callId: msg.callId, result: reply }));
		});

		let lastStatus: string | undefined;
		client = startRouterClient({
			ambient: processAmbient(),
			url: `ws://localhost:${router.port}`,
			headers: { Authorization: "Bearer test-token" },
			gatewayId: "test-host",
			domainId: "alice",
			pendingReregisterDelayMs: 25,
			onDomainMeta: (m) => {
				lastStatus = m.domainStatus;
			},
		});

		await waitFor(() => registers.length >= 2);
		await waitFor(() => lastStatus === "rooted");
		expect(registers.length).toBe(2);
		expect(lastStatus).toBe("rooted");

		await new Promise((r) => setTimeout(r, 120));
		expect(registers.length).toBe(2);
	});

	it("does not retry a terminal denial (ok:false without the pending signal)", async () => {
		// Terminal denial must not start a retry loop.
		const registers: Record<string, unknown>[] = [];
		router = await startFakeRouter((sock, msg) => {
			if (msg.type !== "tool_call" || msg.action !== "gateway_register") return;
			registers.push(msg.params as Record<string, unknown>);
			sock.send(
				JSON.stringify({
					type: "tool_result",
					callId: msg.callId,
					result: { ok: false, error: "registration_denied: revoked" },
				}),
			);
		});

		client = startRouterClient({
			ambient: processAmbient(),
			url: `ws://localhost:${router.port}`,
			headers: { Authorization: "Bearer test-token" },
			gatewayId: "test-host",
			domainId: "alice",
			pendingReregisterDelayMs: 25,
		});

		await waitFor(() => registers.length >= 1);
		await new Promise((r) => setTimeout(r, 150));
		expect(registers.length).toBe(1);
	});

	it("clears the pending retry on socket close so a reconnect re-registers cleanly", async () => {
		// Socket close cancels the old timer before reconnect registration.
		let connections = 0;
		const registersPerConn: number[] = [];
		router = await startFakeRouter((sock, msg) => {
			if (msg.type !== "tool_call" || msg.action !== "gateway_register") return;
			const connIdx = (sock as unknown as { __connIdx: number }).__connIdx;
			registersPerConn[connIdx] = (registersPerConn[connIdx] ?? 0) + 1;
			const reply =
				connIdx === 0
					? { ok: false, pending: true, error: "registration_denied: pending" }
					: { ok: true, gateways: [] };
			sock.send(JSON.stringify({ type: "tool_result", callId: msg.callId, result: reply }));
		});
		router.wss.on("connection", (sock) => {
			(sock as unknown as { __connIdx: number }).__connIdx = connections++;
		});

		client = startRouterClient({
			ambient: processAmbient(),
			url: `ws://localhost:${router.port}`,
			headers: { Authorization: "Bearer test-token" },
			gatewayId: "test-host",
			domainId: "alice",
			pendingReregisterDelayMs: 5_000,
		});

		await waitFor(() => (registersPerConn[0] ?? 0) >= 1);
		router.sockets[0].terminate();

		await waitFor(() => client?.isConnected() === true, 10_000);
		await waitFor(() => (registersPerConn[1] ?? 0) >= 1, 10_000);

		await new Promise((r) => setTimeout(r, 150));
		expect(registersPerConn[0]).toBe(1);
		expect(registersPerConn[1]).toBe(1);
	}, 15_000);
});
