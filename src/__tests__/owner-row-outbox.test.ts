import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConsolePushOps, ownerRowBody } from "../gateway/consolePushOps.js";
import type { RouterToolCallResult } from "../gateway/router/routerClient.js";
import { generateIdentity } from "../shared/crypto.js";
import { MailboxEntrySchema } from "../shared/schemasConsoleOp.js";
import { Address } from "../shared/session-id.js";

const identity = generateIdentity();

describe("owner row body", () => {
	it("seals the body the owner-row-reply fixture pins, which both runtimes decode as a MailboxEntry", () => {
		const pinned = JSON.parse(
			fs.readFileSync(path.join(__dirname, "../../tests/fixtures/protocol/owner-row-reply.json"), "utf8"),
		);
		expect(
			ownerRowBody({ kind: "reply", session_id: "host.82d560", body: "done", status: "ok" }, 1757000000000),
		).toEqual(pinned);
		expect(MailboxEntrySchema.safeParse(pinned).success).toBe(true);
		// The bare entry is what the phone was handed before, and what it could not decode.
		expect(MailboxEntrySchema.safeParse({ kind: "reply", session_id: "host.82d560", body: "done" }).success).toBe(
			false,
		);
	});
});

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
		beforeCall?: () => void;
	},
	seal: () =>
		| { kind: "ok"; envelope: { v: 1; epoch: number; nonce: string; ciphertext: string } }
		| { kind: "no_key" } = () => ({
		kind: "ok" as const,
		envelope: { v: 1 as const, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" },
	}),
) {
	return createConsolePushOps({
		dataDir,
		ownerId: () => "owner",
		routerClient: {
			isConnected: () => router.connected,
			isRegistered: () => router.connected,
			callInboxTool: async (_action, params) => {
				router.beforeCall?.();
				router.calls.push(params);
				return (
					router.results.shift() ?? { callId: "call", result: { opKey: params.opKey, outcome: "accepted" } }
				);
			},
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
		first.deliverToOwner({ entry: entry("one"), dedupeKey: "one" });
		await flush();

		const router = { connected: true, results: [], calls: [] as Array<Record<string, unknown>> };
		const second = makePush(root, router);
		await second.drainOutbox();
		expect(router.calls).toHaveLength(1);

		const third = makePush(root, router);
		await third.drainOutbox();
		expect(router.calls).toHaveLength(1);
	});

	it("restores the pre-refactor snapshot shape", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		fs.writeFileSync(
			path.join(root, "owner-row-outbox.json"),
			JSON.stringify([{ entry: entry("legacy"), opId: "legacy-op", label: "legacy" }]),
		);
		const router = { connected: true, results: [], calls: [] as Array<Record<string, unknown>> };
		await makePush(root, router).drainOutbox();
		expect((router.calls[0]?.opKey as { opId: string }).opId).toBe("legacy-op");
	});

	it("persists a row before calling the Router", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		let persisted = false;
		const router = {
			connected: true,
			results: [],
			calls: [] as Array<Record<string, unknown>>,
			beforeCall: () => {
				persisted = fs.existsSync(path.join(root, "owner-row-outbox.json"));
			},
		};
		const push = makePush(root, router);
		push.deliverToOwner({ entry: entry("before-send"), dedupeKey: "before-send" });
		expect(persisted).toBe(true);
	});

	it("keeps a row after an unparseable Router answer", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		const disconnected = { connected: false, results: [], calls: [] as Array<Record<string, unknown>> };
		makePush(root, disconnected).deliverToOwner({ entry: entry("unparseable"), dedupeKey: "unparseable" });
		const router = {
			connected: true,
			results: [{ callId: "call", result: {} }],
			calls: [] as Array<Record<string, unknown>>,
		};
		const push = makePush(root, router);
		await push.drainOutbox();
		expect(router.calls).toHaveLength(1);
		const stored = JSON.parse(fs.readFileSync(path.join(root, "owner-row-outbox.json"), "utf8")) as unknown[];
		expect(stored).toHaveLength(1);
	});

	it("appends mirrorPeer entries to the owner outbox", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		const router = { connected: false, results: [], calls: [] as Array<Record<string, unknown>> };
		makePush(root, router).mirrorPeer(
			Address.local("domain", "gateway", "spawn", "session"),
			"from",
			"to",
			{ body: "peer" },
			"peer-row",
		);
		const stored = JSON.parse(fs.readFileSync(path.join(root, "owner-row-outbox.json"), "utf8")) as Array<{
			entry: { kind: string };
		}>;
		expect(stored[0]?.entry.kind).toBe("peer");
	});

	it("drains queued rows in order", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-row-outbox-"));
		roots.push(root);
		const disconnected = { connected: false, results: [], calls: [] as Array<Record<string, unknown>> };
		const first = makePush(root, disconnected);
		first.deliverToOwner({ entry: entry("one"), dedupeKey: "one" });
		first.deliverToOwner({ entry: entry("two"), dedupeKey: "two" });
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
		first.deliverToOwner({ entry: entry("one"), dedupeKey: "one" });
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
		first.deliverToOwner({ entry: entry("one"), dedupeKey: "one" });
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
		first.deliverToOwner({ entry: firstEntry, dedupeKey: "same" });
		first.deliverToOwner({ entry: secondEntry, dedupeKey: "same" });

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
		first.deliverToOwner({ entry: entry("refused"), dedupeKey: "refused" });
		first.deliverToOwner({ entry: entry("uncertain"), dedupeKey: "uncertain" });

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
