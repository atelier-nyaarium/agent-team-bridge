import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReferenceHeldStore } from "../federation-server/blobs/referenceHeldStore.js";
import { RouterBlobCache } from "../federation-server/blobs/routerBlobCache.js";
import { GatewayBridge } from "../federation-server/gatewayBridge.js";
import { OwnerQuarantined } from "../federation-server/owner/ownerStateStore.js";
import { type SignedRevocation, signAdmission, signRegister, signRevocation } from "../shared/admission.js";
import { processAmbient } from "../shared/ambient.js";
import { blobIdFor } from "../shared/blob-store.js";
import { generateIdentity } from "../shared/crypto.js";
import { formatInboxAddress, signRowEnvelope } from "../shared/schemasInbox.js";
import { sealBlobChunk, sealedBlobSize } from "../shared/sealed-blob.js";
import { GATEWAY_REASON_NO_WAITER } from "../shared/wire-vocabulary.js";

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

async function registered(
	inbox: never,
	hasLinkEdge = false,
	blobCache?: never,
	referenceHeld?: ReferenceHeldStore,
	protocolVersion = 1,
) {
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
		ambient: processAmbient(),
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
		protocolVersion,
		signPub: gateway.sign.pub,
		boxPub: gateway.box.pub,
		admission: JSON.stringify(admission),
		proofAt,
		proofNonce: "proof",
		proof: signRegister("gateway", proofAt, "proof", gateway.sign.priv),
	});
	return { bridge, ws, gateway, owner, admission, reply };
}

const signedRow = (envelope: Parameters<typeof signRowEnvelope>[0], signPriv: string, body: unknown) => ({
	envelope,
	producerSig: signRowEnvelope(envelope, signPriv),
	body,
});

