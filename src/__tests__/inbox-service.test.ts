import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerQuarantined } from "../federation-server/owner/ownerStateStore.js";
import { generateIdentity } from "../shared/crypto.js";
import { INBOX_ROW_TTL_MS, type InboxAddress, type InboxRowInput, signRowEnvelope } from "../shared/schemasInbox.js";

const roots: string[] = [];
const domainId = "domain-a";
const make = (options: { now?: () => number; ownerOf?: (domainId: string) => string | null } = {}) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-service-"));
	roots.push(dataDir);
	let owner = generateIdentity();
	while (owner.sign.pub.includes("/")) owner = generateIdentity();
	const producer = generateIdentity();
	const producer2 = generateIdentity();
	const router = generateIdentity();
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: options.ownerOf ?? (() => owner.sign.pub),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		now: options.now ?? (() => 100),
	});
	return {
		service: new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv }),
		registry,
		owner,
		producer,
		producer2,
		router,
	};
};
const rowFor = (
	producer: ReturnType<typeof generateIdentity>,
	opId = "op-1",
	origin: InboxRowInput["envelope"]["origin"] = { kind: "console", domainId, device: "phone" },
) => {
	const envelope = {
		origin,
		opKey: { conversationId: "conversation", opId },
		epoch: "clear" as const,
		kind: "op_result" as const,
		contentRefs: [],
	};
	return { envelope, producerSig: signRowEnvelope(envelope, producer.sign.priv), body: { outcome: "accepted" } };
};
const ownerAddress = (owner: ReturnType<typeof generateIdentity>): InboxAddress => ({
	kind: "owner",
	domainId,
	ownerSignPub: owner.sign.pub,
});

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("InboxService", () => {
	it("deduplicates equal hashes and conflicts different hashes", () => {
		const { service, registry, owner, producer } = make();
		const address = ownerAddress(owner);
		const row = rowFor(producer);
		const differentBody = { ...row, body: { outcome: "failed" } };
		const accepted = service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		expect(accepted.outcome).toBe("accepted");
		expect(service.appendRow({ address, row, producerSignPub: producer.sign.pub })).toMatchObject({
			outcome: "accepted",
			seq: 1,
		});
		expect(
			service.appendRow({
				address,
				row: differentBody,
				producerSignPub: producer.sign.pub,
			}),
		).toMatchObject({ outcome: "conflict" });
		expect(service.rows(address, 1, 10)).toHaveLength(1);
		registry.close();
	});

	it("conflicts when an op key is reused at another address", () => {
		const { service, registry, owner, producer } = make();
		const firstAddress = ownerAddress(owner);
		const secondAddress: InboxAddress = { kind: "gateway", domainId, gatewayId: "gateway" };
		const row = rowFor(producer, "same-address");
		expect(service.appendRow({ address: firstAddress, row, producerSignPub: producer.sign.pub }).outcome).toBe(
			"accepted",
		);
		expect(service.appendRow({ address: secondAddress, row, producerSignPub: producer.sign.pub }).outcome).toBe(
			"conflict",
		);
		expect(service.rows(firstAddress, 1, 10)).toHaveLength(1);
		expect(service.rows(secondAddress, 1, 10)).toHaveLength(0);
		registry.close();
	});

	it("deduplicates one op through two producers", () => {
		const { service, registry, owner, producer, producer2 } = make();
		const address = ownerAddress(owner);
		const first = rowFor(producer, "two-connections");
		const second = rowFor(producer2, "two-connections");
		const accepted = service.appendRow({ address, row: first, producerSignPub: producer.sign.pub });
		const replay = service.appendRow({ address, row: second, producerSignPub: producer2.sign.pub });
		expect(replay).toMatchObject({ opKey: accepted.opKey, outcome: accepted.outcome, seq: accepted.seq });
		expect(service.rows(address, 1, 10)).toHaveLength(1);
		registry.close();
	});

	// Producer hash survives resealing.
	it("replays the recorded result for a retry whose bytes changed but whose producer hash did not", () => {
		const { service, registry, owner, producer } = make();
		const address = ownerAddress(owner);
		const row = rowFor(producer);
		const resealed = { ...row, body: { outcome: "resealed" } };
		const opKey = { ...row.envelope.opKey, hash: "a".repeat(64) };

		const first = service.appendRow({ address, row, producerSignPub: producer.sign.pub, opKey });
		const retry = service.appendRow({ address, row: resealed, producerSignPub: producer.sign.pub, opKey });

		expect(first.outcome).toBe("accepted");
		expect(retry).toMatchObject({ outcome: "accepted", seq: 1 });
		expect(service.rows(address, 1, 10)).toHaveLength(1);
		registry.close();
	});

	it("refuses a bad signature and enforces the session cap", () => {
		const { service, registry, producer } = make();
		const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
		service.upsertSession(domainId, "gateway", "session", { kind: "shell", label: "x", recordExists: true });
		service.recreateAddress(address);
		const bad = rowFor(producer);
		bad.producerSig = producer.sign.pub;
		expect(service.appendRow({ address, row: bad, producerSignPub: producer.sign.pub })).toMatchObject({
			outcome: "refused",
		});
		for (let i = 0; i < 200; i++) {
			const row = rowFor(producer, `op-${i}`);
			service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		}
		const before = service.rows(address, 1, 10);
		const refused = service.appendRow({
			address,
			row: rowFor(producer, "op-201"),
			producerSignPub: producer.sign.pub,
		});
		expect(refused.outcome).toBe("refused");
		expect(service.rows(address, 1, 10)).toEqual(before);
		registry.close();
	});

	it("checks gateway ownership and incarnation before delivery ack", () => {
		const { service, registry, producer } = make();
		const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
		service.upsertSession(domainId, "gateway", "session", { kind: "shell", label: "x", recordExists: true });
		const incarnation = service.registerGateway(domainId, "gateway") as number;
		service.recreateAddress(address);
		const accepted = service.appendRow({ address, row: rowFor(producer), producerSignPub: producer.sign.pub });
		const oldEpoch = service.deliveryEpoch(address);
		const currentEpoch = service.recreateAddress(address);
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				deliveryEpoch: oldEpoch,
				outcome: "delivered",
				by: { domainId, gatewayId: "gateway", incarnation },
			}).outcome,
		).toBe("refused");
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				deliveryEpoch: currentEpoch,
				outcome: "delivered",
				by: { domainId, gatewayId: "other", incarnation },
			}).outcome,
		).toBe("refused");
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				deliveryEpoch: currentEpoch,
				outcome: "delivered",
				by: { domainId, gatewayId: "gateway", incarnation: incarnation - 1 },
			}).outcome,
		).toBe("refused");
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				deliveryEpoch: currentEpoch,
				outcome: "delivered",
				by: { domainId, gatewayId: "gateway", incarnation },
			}).outcome,
		).toBe("delivered");
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				outcome: "delivered",
				by: { domainId, gatewayId: "gateway", incarnation },
			}).outcome,
		).toBe("gone");
		registry.close();
	});

	it("persists gateway incarnations across reopen", () => {
		const first = make();
		const firstValue = first.service.registerGateway(domainId, "gateway") as number;
		first.registry.close();
		const registry = new OwnerStoreRegistry({
			dataDir: roots.at(-1) as string,
			ownerOf: () => first.owner.sign.pub,
			quotaFor: () =>
				new DomainQuota({
					dir: roots.at(-1) as string,
					limitBytes: 100_000_000,
					statfs: () => ({ available: 100_000_000 }),
				}),
		});
		const service = new InboxService(registry, {
			signPub: first.router.sign.pub,
			signPriv: first.router.sign.priv,
		});
		expect(service.registerGateway(domainId, "gateway")).toBe(firstValue + 1);
		registry.close();
	});

	it("creates a new consumer epoch after forgetting and keeps sequence numbers after compaction", () => {
		const { service, registry, owner, producer } = make();
		const address = ownerAddress(owner);
		const first = service.registerConsumer(domainId, "phone", 1);
		expect(service.advanceCursor(domainId, "phone", 1, first.cursorEpoch)).toEqual({ outcome: "ok" });
		service.forgetConsumer(domainId, "phone");
		expect(service.advanceCursor(domainId, "phone", 0, first.cursorEpoch)).toMatchObject({
			outcome: "cursor_stale",
		});
		const second = service.registerConsumer(domainId, "phone", 2);
		expect(second.cursorEpoch).not.toBe(first.cursorEpoch);
		const accepted = service.appendRow({
			address,
			row: rowFor(producer, "after"),
			producerSignPub: producer.sign.pub,
		});
		service.advanceCursor(domainId, "phone", accepted.seq as number, second.cursorEpoch);
		service.compactOwnerInbox(domainId);
		const later = service.appendRow({
			address,
			row: rowFor(producer, "later"),
			producerSignPub: producer.sign.pub,
		});
		expect(later.seq).toBeGreaterThan(accepted.seq as number);
		registry.close();
	});

	it("retries retirement after a crash before the compaction floor write", () => {
		const { service, registry, owner, producer } = make();
		const address = ownerAddress(owner);
		const consumer = service.registerConsumer(domainId, "phone", 1);
		const accepted = service.appendRow({
			address,
			row: rowFor(producer, "compact"),
			producerSignPub: producer.sign.pub,
		});
		service.advanceCursor(domainId, "phone", accepted.seq as number, consumer.cursorEpoch);
		const store = registry.for(domainId);
		vi.spyOn(store, "retire").mockImplementationOnce(() => {
			throw new Error("crash");
		});
		expect(() => service.compactOwnerInbox(domainId)).toThrow("crash");
		service.compactOwnerInbox(domainId);
		expect(service.rows(address, 1, 10)).toHaveLength(0);
		registry.close();
	});

	it("does not retire a cross-Domain row when the sender result is refused", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-cross-retire-"));
		roots.push(dataDir);
		const destinationOwner = generateIdentity();
		const senderOwner = generateIdentity();
		const router = generateIdentity();
		const producer = generateIdentity();
		const registry = new OwnerStoreRegistry({
			dataDir,
			ownerOf: (id) =>
				id === "destination" ? destinationOwner.sign.pub : id === "sender" ? senderOwner.sign.pub : null,
			quotaFor: () =>
				new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		});
		const service = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
		const address: InboxAddress = {
			kind: "session",
			domainId: "destination",
			gatewayId: "gateway",
			sessionId: "session",
		};
		service.upsertSession("destination", "gateway", "session", { kind: "shell", label: "x", recordExists: true });
		const sourceRow = rowFor(producer, "cross", {
			kind: "session",
			domainId: "sender",
			gatewayId: "gateway",
			sessionId: "session",
		});
		const peerEnvelope = { ...sourceRow.envelope, epoch: "peer" as const };
		const peerRow = {
			...sourceRow,
			envelope: peerEnvelope,
			producerSig: signRowEnvelope(peerEnvelope, producer.sign.priv),
		};
		const accepted = service.appendRow({
			address,
			row: peerRow,
			producerSignPub: producer.sign.pub,
		});
		const destinationStore = registry.for("destination");
		const before = destinationStore.get(
			"op",
			`op:destination/${accepted.opKey.conversationId}/${accepted.opKey.opId}`,
		);
		const senderStore = registry.for("sender");
		vi.spyOn(senderStore, "batch").mockReturnValue({ kind: "durability_failure", reason: "refused" });
		service.retireRevokedPeerRows("destination", "destination.gateway.session", "sender");
		expect(service.rows(address, 1, 10)).toHaveLength(1);
		expect(
			destinationStore.get("op", `op:destination/${accepted.opKey.conversationId}/${accepted.opKey.opId}`),
		).toEqual(before);
		registry.close();
	});

	it("retires failed rows and records the failed result for the sender", () => {
		const { service, registry, producer } = make();
		const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
		const row = rowFor(producer, "failed", {
			kind: "session",
			domainId,
			gatewayId: "gateway",
			sessionId: "session",
		});
		service.upsertSession(domainId, "gateway", "session", { kind: "shell", label: "x", recordExists: true });
		const accepted = service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		const incarnation = service.registerGateway(domainId, "gateway") as number;
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				outcome: "failed",
				by: { domainId, gatewayId: "gateway", incarnation },
			}),
		).toMatchObject({
			outcome: "failed",
		});
		expect(service.opResult(domainId, row.envelope.opKey)).toMatchObject({ outcome: "failed" });
		expect(service.rows(address, 1, 10).at(0)?.body).toMatchObject({ outcome: "failed" });
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				outcome: "failed",
				by: { domainId, gatewayId: "gateway", incarnation },
			}),
		).toMatchObject({ outcome: "gone" });
		registry.close();
	});

	it("expires owner rows and raises the consumer floor", () => {
		let now = 100;
		const { service, registry, owner, producer } = make({ now: () => now });
		const consumer = service.registerConsumer(domainId, "phone", 1);
		const ownerAddr = ownerAddress(owner);
		const expired = service.appendRow({
			address: ownerAddr,
			row: rowFor(producer, "expired"),
			producerSignPub: producer.sign.pub,
		});
		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);
		expect(service.readOwner(domainId, "phone", consumer.cursor, 10, consumer.cursorEpoch)).toMatchObject({
			floor: (expired.seq as number) + 1,
		});
		registry.close();
	});

	it("expires router rows without writing a result row", () => {
		let now = 100;
		const { service, registry, owner, producer } = make({ now: () => now });
		const address = ownerAddress(owner);
		const routerRow = rowFor(producer, "router", { kind: "router", domainId });
		service.appendRow({ address, row: routerRow, producerSignPub: producer.sign.pub });
		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);
		expect(service.rows(address, 1, 10)).toEqual([]);
		registry.close();
	});

	it("expires a session row into its origin session", () => {
		let now = 100;
		const { service, registry, producer } = make({ now: () => now });
		const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
		const row = rowFor(producer, "session-expired", {
			kind: "session",
			domainId,
			gatewayId: "gateway",
			sessionId: "session",
		});
		service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);
		expect(service.rows(address, 1, 10).at(0)?.body).toMatchObject({ outcome: "expired" });
		registry.close();
	});

	it("expires a peer row into its origin Domain gateway inbox", () => {
		let now = 100;
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-service-peer-expiry-"));
		roots.push(dataDir);
		const originOwner = generateIdentity();
		const targetOwner = generateIdentity();
		const producer = generateIdentity();
		const router = generateIdentity();
		const owners = new Map([
			["origin", originOwner.sign.pub],
			["target", targetOwner.sign.pub],
		]);
		const registry = new OwnerStoreRegistry({
			dataDir,
			ownerOf: (id) => owners.get(id) ?? null,
			quotaFor: () =>
				new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
			now: () => now,
		});
		const service = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
		const address: InboxAddress = { kind: "gateway", domainId: "target", gatewayId: "destination" };
		const row = rowFor(producer, "peer-expired", {
			kind: "gateway",
			domainId: "origin",
			gatewayId: "source",
		});
		service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);
		const second = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
		expect(
			second.rows({ kind: "gateway", domainId: "origin", gatewayId: "source" }, 1, 10).at(0)?.body,
		).toMatchObject({ outcome: "expired" });
		registry.close();
	});

	it("forgets session rows with failed results and advances its delivery epoch", () => {
		const { service, registry, producer } = make();
		const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
		service.upsertSession(domainId, "gateway", "session", { kind: "shell", label: "x", recordExists: true });
		service.recreateAddress(address);
		service.appendRow({
			address,
			row: rowFor(producer, "forgotten", {
				kind: "session",
				domainId,
				gatewayId: "gateway",
				sessionId: "session",
			}),
			producerSignPub: producer.sign.pub,
		});
		const before = service.deliveryEpoch(address);
		service.forgetSession(domainId, "gateway", "session");
		expect(service.deliveryEpoch(address)).not.toBe(before);
		expect(service.rows(address, 1, 10).at(0)?.body).toMatchObject({ outcome: "failed" });
		expect(service.hasSession(domainId, "gateway", "session")).toBe(false);
		registry.close();
	});

	it("refreshes an old consumer read and forgets idle consumers before compacting", () => {
		let now = 100;
		const { service, registry, owner } = make({ now: () => now });
		const consumer = service.registerConsumer(domainId, "phone", 1);
		now += 60 * 60 * 1000 + 1;
		service.readOwner(domainId, "phone", consumer.cursor, 10, consumer.cursorEpoch);
		now += 30 * 24 * 60 * 60 * 1000 + 1;
		service.sweep(now);
		expect(service.readOwner(domainId, "phone", 0, 10, consumer.cursorEpoch)).toMatchObject({
			outcome: "cursor_stale",
		});
		void owner;
		registry.close();
	});

	it("refuses an owner address for a different owner key", () => {
		const { service, registry, producer } = make();
		const address: InboxAddress = { kind: "owner", domainId, ownerSignPub: generateIdentity().sign.pub };
		expect(service.appendRow({ address, row: rowFor(producer), producerSignPub: producer.sign.pub })).toMatchObject(
			{ outcome: "refused" },
		);
		registry.close();
	});

	it("returns null when gateway registration cannot write a quarantined store", () => {
		const fixture = make();
		vi.spyOn(fixture.registry, "for").mockImplementation(() => {
			throw new OwnerQuarantined({ from: 1, to: 1 });
		});
		expect(fixture.service.registerGateway(domainId, "gateway")).toBeNull();
		fixture.registry.close();
	});
});
