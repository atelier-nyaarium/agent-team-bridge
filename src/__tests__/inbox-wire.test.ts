import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONSUMER_IDLE_TTL_MS,
	formatInboxAddress,
	GATEWAY_INBOX_MAX_ROWS,
	INBOX_ACK_OUTCOMES,
	INBOX_ROW_TTL_MS,
	InboxRowInputSchema,
	OWNER_INBOX_MAX_BYTES,
	OWNER_INBOX_MAX_ROWS,
	OwnerOpSchema,
	ownerOpSigningBytes,
	parseInboxAddress,
	RowEnvelopeSchema,
	SESSION_INBOX_MAX_ROWS,
	signOwnerOp,
	signRowEnvelope,
	verifyOwnerOp,
	verifyRowEnvelope,
} from "../shared/schemasInbox.js";

const signerSignPub = "jGn787BASDt0fha5d8cjuYxZBQ2DZPVZzbEel3Cfcv4=";
const signerSignPriv = "hv4it8vBajVd4NohKuqkjiVeqvGiZaYkgN940TvrYrM=";
const envelope = {
	origin: { kind: "console" as const, domainId: "domain-a", device: "phone" },
	opKey: { conversationId: "conversation-a", opId: "op-1" },
	epoch: 1,
	kind: "message" as const,
	contentRefs: [],
};
const content = { v: 1 as const, epoch: 1, nonce: "AQEBAQEBAQEBAQEB", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" };

const ownerVector = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/owner-op/vectors.json"), "utf8"),
) as {
	signerSignPub: string;
	signerSignPriv: string;
	ownerOp: {
		value: Record<string, unknown>;
		signingBytes: string;
		signingBytesHex: string;
		signingBytesBase64: string;
		signature: string;
	};
};

describe("inbox wire", () => {
	it("round trips valid addresses and refuses malformed addresses", () => {
		for (const address of [
			{ kind: "owner" as const, domainId: "domain-a", ownerSignPub: signerSignPub },
			// Standard base64 keys carry slashes about half the time.
			{
				kind: "owner" as const,
				domainId: "domain-a",
				ownerSignPub: "ab/cd+ef/ghijklmnopqrstuvwxyzABCDEFGHIJKLMN=",
			},
			{ kind: "session" as const, domainId: "domain-a", gatewayId: "gateway-a", sessionId: "session-a" },
			{ kind: "gateway" as const, domainId: "domain-a", gatewayId: "gateway-a" },
		]) {
			expect(parseInboxAddress(formatInboxAddress(address))).toEqual(address);
		}
		for (const value of [
			"owner:domain-a/nope!",
			"session:domain-a/gateway",
			"gateway:domain-a/gateway/a",
			"owner:domain\na/key",
		]) {
			expect(parseInboxAddress(value)).toBeNull();
		}
	});

	it("refines row bodies by epoch mode", () => {
		expect(InboxRowInputSchema.safeParse({ envelope, producerSig: signerSignPub, body: content }).success).toBe(
			true,
		);
		expect(
			InboxRowInputSchema.safeParse({
				envelope: { ...envelope, epoch: "peer" },
				producerSig: signerSignPub,
				body: content,
			}).success,
		).toBe(false);
		const routerOrigin = { kind: "router" as const, domainId: envelope.origin.domainId };
		expect(
			InboxRowInputSchema.safeParse({
				envelope: { ...envelope, origin: routerOrigin, epoch: "clear", kind: "op_result" },
				producerSig: signerSignPub,
				body: { outcome: "accepted" },
			}).success,
		).toBe(true);
		// Clear rows are never produced.
		expect(
			InboxRowInputSchema.safeParse({
				envelope: { ...envelope, epoch: "clear", kind: "op_result" },
				producerSig: signerSignPub,
				body: { outcome: "accepted" },
			}).success,
		).toBe(false);
		expect(
			InboxRowInputSchema.safeParse({
				envelope: { ...envelope, origin: routerOrigin, epoch: "clear" },
				producerSig: signerSignPub,
				body: {},
			}).success,
		).toBe(false);
	});

	it("signs row envelopes and refuses a flipped byte", () => {
		const signature = signRowEnvelope(envelope, signerSignPriv);
		expect(verifyRowEnvelope(envelope, signature, signerSignPub)).toBe(true);
		const flipped = Buffer.from(signature, "base64");
		flipped[0] ^= 1;
		expect(verifyRowEnvelope(envelope, flipped.toString("base64"), signerSignPub)).toBe(false);
		expect(RowEnvelopeSchema.safeParse({ ...envelope, kind: "reply" }).success).toBe(true);
	});

	it("matches the OwnerOp vector and rejects newline fields", () => {
		const op = ownerVector.ownerOp.value as never;
		const signed = signOwnerOp(op, ownerVector.signerSignPriv);
		const bytes = ownerOpSigningBytes(op);
		expect(bytes.toString("utf8")).toBe(ownerVector.ownerOp.signingBytes);
		expect(bytes.toString("hex")).toBe(ownerVector.ownerOp.signingBytesHex);
		expect(bytes.toString("base64")).toBe(ownerVector.ownerOp.signingBytesBase64);
		expect(signed.signature).toBe(ownerVector.ownerOp.signature);
		expect(verifyOwnerOp(signed)).toBe(true);
		expect(OwnerOpSchema.safeParse({ ...signed, device: "phone\n" }).success).toBe(false);
	});

	it("exports inbox limits and outcomes", () => {
		expect([OWNER_INBOX_MAX_ROWS, OWNER_INBOX_MAX_BYTES, SESSION_INBOX_MAX_ROWS, GATEWAY_INBOX_MAX_ROWS]).toEqual([
			10_000, 67_108_864, 200, 200,
		]);
		expect(INBOX_ROW_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
		expect(CONSUMER_IDLE_TTL_MS).toBe(INBOX_ROW_TTL_MS);
		expect(INBOX_ACK_OUTCOMES).toEqual(["delivered", "waking", "failed"]);
	});
});