describe("GatewayBridge inbox", () => {
	it("a revoked gateway loses its frames on the open connection, then its connection", async () => {
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
		const revocations: SignedRevocation[] = [];
		const bridge = new GatewayBridge({
			ambient: processAmbient(),
			port: 0,
			authToken: "token",
			getDomain: () => ({ ownerSignPub: owner.sign.pub, admissions: [admission], revocations }),
			getDomainMeta: () => null,
			hasLinkEdge: () => false,
			adminDomainId: () => "domain",
			inbox: fakeInbox(),
		});
		bridge.attach();
		bridge.transportAdapter?.handleOpen(socket() as never);
		const proofAt = Date.now();
		await bridge.handleCall("c1", "gateway_register", {
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
		bridge.registerGatewayFrame("probe", "read", () => ({ ok: true }));
		expect(await bridge.handleCall("c1", "probe", { incarnation: 1 })).toEqual({ ok: true });
		// A second registration supersedes c1, which stays registered on its own socket.
		bridge.transportAdapter?.handleOpen(socket() as never);
		await bridge.handleCall("c2", "gateway_register", {
			domainId: "domain",
			gatewayId: "gateway",
			protocolVersion: 1,
			signPub: gateway.sign.pub,
			boxPub: gateway.box.pub,
			admission: JSON.stringify(admission),
			proofAt,
			proofNonce: "proof2",
			proof: signRegister("gateway", proofAt, "proof2", gateway.sign.priv),
		});
		expect(await bridge.handleCall("c2", "list_gateways", {})).toEqual({ gateways: [] });
		const dropped: string[] = [];
		bridge.onGatewayDropped((reg) => dropped.push(reg.gatewayId));

		revocations.push(
			signRevocation(
				{ signPub: gateway.sign.pub, issuedAt: 2, nonce: "revoke" },
				owner.sign.priv,
				owner.sign.pub,
			),
		);
		const refused = { ok: false, error: "gateway_not_admitted" };
		expect(await bridge.handleCall("c1", "probe", { incarnation: 1 })).toEqual(refused);
		expect(await bridge.handleCall("c2", "list_gateways", {})).toEqual(refused);
		bridge.evictSigner("domain", gateway.sign.pub, "revoked");
		const gone = { ok: false, error: "inbox_unavailable" };
		expect(await bridge.handleCall("c1", "probe", { incarnation: 1 })).toEqual(gone);
		expect(await bridge.handleCall("c2", "probe", { incarnation: 1 })).toEqual(gone);
		// Only the current connection was the gateway's presence.
		expect(dropped).toEqual(["gateway"]);
	});

	it("refuses gateway_value for a protocol-1 gateway", async () => {
		const { bridge } = await registered(fakeInbox());
		await expect(
			bridge.forwardGatewayValue("domain", {
				opId: "op",
				conversationId: "conversation",
				signerSignPub: "owner",
				device: "phone",
				gatewayId: "gateway",
				value: { kind: "list_dirs", path: "/" },
			}),
		).resolves.toEqual({ outcome: "unsupported" });
	});

	it("settles a forwarded value with the gateway's answer, which carries no type of its own", async () => {
		const { bridge, ws } = await registered(fakeInbox(), false, undefined, undefined, 2);
		const forwarded = bridge.forwardGatewayValue("domain", {
			opId: "op",
			conversationId: "conversation",
			signerSignPub: "owner",
			device: "phone",
			gatewayId: "gateway",
			value: { kind: "list_dirs", path: "/" },
		});
		const pushed = ws.sent.find((frame) => frame.type === "value_op") as { incarnation: number } | undefined;
		expect(pushed).toMatchObject({ opId: "op", conversationId: "conversation" });

		const answer = await bridge.handleCall("c1", "value_result", {
			opId: "op",
			conversationId: "conversation",
			result: { entries: [] },
			incarnation: pushed!.incarnation,
		});

		expect(answer).toEqual({ settled: true });
		await expect(forwarded).resolves.toEqual({ entries: [] });
	});

	it("refuses a held blob begin for a missing record", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-held-"));
		try {
			const held = new ReferenceHeldStore({ dataDir: root, ambient: processAmbient() });
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
			const held = new ReferenceHeldStore({ dataDir: root, ambient: processAmbient() });
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
			const cache = new RouterBlobCache({
				dataDir: root,
				quotaBytesPerDomain: 1_000,
				ambient: processAmbient(),
			});
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
			expect(cache.read("domain", blobId, 0, ciphertext.length)).toEqual(ciphertext);
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

	it("holds every frame but a read under the Router migration window", async () => {
		const { bridge } = await registered(fakeInbox());
		for (const name of ["board_op", "cross_domain_share", "cross_domain_unshare"])
			bridge.registerGatewayFrame(name, "value", () => ({ ok: true }));
		bridge.registerGatewayFrame("board_session_end", "delivery", () => ({ ok: true }));
		bridge.registerGatewayFrame("board_read", "read", () => ({ ok: true }));
		bridge.setMigrationReady(() => false);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-fence-"));
		const previousDataDir = process.env.DATA_DIR;
		const previousEpoch = process.env.ROUTER_MIGRATION_EPOCH;
		process.env.DATA_DIR = dir;
		process.env.ROUTER_MIGRATION_EPOCH = "9";
		try {
			for (const name of ["board_op", "cross_domain_share", "cross_domain_unshare", "board_session_end"])
				expect(await bridge.handleCall("c1", name, { incarnation: 1 })).toEqual({
					outcome: "refused",
					reason: "migrating",
				});
			expect(await bridge.handleCall("c1", "board_read", { incarnation: 1 })).toEqual({ ok: true });
		} finally {
			if (previousDataDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = previousDataDir;
			if (previousEpoch === undefined) delete process.env.ROUTER_MIGRATION_EPOCH;
			else process.env.ROUTER_MIGRATION_EPOCH = previousEpoch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pushes an owner row a gateway appends to the bound console sockets", async () => {
		const pushed: Array<{ domainId: string; seq: number }> = [];
		const { bridge, gateway, owner } = await registered(
			fakeInbox({
				appendRow: (input: { row: Record<string, unknown> }) => ({
					outcome: "accepted",
					opKey: { conversationId: "c", opId: "o" },
					seq: 14,
					row: { ...input.row, seq: 14, acceptedAt: 1, size: 10 },
				}),
			}),
		);
		bridge.setOwnerRowPush((domainId, row) => pushed.push({ domainId, seq: row.seq }));
		const row = signedRow(
			{
				origin: { kind: "gateway" as const, domainId: "domain", gatewayId: "gateway" },
				opKey: { conversationId: "c", opId: "o" },
				epoch: 1,
				kind: "reply" as const,
				contentRefs: [],
			},
			gateway.sign.priv,
			{ v: 1, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" },
		);
		const answer = await bridge.handleCall("c1", "inbox_append", {
			address: formatInboxAddress({ kind: "owner", domainId: "domain", ownerSignPub: owner.sign.pub }),
			row,
			incarnation: 1,
		});
		expect(answer).toMatchObject({ outcome: "accepted" });
		expect(pushed).toEqual([{ domainId: "domain", seq: 14 }]);
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
			ambient: processAmbient(),
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

	// A name the catalog does not hold reaches no handler, and a name it holds cannot be claimed twice.
	it("catalogues every frame it dispatches beside the register handshake", async () => {
		const { bridge } = await registered(fakeInbox());
		expect(bridge.frameNames().sort()).toEqual(
			[
				"blob_begin",
				"blob_chunk",
				"blob_fetch",
				"blob_fetch_reply",
				"cross_domain_handshake",
				"cross_domain_handshake_reply",
				"cross_domain_handshake_reveal",
				"cross_domain_handshake_reveal_reply",
				"gateway_relay",
				"gateway_relay_reply",
				"inbox_ack",
				"inbox_append",
				"list_gateways",
				"session_forget",
				"session_upsert",
				"value_result",
			].sort(),
		);
		await expect(bridge.handleCall("c1", "value_op", { incarnation: 1 })).rejects.toThrow(
			"unsupported gateway action: value_op",
		);
	});

	it("refuses a service frame that would shadow a built-in or a name already taken", async () => {
		const { bridge } = await registered(fakeInbox());
		expect(() => bridge.registerGatewayFrame("value_result", "value", () => ({ ok: true }))).toThrow(
			'gateway frame "value_result" already registered',
		);
		bridge.registerGatewayFrame("probe", "read", () => ({ ok: true }));
		expect(() => bridge.registerGatewayFrame("probe", "read", () => ({ ok: true }))).toThrow(
			'gateway frame "probe" already registered',
		);
	});

	it("holds every gated built-in writer under the Router migration window and lets every built-in read through", async () => {
		const cache = { stat: () => ({ kind: "miss" }) };
		const { bridge } = await registered(fakeInbox(), false, cache as never);
		bridge.setMigrationReady(() => false);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-builtin-fence-"));
		const previousDataDir = process.env.DATA_DIR;
		const previousEpoch = process.env.ROUTER_MIGRATION_EPOCH;
		process.env.DATA_DIR = dir;
		process.env.ROUTER_MIGRATION_EPOCH = "9";
		try {
			const writers = [
				"inbox_append",
				"inbox_ack",
				"session_upsert",
				"session_forget",
				"blob_begin",
				"blob_chunk",
			];
			for (const name of writers)
				expect(await bridge.handleCall("c1", name, { incarnation: 1 })).toEqual({
					outcome: "refused",
					reason: "migrating",
				});
			expect(
				await bridge.handleCall("c1", "blob_fetch", {
					opId: "op",
					blobId: `sha256-${"0".repeat(64)}`,
					incarnation: 1,
				}),
			).toEqual({ outcome: "absent" });
			expect(
				await bridge.handleCall("c1", "blob_fetch_reply", {
					opId: "op",
					outcome: "absent",
					sealed: false,
					incarnation: 1,
				}),
			).toEqual({ ok: false });
			// Settling a waiter this Router already holds writes nothing of the owner's.
			expect(
				await bridge.handleCall("c1", "value_result", {
					opId: "op",
					conversationId: "conversation",
					result: {},
					incarnation: 1,
				}),
			).toEqual({ settled: false, reason: GATEWAY_REASON_NO_WAITER });
		} finally {
			if (previousDataDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = previousDataDir;
			if (previousEpoch === undefined) delete process.env.ROUTER_MIGRATION_EPOCH;
			else process.env.ROUTER_MIGRATION_EPOCH = previousEpoch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
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
