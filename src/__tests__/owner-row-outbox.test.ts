import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConsolePushOps } from "../gateway/consolePushOps.js";
import type { RouterToolCallResult } from "../gateway/router/routerClient.js";
import { generateIdentity } from "../shared/crypto.js";
import { Address } from "../shared/session-id.js";

const identity = generateIdentity();

function entry(body: string) {
	return {
		kind: "notice" as const,
		session_id: `notice.${body}`,
		body,
	};
}

function makePush(
	dataDir: string,
	router: {
		connected: boolean;
		results: RouterToolCallResult[];
		calls: Array<Record<string, unknown>>;
	},
	seal: () =>
		| { kind: "ok"; envelope: { v: 1; epoch: number; nonce: string; ciphertext: string } }
		| { kind: "no_key" } = () => ({
		kind: "ok" as const,
		envelope: { v: 1 as const, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" },
	}),
) {
	process.env.DATA_DIR = dataDir;
	return createConsolePushOps({
		ownerId: () => "owner",
		routerClient: {
			isConnected: () => router.connected,
			isRegistered: () => router.connected,
			callTool: async () => ({ callId: "call", result: { gateways: [] } }),
			callInboxTool: async (_action, params) => {
				router.calls.push(params);
				return router.results.shift() ?? { callId: "call", result: { outcome: "accepted" } };
			},
			incarnation: () => 1,
			stop: () => undefined,
		},
		localGatewayId: "gateway",
		localDomainId: "domain",
		producerSignPriv: identity.sign.priv,
		ownerSignPub: () => identity.sign.pub,
		contentKeyStore: {
			seal,
		},
		localAddress: () => Address.local("domain", "gateway", "spawn", "session"),
		refuseImpersonation: () => null,
		relayWithRetry: async () => ({ ok: true }),
	});
}

async function flush() {
	await new Promise((resolve) => setImmediate(resolve));
}

describe.sequential("OwnerRowOutbox", () => {
	const roots: string[] = [];
	afterEach(() => {
		delete process.env.DATA_DIR;
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	it("survives recreation while disconnected and lands once on reconnect", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		const disconnected = { connected: false, results: [], calls: [] as Array<Record<string, unknown>> };
		const first = makePush(root, disconnected);
		first.deliverToOwner({ entry: entry("one"), dedupeKey: "one", origin: "relay" });
		await flush();

		const router = { connected: true, results: [], calls: [] as Array<Record<string, unknown>> };
		const second = makePush(root, router);
		await second.drainOutbox();
		expect(router.calls).toHaveLength(1);

		const third = makePush(root, router);
		await third.drainOutbox();
		expect(router.calls).toHaveLength(1);
	});

	it("drains queued rows in order", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		const disconnected = { connected: false, results: [], calls: [] as Array<Record<string, unknown>> };
		const first = makePush(root, disconnected);
		first.deliverToOwner({ entry: entry("one"), dedupeKey: "one", origin: "relay" });
		first.deliverToOwner({ entry: entry("two"), dedupeKey: "two", origin: "relay" });
		await flush();

		const router = { connected: true, results: [], calls: [] as Array<Record<string, unknown>> };
		await makePush(root, router).drainOutbox();
		expect(router.calls.map((call) => (call.opKey as { opId: string }).opId)).toEqual(["one", "two"]);
	});

	it("keeps a row after durability uncertainty and retries the same opKey", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		const disconnected = { connected: false, results: [], calls: [] as Array<Record<string, unknown>> };
		const first = makePush(root, disconnected);
		first.deliverToOwner({ entry: entry("one"), dedupeKey: "one", origin: "relay" });
		await flush();

		const router = {
			connected: true,
			results: [
				{
					callId: "call",
					result: { opKey: { conversationId: "c", opId: "o" }, outcome: "durability_uncertain" },
				},
				{ callId: "call", result: { opKey: { conversationId: "c", opId: "o" }, outcome: "accepted" } },
			],
			calls: [] as Array<Record<string, unknown>>,
		};
		const second = makePush(root, router);
		await second.drainOutbox();
		await second.drainOutbox();
		expect(router.calls).toHaveLength(2);
		expect(router.calls[0]?.opKey).toEqual(router.calls[1]?.opKey);
	});

	it("removes a drained row", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		const disconnected = { connected: false, results: [], calls: [] as Array<Record<string, unknown>> };
		const first = makePush(root, disconnected);
		first.deliverToOwner({ entry: entry("one"), dedupeKey: "one", origin: "relay" });
		await flush();

		const router = { connected: true, results: [], calls: [] as Array<Record<string, unknown>> };
		const second = makePush(root, router);
		await second.drainOutbox();
		await makePush(root, router).drainOutbox();
		expect(router.calls).toHaveLength(1);
	});

	it("replaces a queued row with the same opKey", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		const disconnected = { connected: false, results: [], calls: [] as Array<Record<string, unknown>> };
		const first = makePush(root, disconnected);
		const firstEntry = entry("one");
		const secondEntry = { ...firstEntry, body: "two" };
		first.deliverToOwner({ entry: firstEntry, dedupeKey: "same", origin: "relay" });
		first.deliverToOwner({ entry: secondEntry, dedupeKey: "same", origin: "relay" });

		const router = { connected: true, results: [], calls: [] as Array<Record<string, unknown>> };
		await makePush(root, router).drainOutbox();
		expect(router.calls).toHaveLength(1);
	});

	it("queues a notice when sealing reports a missing epoch", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		let available = false;
		const disconnected = { connected: true, results: [], calls: [] as Array<Record<string, unknown>> };
		const first = makePush(root, disconnected, () =>
			available
				? {
						kind: "ok" as const,
						envelope: { v: 1, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" },
					}
				: { kind: "no_key" as const },
		);
		const response = first.humanNotify(new Request("http://gateway/notify"), {
			from: "recipe-app",
			title: "Title",
			summary: "Summary",
			full: "Body",
		});
		expect(response.status).toBe(200);

		available = true;
		const router = { connected: true, results: [], calls: [] as Array<Record<string, unknown>> };
		await makePush(root, router).drainOutbox();
		expect(router.calls).toHaveLength(1);
	});

	it("drops refused rows and retries uncertain rows", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		const disconnected = { connected: false, results: [], calls: [] as Array<Record<string, unknown>> };
		const first = makePush(root, disconnected);
		first.deliverToOwner({ entry: entry("refused"), dedupeKey: "refused", origin: "relay" });
		first.deliverToOwner({ entry: entry("uncertain"), dedupeKey: "uncertain", origin: "relay" });

		const router = {
			connected: true,
			results: [
				{
					callId: "call",
					result: { outcome: "refused", reason: "gone", opKey: { conversationId: "c", opId: "o" } },
				},
				{
					callId: "call",
					result: { outcome: "durability_uncertain", opKey: { conversationId: "c", opId: "o" } },
				},
				{ callId: "call", result: { outcome: "accepted", opKey: { conversationId: "c", opId: "o" } } },
			],
			calls: [] as Array<Record<string, unknown>>,
		};
		const second = makePush(root, router);
		await second.drainOutbox();
		await second.drainOutbox();
		expect(router.calls).toHaveLength(3);
		expect((router.calls[1]?.opKey as { opId: string }).opId).toBe("uncertain");
		expect((router.calls[2]?.opKey as { opId: string }).opId).toBe("uncertain");
	});
});
