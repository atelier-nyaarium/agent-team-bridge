import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayRegistration } from "../federation-server/gatewayBridge.js";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OwnerOpIntake } from "../federation-server/inbox/ownerOpIntake.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { createKeyDeliveryService } from "../federation-server/keyDeliveryService.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { type DomainSnapshot, signAdmission } from "../shared/admission.js";
import { keyReceiptSigningBytes, signKeyReceipt, signKeyRequest, wrapContentKey } from "../shared/content-envelope.js";
import { generateIdentity, sign } from "../shared/crypto.js";
import type { KeyGrant, KeyReceipt, KeyRequest } from "../shared/schemasContentKey.js";
import { formatInboxAddress, type InboxAddress, signOwnerOp } from "../shared/schemasInbox.js";

const domainId = "domain-a";
const roots: string[] = [];

const rowKind = (rows: unknown[]) =>
	(rows[0] as { row?: { envelope?: { kind?: string } } } | undefined)?.row?.envelope?.kind;

function make() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "key-delivery-"));
	roots.push(dataDir);
	const owner = generateIdentity();
	const gateway = generateIdentity();
	const consoleIdentity = generateIdentity();
	const otherGateway = generateIdentity();
	const router = generateIdentity();
	const domain: DomainSnapshot = {
		ownerSignPub: owner.sign.pub,
		admissions: [
			signAdmission(
				{
					kind: "gateway",
					signPub: gateway.sign.pub,
					boxPub: gateway.box.pub,
					gatewayId: "gateway-a",
					issuedAt: 1,
					nonce: "g",
				},
				owner.sign.priv,
				owner.sign.pub,
			),
			signAdmission(
				{
					kind: "console",
					signPub: consoleIdentity.sign.pub,
					boxPub: consoleIdentity.box.pub,
					issuedAt: 1,
					nonce: "c",
				},
				owner.sign.priv,
				owner.sign.pub,
			),
		],
		revocations: [],
	};
	let now = 1000;
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (id) => (id === domainId ? owner.sign.pub : null),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		now: () => now,
	});
	const inbox = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
	const intake = new OwnerOpIntake({
		inbox,
		getDomain: (id) => (id === domainId ? domain : null),
		push: () => false,
		now: () => now,
	});
	const ownerOps = new Map<string, (op: never, value: Record<string, unknown>) => unknown>();
	const frames = new Map<string, (reg: GatewayRegistration, value: Record<string, unknown>) => unknown>();
	createKeyDeliveryService({
		registry,
		inbox,
		intake,
		routerIdentity: { signPub: router.sign.pub, signPriv: router.sign.priv },
		getDomain: (id) => (id === domainId ? domain : null),
		deliver: () => undefined,
	}).register({
		ownerOp: (kind, handler) => {
			intake.register(kind, handler);
			ownerOps.set(kind, handler as (op: never, value: Record<string, unknown>) => unknown);
		},
		gatewayFrame: (name, handler) => frames.set(name, handler),
		onGatewayRegistered: () => undefined,
		onGatewayDropped: () => undefined,
		onSessionForgotten: () => undefined,
		pushFrameTo: () => false,
		gatewayIncarnation: () => null,
		connectedGateways: () => [],
	});
	const ownerAddress: InboxAddress = { kind: "owner", domainId, ownerSignPub: owner.sign.pub };
	const gatewayAddress: InboxAddress = { kind: "gateway", domainId, gatewayId: "gateway-a" };
	const registration: GatewayRegistration = {
		domainId,
		gatewayId: "gateway-a",
		signPub: gateway.sign.pub,
		incarnation: 1,
	};
	const op = (signer: typeof consoleIdentity, opId: string, value: Record<string, unknown>) =>
		signOwnerOp(
			{
				v: 1,
				domainId,
				signerSignPub: signer.sign.pub,
				conversationId: "keys",
				device: "phone",
				opId,
				at: now,
				nonce: Buffer.from(opId).toString("base64"),
				op: value,
			},
			signer.sign.priv,
		);
	const request = (signer = gateway, nonce = "request-1"): KeyRequest =>
		signKeyRequest(
			{
				v: 1,
				domainId,
				requesterSignPub: signer.sign.pub,
				epochs: [1, 2],
				at: now,
				nonce: Buffer.from(nonce).toString("base64"),
				signature: "",
			},
			signer.sign.priv,
		);
	const receipt = (at: number, nonce: string, signer = gateway): KeyReceipt =>
		signKeyReceipt(
			{
				v: 1,
				domainId,
				recipientSignPub: signer.sign.pub,
				epoch: 1,
				at,
				nonce: Buffer.from(nonce).toString("base64"),
				signature: "",
			},
			signer.sign.priv,
		);
	const grant = (recipientSignPub: string, recipientBoxPub: string, signer = consoleIdentity): KeyGrant => ({
		v: 1,
		recipientSignPub,
		envelope: wrapContentKey(Buffer.alloc(32, 7), 1, recipientBoxPub, signer.sign.pub, signer.sign.priv),
		at: now,
	});
	return {
		owner,
		gateway,
		consoleIdentity,
		otherGateway,
		registry,
		intake,
		ownerOps,
		frames,
		ownerAddress,
		gatewayAddress,
		registration,
		request,
		receipt,
		grant,
		op,
		setNow: (value: number) => (now = value),
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("key delivery", () => {
	it("appends one request row and replays a frame nonce", () => {
		const ctx = make();
		const value = { request: ctx.request() };
		const first = ctx.frames.get("key_request")!(ctx.registration, value);
		const second = ctx.frames.get("key_request")!(ctx.registration, value);
		expect(first).toMatchObject({ outcome: "accepted", seq: 1 });
		expect(second).toEqual(first);
		expect(ctx.registry.for(domainId).rows(formatInboxAddress(ctx.ownerAddress), 1, 10)).toHaveLength(1);
		expect(rowKind(ctx.registry.for(domainId).rows(formatInboxAddress(ctx.ownerAddress), 1, 10))).toBe(
			"key_request",
		);
		ctx.registry.close();
	});

	it("refuses a frame request whose requester differs from the registration", () => {
		const ctx = make();
		const result = ctx.frames.get("key_request")!(ctx.registration, { request: ctx.request(ctx.otherGateway) });
		expect(result).toMatchObject({ outcome: "refused" });
		expect(ctx.registry.for(domainId).rows(formatInboxAddress(ctx.ownerAddress), 1, 10)).toHaveLength(0);
		ctx.registry.close();
	});

	it("refuses an OwnerOp request for another admitted member", async () => {
		const ctx = make();
		const result = await ctx.intake.handle(
			ctx.op(ctx.consoleIdentity, "foreign-requester", { kind: "key_request", request: ctx.request() }),
		);
		expect(result).toMatchObject({ outcome: "refused", reason: "requester" });
		expect(ctx.registry.for(domainId).list("inbox.row")).toHaveLength(0);
		ctx.registry.close();
	});

	it("routes grants to gateway and console addresses", async () => {
		const ctx = make();
		const gatewayResult = await ctx.intake.handle(
			ctx.op(ctx.consoleIdentity, "grant-gateway", {
				kind: "key_grant",
				grant: ctx.grant(ctx.gateway.sign.pub, ctx.gateway.box.pub),
			}),
		);
		const consoleResult = await ctx.intake.handle(
			ctx.op(ctx.consoleIdentity, "grant-console", {
				kind: "key_grant",
				grant: ctx.grant(ctx.consoleIdentity.sign.pub, ctx.consoleIdentity.box.pub),
			}),
		);
		expect(gatewayResult).toMatchObject({ outcome: "accepted", seq: 1 });
		expect(consoleResult).toMatchObject({ outcome: "accepted", seq: 1 });
		expect(rowKind(ctx.registry.for(domainId).rows(formatInboxAddress(ctx.gatewayAddress), 1, 10))).toBe(
			"key_grant",
		);
		expect(rowKind(ctx.registry.for(domainId).rows(formatInboxAddress(ctx.ownerAddress), 1, 10))).toBe("key_grant");
		ctx.registry.close();
	});

	it("refuses grants with the wrong signer or recipient", async () => {
		const ctx = make();
		const wrongSigner = ctx.grant(ctx.gateway.sign.pub, ctx.gateway.box.pub, ctx.gateway);
		const signerResult = await ctx.intake.handle(
			ctx.op(ctx.consoleIdentity, "wrong-signer", { kind: "key_grant", grant: wrongSigner }),
		);
		const unknown = ctx.grant(ctx.otherGateway.sign.pub, ctx.otherGateway.box.pub);
		const recipientResult = await ctx.intake.handle(
			ctx.op(ctx.consoleIdentity, "unknown-recipient", { kind: "key_grant", grant: unknown }),
		);
		expect(signerResult).toMatchObject({ outcome: "refused" });
		expect(recipientResult).toMatchObject({ outcome: "refused" });
		expect(ctx.registry.for(domainId).rows(formatInboxAddress(ctx.ownerAddress), 1, 10)).toHaveLength(0);
		ctx.registry.close();
	});

	it("writes, replays, replaces, rejects stale receipts, and reads them", async () => {
		const ctx = make();
		const frame = ctx.frames.get("key_receipt")!;
		const firstValue = { receipt: ctx.receipt(1000, "receipt-1") };
		expect(frame(ctx.registration, firstValue)).toMatchObject({ outcome: "accepted" });
		expect(frame(ctx.registration, firstValue)).toMatchObject({ outcome: "accepted" });
		expect(frame(ctx.registration, { receipt: ctx.receipt(1001, "receipt-2") })).toMatchObject({
			outcome: "accepted",
		});
		expect(frame(ctx.registration, { receipt: ctx.receipt(999, "receipt-3") })).toMatchObject({
			outcome: "refused",
			reason: "stale",
		});
		const record = ctx.registry.for(domainId).get("keyReceipt", `${ctx.gateway.sign.pub}/1`);
		expect(record?.clear).toMatchObject({ recipientSignPub: ctx.gateway.sign.pub, epoch: 1, at: 1001 });
		const read = await ctx.intake.handle(
			ctx.op(ctx.consoleIdentity, "read-receipts", { kind: "key_receipts_read" }),
		);
		expect(read).toEqual({ receipts: [{ recipientSignPub: ctx.gateway.sign.pub, epoch: 1, at: 1001 }] });
		ctx.registry.close();
	});

	it("refuses bad signatures and mismatched OwnerOp receipt recipients", async () => {
		const ctx = make();
		const bad = ctx.receipt(1000, "bad");
		bad.signature = sign(keyReceiptSigningBytes({ ...bad, signature: "" }), ctx.consoleIdentity.sign.priv);
		const badResult = ctx.frames.get("key_receipt")!(ctx.registration, { receipt: bad });
		const mismatch = ctx.receipt(1000, "mismatch", ctx.gateway);
		const mismatchResult = await ctx.intake.handle(
			ctx.op(ctx.consoleIdentity, "mismatch", { kind: "key_receipt", receipt: mismatch }),
		);
		expect(badResult).toMatchObject({ outcome: "refused" });
		expect(mismatchResult).toMatchObject({ outcome: "refused" });
		expect(ctx.registry.for(domainId).list("keyReceipt")).toHaveLength(0);
		ctx.registry.close();
	});

	it("returns the OwnerOp key on every service refusal", async () => {
		const ctx = make();
		const direct = (
			kind: string,
			opId: string,
			value: Record<string, unknown>,
			signer = ctx.consoleIdentity.sign.pub,
		) => ctx.ownerOps.get(kind)!({ conversationId: "refusals", opId, signerSignPub: signer } as never, value);
		const badRequest = ctx.request();
		badRequest.signature = Buffer.from("bad").toString("base64");
		const badReceipt = ctx.receipt(1000, "bad");
		badReceipt.signature = Buffer.from("bad").toString("base64");
		const cases = [
			["key_request", "malformed", {}, "malformed"],
			[
				"key_grant",
				"bad-grant-signer",
				{ kind: "key_grant", grant: ctx.grant(ctx.gateway.sign.pub, ctx.gateway.box.pub, ctx.gateway) },
				"signer",
			],
			[
				"key_grant",
				"unknown-recipient",
				{ kind: "key_grant", grant: ctx.grant(ctx.otherGateway.sign.pub, ctx.otherGateway.box.pub) },
				"recipient",
			],
			["key_receipt", "invalid-receipt", { kind: "key_receipt", receipt: badReceipt }, "invalid receipt"],
			["key_request", "foreign-requester", { kind: "key_request", request: ctx.request() }, "requester"],
		] as const;
		for (const [kind, opId, value, reason] of cases)
			expect(await direct(kind, opId, value)).toEqual({
				opKey: { conversationId: "refusals", opId },
				outcome: "refused",
				reason,
			});
		expect(
			await direct(
				"key_request",
				"invalid-request",
				{ kind: "key_request", request: badRequest },
				ctx.gateway.sign.pub,
			),
		).toEqual({
			opKey: { conversationId: "refusals", opId: "invalid-request" },
			outcome: "refused",
			reason: "invalid request",
		});
		ctx.registry.close();
	});
});
