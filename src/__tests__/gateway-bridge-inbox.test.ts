import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReferenceHeldStore } from "../federation-server/blobs/referenceHeldStore.js";
import { RouterBlobCache } from "../federation-server/blobs/routerBlobCache.js";
import { GatewayBridge } from "../federation-server/gatewayBridge.js";
import { OwnerQuarantined } from "../federation-server/owner/ownerStateStore.js";
import { signAdmission, signRegister } from "../shared/admission.js";
import { blobIdFor } from "../shared/blob-store.js";
import { generateIdentity } from "../shared/crypto.js";
import { signRowEnvelope } from "../shared/schemasInbox.js";
import { sealBlobChunk, sealedBlobSize } from "../shared/sealed-blob.js";

function socket() {
	const sent: Record<string, unknown>[] = [];
	return {
		sent,
		readyState: 1,
		on: () => undefined,
		send: (value: string) => sent.push(JSON.parse(value)),
		close: () => undefined,
	};
}

const fakeInbox = (overrides: Record<string, unknown> = {}) =>
	({
		registerGateway: () => 1,
		upsertSession: () => undefined,
		hasSession: () => true,
		appendRow: () => ({
			outcome: "accepted",
			opKey: { conversationId: "c", opId: "o" },
			seq: 1,
			row: undefined,
		}),
		ack: () => ({ outcome: "delivered" }),
		deliveryEpoch: () => 1,
		rows: () => [],
		pendingFor: () => [],
		...overrides,
	}) as never;

async function registered(inbox: never, hasLinkEdge = false, blobCache?: never, referenceHeld?: ReferenceHeldStore) {
	const owner = generateIdentity();
	const gateway = generateIdentity();
	const admission = signAdmission(
		{
			kind: "gateway",
			signPub: gateway.sign.pub,
			boxPub: gateway.box.pub,
			gatewayId: "gateway",
			issuedAt: 1,
			nonce: "admit",
		},
		owner.sign.priv,
		owner.sign.pub,
	);
	const bridge = new GatewayBridge({
		port: 0,
		authToken: "token",
		getDomain: () => ({ ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] }),
		getDomainMeta: () => null,
		hasLinkEdge: () => hasLinkEdge,
		adminDomainId: () => "domain",
		inbox,
		blobCache,
		referenceHeld,
	});
	bridge.attach();
	const ws = socket();
	bridge.transportAdapter?.handleOpen(ws as never);
	const proofAt = Date.now();
	const reply = await bridge.handleCall("c1", "gateway_register", {
		domainId: "domain",
		gatewayId: "gateway",
		protocolVersion: 1,
		signPub: gateway.sign.pub,
		boxPub: gateway.box.pub,
		admission: JSON.stringify(admission),
		proofAt,
		proofNonce: "proof",
		proof: signRegister("gateway", proofAt, "proof", gateway.sign.priv),
	});
	return { bridge, ws, gateway, admission, reply };
}

const signedRow = (envelope: Parameters<typeof signRowEnvelope>[0], signPriv: string, body: unknown) => ({
	envelope,
	producerSig: signRowEnvelope(envelope, signPriv),
	body,
});

