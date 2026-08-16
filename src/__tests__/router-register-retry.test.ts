import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { type RouterClient, startRouterClient } from "../gateway/router/routerClient.js";

////////////////////////////////
//  Interfaces & Types

interface FakeRouter {
	wss: WebSocketServer;
	port: number;
	sockets: WebSocket[];
}

////////////////////////////////
//  Functions & Helpers

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

////////////////////////////////
//  Tests

describe("routerClient pending-Domain re-register", () => {
	let client: RouterClient | null = null;
	let router: FakeRouter | null = null;

	afterEach(async () => {
		await closeAll(client, router);
		client = null;
		router = null;
	});

	it("retries after a pending refusal and registers once the Domain roots", async () => {
		// The Router refuses the first register with the pending signal (Domain staged but not yet
		// rooted), then accepts the retry (the admin's phone first-rooted the admin Domain in between).
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
			url: `ws://localhost:${router.port}`,
			headers: { Authorization: "Bearer test-token" },
			gatewayId: "test-host",
			domainId: "alice",
			pendingReregisterDelayMs: 25,
			onDomainMeta: (m) => {
				lastStatus = m.domainStatus;
			},
		});

		// The first register is refused as pending; the bounded timer re-registers and the
		// second register is accepted, so two registers land and the Gateway learns its status.
		await waitFor(() => registers.length >= 2);
		await waitFor(() => lastStatus === "rooted");
		expect(registers.length).toBe(2);
		expect(lastStatus).toBe("rooted");

		// Once rooted, the retry stops: no third register is fired after the success.
		await new Promise((r) => setTimeout(r, 120));
		expect(registers.length).toBe(2);
	});

	it("does not retry a terminal denial (ok:false without the pending signal)", async () => {
		// A revoked / wrong-domain denial carries no pending flag; it is terminal, so the
		// client must NOT spin a re-register loop that would mask the real rejection.
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
			url: `ws://localhost:${router.port}`,
			headers: { Authorization: "Bearer test-token" },
			gatewayId: "test-host",
			domainId: "alice",
			pendingReregisterDelayMs: 25,
		});

		await waitFor(() => registers.length >= 1);
		// Well past several retry intervals: a terminal denial leaves exactly one register.
		await new Promise((r) => setTimeout(r, 150));
		expect(registers.length).toBe(1);
	});

	it("clears the pending retry on socket close so a reconnect re-registers cleanly", async () => {
		// First connection: refuse as pending, then drop the socket before the retry fires.
		// The reconnect's open handler must re-register, and the stale pending timer must not
		// also fire (no duplicate/leaked register racing the fresh connection).
		let connections = 0;
		const registersPerConn: number[] = [];
		router = await startFakeRouter((sock, msg) => {
			if (msg.type !== "tool_call" || msg.action !== "gateway_register") return;
			const connIdx = (sock as unknown as { __connIdx: number }).__connIdx;
			registersPerConn[connIdx] = (registersPerConn[connIdx] ?? 0) + 1;
			// Connection 0 is refused pending then closed; connection 1 (the reconnect) is accepted.
			const reply =
				connIdx === 0
					? { ok: false, pending: true, error: "registration_denied: pending" }
					: { ok: true, gateways: [] };
			sock.send(JSON.stringify({ type: "tool_result", callId: msg.callId, result: reply }));
		});
		router.wss.on("connection", (sock) => {
			(sock as unknown as { __connIdx: number }).__connIdx = connections++;
		});

		// A long pending delay so the close, not the timer, is what ends the first attempt.
		client = startRouterClient({
			url: `ws://localhost:${router.port}`,
			headers: { Authorization: "Bearer test-token" },
			gatewayId: "test-host",
			domainId: "alice",
			pendingReregisterDelayMs: 5_000,
		});

		await waitFor(() => (registersPerConn[0] ?? 0) >= 1);
		// Drop the first socket; the client reconnects (initial backoff delay) and re-registers.
		router.sockets[0].terminate();

		await waitFor(() => client?.isConnected() === true, 10_000);
		await waitFor(() => (registersPerConn[1] ?? 0) >= 1, 10_000);

		// The reconnect registered exactly once; the first connection's pending timer was
		// cleared on close, so it never fired a duplicate on the new socket.
		await new Promise((r) => setTimeout(r, 150));
		expect(registersPerConn[0]).toBe(1);
		expect(registersPerConn[1]).toBe(1);
	}, 15_000);
});
