import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { type EvieClient, startEvieClient } from "../gateway/evie/evieClient.js";
import type { RouterReach } from "../shared/router-reach.js";

////////////////////////////////
//  Functions & Helpers
//
//  The Gateway holds ONE socket, so its failover lives in the reconnect loop rather than per request:
//  a candidate that will not open must be stepped past, and one that opens must be kept. Before this
//  the client redialed a single fixed URL forever, and an address that stopped working was an outage
//  no amount of reconnecting could clear.

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

function client(config: Parameters<typeof startEvieClient>[0]): EvieClient {
	return startEvieClient(config);
}

////////////////////////////////
//  Tests

describe("evieClient reach failover", () => {
	let live: EvieClient | null = null;
	let router: FakeRouter | null = null;

	afterEach(async () => {
		live?.stop();
		live = null;
		await new Promise<void>((resolve) => (router ? router.wss.close(() => resolve()) : resolve()));
		router = null;
	});

	// A learned LAN address that is dead must not wedge the Gateway: the ring steps past it to the
	// bootstrap, which is what a second machine hits the moment the Router's LAN IP changes.
	it("steps past a learned address that will not open and reaches the bootstrap", async () => {
		router = await startFakeRouter();
		// RFC1918 and unassigned here, which is exactly the shape of a stale LAN address: the Router
		// advertised it once, the machine has since moved, and it now answers nothing. Private, so it
		// gets the short budget rather than the full connect timeout.
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

	// What the Router advertises is persisted through the callback, so a restart starts from the
	// learned addresses instead of walking the ring again.
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

	// An older Router says nothing about its addresses, and that must leave the ring alone rather
	// than blanking what the Gateway already knew.
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
