import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { type RouterClient, startRouterClient } from "../gateway/router/routerClient.js";
import { processAmbient } from "../shared/ambient.js";
import type { RouterReach } from "../shared/router-reach.js";

interface FakeRouter {
	wss: WebSocketServer;
	url: string;
	registers: number;
}

function startFakeRouter(reach?: RouterReach): Promise<FakeRouter> {
	return new Promise((resolve) => {
		const state = { registers: 0 } as { registers: number };
		const wss = new WebSocketServer({ port: 0 }, () => {
			resolve({
				wss,
				url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
				get registers() {
					return state.registers;
				},
			} as FakeRouter);
		});
		wss.on("connection", (sock: WebSocket) => {
			sock.on("message", (raw) => {
				const msg = JSON.parse(raw.toString()) as { type?: string; callId?: string; action?: string };
				if (msg.type === "tool_call" && msg.action === "gateway_register") {
					state.registers++;
					sock.send(
						JSON.stringify({
							type: "tool_result",
							callId: msg.callId,
							result: {
								ok: true,
								protocolVersion: 1,
								domainId: "d",
								gateways: [],
								...(reach ? { reach } : {}),
							},
						}),
					);
				}
			});
		});
	});
}

function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
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

function client(config: Omit<Parameters<typeof startRouterClient>[0], "ambient">): RouterClient {
	return startRouterClient({ ...config, ambient: processAmbient() });
}

describe("routerClient reach failover", () => {
	let live: RouterClient | null = null;
	let router: FakeRouter | null = null;

	afterEach(async () => {
		live?.stop();
		live = null;
		await new Promise<void>((resolve) => (router ? router.wss.close(() => resolve()) : resolve()));
		router = null;
	});

	it("steps past a learned address that will not open and reaches the bootstrap", async () => {
		router = await startFakeRouter();
		live = client({
			url: router.url,
			headers: {},
			gatewayId: "gw",
			domainId: "d",
			reach: { lanAddresses: ["10.255.255.1"] },
			reconnectInitialDelayMs: 20,
		});
		await waitFor(() => (router?.registers ?? 0) > 0, 15_000);
		expect(router.registers).toBeGreaterThan(0);
	}, 20_000);

	// Learned reach is persisted through the callback.
	it("hands the advertised reach to onReach", async () => {
		const advertised: RouterReach = { publicHost: "r.example.com", publicPort: 8443, lanAddresses: ["10.1.2.3"] };
		router = await startFakeRouter(advertised);
		let learned: RouterReach | null = null;
		live = client({
			url: router.url,
			headers: {},
			gatewayId: "gw",
			domainId: "d",
			onReach: (r) => {
				learned = r;
			},
		});
		await waitFor(() => learned !== null);
		expect(learned).toEqual(advertised);
	});

	// An absent advertisement leaves existing reach unchanged.
	it("does not report a reach when the Router advertises none", async () => {
		router = await startFakeRouter();
		let calls = 0;
		live = client({
			url: router.url,
			headers: {},
			gatewayId: "gw",
			domainId: "d",
			onReach: () => {
				calls++;
			},
		});
		await waitFor(() => (router?.registers ?? 0) > 0);
		await new Promise((r) => setTimeout(r, 100));
		expect(calls).toBe(0);
	});
});
