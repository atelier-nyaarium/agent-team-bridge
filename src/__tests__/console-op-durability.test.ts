import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ConsoleRoutes, createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { createInboxClaims } from "../gateway/router/inboxClaims.js";
import { createInboxDeliveryPump } from "../gateway/router/inboxDeliveryPump.js";
import type { ConsoleOp } from "../shared/console-protocol.js";
import { generateIdentity } from "../shared/crypto.js";
import { fakeDurable } from "./helpers/consoleSeam.js";

const address = "session:test-domain/test-host/session-1";
const roots: string[] = [];

function response(body: unknown, ok = true): Response {
	return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

function row(op: ConsoleOp, opId: string, seq: number) {
	return {
		seq,
		acceptedAt: 10,
		size: 1,
		envelope: {
			origin: {
				kind: "console" as const,
				domainId: "test-domain",
				gatewayId: "phone",
				device: "Pixel",
			},
			opKey: { conversationId: "conversation", opId },
			epoch: 1,
			kind: "console_op" as const,
			contentRefs: [],
		},
		producerSig: "c2ln",
		body: {
			v: 1,
			epoch: 1,
			nonce: "AAAAAAAAAAAAAAAA",
			ciphertext: Buffer.from(JSON.stringify(op), "utf8").toString("base64"),
		},
	};
}

function setup(
	options: { root?: string; send?: (op: ConsoleOp) => Promise<Response>; respond?: (op: ConsoleOp) => Response } = {},
) {
	const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "console-op-delivery-"));
	if (!roots.includes(root)) roots.push(root);
	const identity = generateIdentity();
	const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
	const sent: unknown[] = [];
	const results: unknown[] = [];
	const claims = createInboxClaims(root);
	const opened = (body: unknown) => ({
		kind: "ok" as const,
		plaintext: Buffer.from(Buffer.from((body as { ciphertext: string }).ciphertext, "base64").toString("utf8")),
	});
	const routes: ConsoleRoutes = {
		deliverToOwner: ({ entry }) => {
			sent.push(entry);
			return true;
		},
		send: () =>
			options.send?.({ kind: "send", to: "session-1", body: "hello" }) ??
			Promise.resolve(response({ session_id: "session-1", status: "sent" })),
		respond: () =>
			options.respond?.({ kind: "respond", session_id: "session-1", response: "done" }) ??
			response({ delivered: true }),
		teams: () => response([]),
		discover: async () => response([]),
		discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
	};
	const handler = createConsoleDispatcher({
		registry: new Map(),
		conversationRegistry: new Map(),
		localGatewayId: "test-host",
		localDomainId: "test-domain",
		routes,
		durableOpStore: new DurableOpStore(fakeDurable()),
	});
	const pump = createInboxDeliveryPump({
		claims,
		routerClient: {
			callInboxTool: async (action, params) => {
				calls.push({ action, params });
				return { result: { outcome: action === "inbox_append" ? "accepted" : "delivered" } };
			},
		},
		domainId: "test-domain",
		ownerSignPub: () => identity.sign.pub,
		contentKeyStore: {
			open: opened,
			seal: (plaintext: Buffer) => {
				const body = JSON.parse(plaintext.toString("utf8"));
				results.push(body);
				return {
					kind: "ok" as const,
					envelope: {
						v: 1,
						epoch: 1,
						nonce: "AAAAAAAAAAAAAAAA",
						ciphertext: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
					},
				};
			},
		} as never,
		producerSignPriv: identity.sign.priv,
		consoleDispatch: (op, device, conversationId, opId, ownerSignPub) =>
			handler.handleDelivery(op, device, conversationId, opId, ownerSignPub),
	});
	return {
		calls,
		claims,
		handler,
		pump,
		results,
		root,
		sent,
		row: (op: ConsoleOp, opId: string, seq: number) => row(op, opId, seq),
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("console operation delivery durability", () => {
	it("writes the op result only after the delivery route settles", async () => {
		let settle!: (value: Response) => void;
		const h = setup({
			send: () => new Promise((resolve) => (settle = resolve)),
		});
		const pending = h.pump.onFrame({
			address,
			rows: [h.row({ kind: "send", to: "session-1", body: "hello" }, "send-settle", 1)],
			deliveryEpoch: 1,
		});
		await Promise.resolve();
		expect(h.calls.filter((call) => call.action === "inbox_append")).toHaveLength(0);
		settle(response({ session_id: "session-1", status: "sent" }));
		await pending;
		expect(h.calls.filter((call) => call.action === "inbox_append")).toHaveLength(1);
	});

	it("replays a claimed console operation as lost after restart without dispatching again", async () => {
		const h = setup();
		h.claims.claim(address, 1, 1);
		const restarted = setup({ root: h.root });
		await restarted.pump.onFrame({
			address,
			rows: [restarted.row({ kind: "respond", session_id: "session-1", response: "done" }, "restart-lost", 1)],
			deliveryEpoch: 1,
		});
		expect(restarted.calls.at(-2)).toMatchObject({ action: "inbox_append" });
		expect(restarted.calls.at(-1)).toMatchObject({ action: "inbox_ack", params: { outcome: "delivered" } });
	});

	it("runs concurrent duplicate deliveries once and acknowledges both rows", async () => {
		let calls = 0;
		const h = setup({
			respond: () => {
				calls++;
				return response({ delivered: true });
			},
		});
		const input = {
			address,
			rows: [h.row({ kind: "respond", session_id: "session-1", response: "done" }, "duplicate", 1)],
			deliveryEpoch: 1,
		};
		await Promise.all([h.pump.onFrame(input), h.pump.onFrame(input)]);
		expect(calls).toBe(1);
		expect(h.calls.filter((call) => call.action === "inbox_ack")).toHaveLength(2);
	});

	it("writes a typed failure result and still acknowledges the failed operation", async () => {
		const h = setup({
			respond: () => response({ error: "session unavailable" }, false),
		});
		await h.pump.onFrame({
			address,
			rows: [h.row({ kind: "respond", session_id: "session-1", response: "done" }, "failure", 1)],
			deliveryEpoch: 1,
		});
		expect(h.calls.at(-1)).toMatchObject({ action: "inbox_ack", params: { outcome: "delivered" } });
		expect(h.results).toEqual([{ ok: false, error: "session unavailable" }]);
	});

	it("keeps send and respond results isolated when they share an opId", async () => {
		const h = setup();
		await h.pump.onFrame({
			address,
			rows: [
				h.row({ kind: "send", to: "session-1", body: "hello" }, "shared", 1),
				h.row({ kind: "respond", session_id: "session-1", response: "done" }, "shared", 2),
			],
			deliveryEpoch: 1,
		});
		expect(h.sent).toHaveLength(1);
		expect(h.calls.filter((call) => call.action === "inbox_ack")).toHaveLength(2);
	});

	it("appends one sent echo for a successful send", async () => {
		const h = setup();
		await h.pump.onFrame({
			address,
			rows: [h.row({ kind: "send", to: "session-1", body: "hello" }, "sent-echo", 1)],
			deliveryEpoch: 1,
		});
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({ kind: "sent", opId: "sent-echo" });
	});

	it("writes a typed refusal for an unknown session", async () => {
		const h = setup({
			respond: () => response({ error: "unknown session" }, false),
		});
		await h.pump.onFrame({
			address,
			rows: [h.row({ kind: "respond", session_id: "missing", response: "done" }, "unknown", 1)],
			deliveryEpoch: 1,
		});
		expect(h.calls.at(-1)).toMatchObject({ action: "inbox_ack", params: { outcome: "delivered" } });
	});
});