describe("GatewayBridge inbox", () => {
	it("refuses a held blob begin for a missing record", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-held-"));
		try {
			const held = new ReferenceHeldStore({ dataDir: root });
			held.setReferenceExists(() => false);
			const { bridge } = await registered(fakeInbox(), false, undefined, held);
			const answer = await bridge.handleCall("c1", "blob_begin", {
				blobId: "blob",
				size: 1,
				ciphertextSize: sealedBlobSize(1),
				ciphertextDigest: `sha256-${"0".repeat(64)}`,
				epoch: 1,
				store: "held",
				ref: { kind: "entry", id: "entry:missing" },
				incarnation: 1,
			});
			expect(answer).toEqual({ ok: false, error: "reference missing" });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a held blob begin when the owner is quarantined", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-held-"));
		try {
			const held = new ReferenceHeldStore({ dataDir: root });
			held.setReferenceExists(() => {
				throw new OwnerQuarantined({ from: 1, to: 2 });
			});
			const { bridge } = await registered(fakeInbox(), false, undefined, held);
			const answer = await bridge.handleCall("c1", "blob_begin", {
				blobId: "blob",
				size: 1,
				ciphertextSize: sealedBlobSize(1),
				ciphertextDigest: `sha256-${"0".repeat(64)}`,
				epoch: 1,
				store: "held",
				ref: { kind: "entry", id: "entry:missing" },
				incarnation: 1,
			});
			expect(answer).toEqual({ ok: false, error: "refused", reason: "durability_uncertain" });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts sealed cache begin and chunk frames", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-blob-"));
		try {
			const cache = new RouterBlobCache({ dataDir: root, quotaBytesPerDomain: 1_000 });
			const { bridge } = await registered(fakeInbox(), false, cache as never);
			const plain = Buffer.from("bridge blob");
			const blobId = blobIdFor(plain);
			const ciphertext = sealBlobChunk(
				plain,
				Buffer.alloc(32, 2),
				{ domainId: "domain", ownerSignPub: "owner", epoch: 1, blobId },
				0,
				true,
			);
			const ciphertextDigest = `sha256-${crypto.createHash("sha256").update(ciphertext).digest("hex")}`;
			const begun = (await bridge.handleCall("c1", "blob_begin", {
				blobId,
				size: plain.length,
				ciphertextSize: ciphertext.length,
				ciphertextDigest,
				epoch: 1,
				store: "cache",
				incarnation: 1,
			})) as { kind: string; lease: { id: string; generation: number } };
			expect(begun.kind).toBe("lease");
			const renew = vi.spyOn(cache, "renew");
			expect(
				await bridge.handleCall("c1", "blob_chunk", {
					blobId,
					store: "cache",
					lease: begun.lease,
					offset: 0,
					bytes: ciphertext.toString("base64"),
					final: true,
					incarnation: 1,
				}),
			).toMatchObject({ complete: true });
			expect(renew).toHaveBeenCalledWith("domain", blobId, begun.lease.id);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("registers an incarnation, enforces it, appends a session row, and retires it on ack", async () => {
		const received: unknown[] = [];
		const { bridge, gateway, reply } = await registered(
			fakeInbox({
				ack: (input: unknown) => {
					received.push(input);
					return { outcome: "delivered" };
				},
			}),
		);
		expect(reply).toMatchObject({ ok: true, incarnation: 1 });
		expect(
			await bridge.handleCall("c1", "session_upsert", {
				sessionId: "session",
				kind: "shell",
				label: "x",
				recordExists: true,
				incarnation: 1,
			}),
		).toEqual({ ok: true });
		const row = signedRow(
			{
				origin: { kind: "session" as const, domainId: "domain", gatewayId: "gateway", sessionId: "session" },
				opKey: { conversationId: "c", opId: "o" },
				epoch: 1,
				kind: "message" as const,
				contentRefs: [],
			},
			gateway.sign.priv,
			{ v: 1, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" },
		);
		const address = "session:domain/gateway/session";
		expect(await bridge.handleCall("c1", "inbox_append", { address, row, incarnation: 1 })).toMatchObject({
			outcome: "accepted",
		});
		expect(await bridge.handleCall("c1", "inbox_append", { address, row, incarnation: 2 })).toMatchObject({
			ok: false,
		});
		expect(
			await bridge.handleCall("c1", "inbox_ack", {
				address,
				seq: 1,
				incarnation: 1,
				deliveryEpoch: 1,
				outcome: "delivered",
			}),
		).toMatchObject({ outcome: "delivered" });
		expect(received.at(-1)).toMatchObject({ deliveryEpoch: 1 });
	});

	// Reconcile epoch before writes.
	it("refuses a write from a gateway the migration has fenced", async () => {
		const { bridge, gateway } = await registered(fakeInbox());
		bridge.setMigrationFence(() => true);
		const row = signedRow(
			{
				origin: { kind: "session" as const, domainId: "domain", gatewayId: "gateway", sessionId: "session" },
				opKey: { conversationId: "c", opId: "o" },
				epoch: 1,
				kind: "message" as const,
				contentRefs: [],
			},
			gateway.sign.priv,
			{ v: 1, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" },
		);

		const answer = await bridge.handleCall("c1", "inbox_append", {
			address: "session:domain/gateway/session",
			row,
			incarnation: 1,
		});

		expect(answer).toMatchObject({ ok: false, error: "migrating" });
	});

	// Producer hash defines operation identity.
	it("forwards the producer hash onto the row's own opKey and drops a malformed one", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { bridge, gateway } = await registered(
			fakeInbox({
				appendRow: (input: Record<string, unknown>) => {
					seen.push(input);
					return { outcome: "accepted", opKey: { conversationId: "c", opId: "o" }, seq: 1 };
				},
			}),
		);
		const row = signedRow(
			{
				origin: { kind: "session" as const, domainId: "domain", gatewayId: "gateway", sessionId: "session" },
				opKey: { conversationId: "c", opId: "o" },
				epoch: 1,
				kind: "message" as const,
				contentRefs: [],
			},
			gateway.sign.priv,
			{ v: 1, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" },
		);
		const address = "session:domain/gateway/session";
		const hash = "b".repeat(64);

		await bridge.handleCall("c1", "inbox_append", { address, row, incarnation: 1, opKey: { hash } });
		await bridge.handleCall("c1", "inbox_append", {
			address,
			row,
			incarnation: 1,
			opKey: { conversationId: "other", opId: "other", hash: "not-a-hash" },
		});

		expect(seen[0]?.opKey).toEqual({ conversationId: "c", opId: "o", hash });
		expect(seen[1]?.opKey).toBeUndefined();
	});

	it("re-delivers held rows after the register reply under the new incarnation", async () => {
		const held = { seq: 3, acceptedAt: 1, size: 1, envelope: {}, producerSig: "", body: {} };
		const { ws, reply } = await registered(
			fakeInbox({
				registerGateway: () => 2,
				pendingFor: () => [{ address: "session:domain/gateway/session", rows: [held] }],
			}),
		);
		expect(reply).toMatchObject({ incarnation: 2 });
		expect(ws.sent.some((frame) => frame.type === "inbox_deliver")).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(ws.sent).toContainEqual({
			type: "inbox_deliver",
			address: "session:domain/gateway/session",
			rows: [held],
			incarnation: 2,
			deliveryEpoch: 1,
		});
	});

	it("admits a peer row into a linked Domain and refuses one without the edge", async () => {
		const sealed = { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" };
		const peerRow = (signPriv: string) =>
			signedRow(
				{
					origin: { kind: "gateway" as const, domainId: "domain", gatewayId: "gateway" },
					opKey: { conversationId: "c", opId: "o" },
					epoch: "peer" as const,
					kind: "message" as const,
					contentRefs: [],
				},
				signPriv,
				sealed,
			);
		const address = "session:friend/other/session";
		const unlinked = await registered(fakeInbox());
		expect(
			await unlinked.bridge.handleCall("c1", "inbox_append", {
				address,
				row: peerRow(unlinked.gateway.sign.priv),
				incarnation: 1,
			}),
		).toMatchObject({ ok: false });
		const linked = await registered(fakeInbox(), true);
		expect(
			await linked.bridge.handleCall("c1", "inbox_append", {
				address,
				row: peerRow(linked.gateway.sign.priv),
				incarnation: 1,
			}),
		).toMatchObject({ outcome: "accepted" });
	});

	it("gives an identity-less registration no incarnation and refuses inbox frames", async () => {
		const owner = generateIdentity();
		const bridge = new GatewayBridge({
			port: 0,
			authToken: "token",
			getDomain: () => ({ ownerSignPub: owner.sign.pub, admissions: [], revocations: [] }),
			getDomainMeta: () => null,
			hasLinkEdge: () => false,
			adminDomainId: () => "domain",
			inbox: fakeInbox(),
		});
		bridge.attach();
		const ws = socket();
		bridge.transportAdapter?.handleOpen(ws as never);
		expect(
			await bridge.handleCall("c1", "gateway_register", {
				domainId: "domain",
				gatewayId: "gateway",
				protocolVersion: 1,
			}),
		).not.toHaveProperty("incarnation");
		expect(await bridge.handleCall("c1", "inbox_append", {})).toMatchObject({
			ok: false,
			error: "inbox_unavailable",
		});
	});

	it("refuses session rows from unknown sessions and rows from another gateway", async () => {
		const { bridge, gateway } = await registered(fakeInbox({ hasSession: () => false }));
		const row = (origin: {
			kind: "session" | "gateway";
			domainId: string;
			gatewayId: string;
			sessionId?: string;
		}) =>
			signedRow(
				{
					origin,
					opKey: { conversationId: "c", opId: "row" },
					epoch: "peer",
					kind: "message",
					contentRefs: [],
				},
				gateway.sign.priv,
				{ ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" },
			);
		expect(
			await bridge.handleCall("c1", "inbox_append", {
				address: "session:domain/gateway/missing",
				row: row({ kind: "session", domainId: "domain", gatewayId: "gateway", sessionId: "missing" }),
				incarnation: 1,
			}),
		).toMatchObject({ ok: false, error: "refused" });
		expect(
			await bridge.handleCall("c1", "inbox_append", {
				address: "gateway:domain/other",
				row: row({ kind: "gateway", domainId: "domain", gatewayId: "other" }),
				incarnation: 1,
			}),
		).toMatchObject({ ok: false, error: "refused" });
	});

	it("refuses clear producer rows and cross-domain gateway or unknown-session rows", async () => {
		const { bridge, gateway } = await registered(fakeInbox(), true);
		const row = signedRow(
			{
				origin: { kind: "router", domainId: "domain" },
				opKey: { conversationId: "c", opId: "clear" },
				epoch: "clear",
				kind: "op_result",
				contentRefs: [],
			},
			gateway.sign.priv,
			{ v: 1, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" },
		);
		expect(
			await bridge.handleCall("c1", "inbox_append", { address: "gateway:domain/gateway", row, incarnation: 1 }),
		).toMatchObject({ ok: false, error: "refused" });
		expect(
			await bridge.handleCall("c1", "inbox_append", {
				address: "gateway:friend/gateway",
				row: row as never,
				incarnation: 1,
			}),
		).toMatchObject({ ok: false, error: "refused" });
	});

	it("does not route a blob fetch through an unlinked Domain", async () => {
		const cache = { stat: () => ({ kind: "miss" }) };
		const { bridge } = await registered(fakeInbox(), false, cache as never);
		expect(
			await bridge.handleCall("c1", "blob_fetch", {
				opId: "blob",
				blobId: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				origin: { domainId: "friend", gatewayId: "gateway" },
				incarnation: 1,
			}),
		).toEqual({ outcome: "unreachable" });
	});

	it("keeps a superseding registration when the old connection closes", async () => {
		const { bridge, gateway, admission } = await registered(fakeInbox());
		const ws = socket();
		bridge.transportAdapter?.handleOpen(ws as never);
		const proofAt = Date.now();
		const reply = await bridge.handleCall("c2", "gateway_register", {
			domainId: "domain",
			gatewayId: "gateway",
			protocolVersion: 1,
			signPub: gateway.sign.pub,
			boxPub: gateway.box.pub,
			admission: JSON.stringify(admission),
			proofAt,
			proofNonce: "proof-2",
			proof: signRegister("gateway", proofAt, "proof-2", gateway.sign.priv),
		});
		expect(reply).toMatchObject({ ok: true, incarnation: 1 });
		bridge.onDisconnect("c1");
		expect(bridge.gatewayIds()).toContain("gateway");
	});
});
