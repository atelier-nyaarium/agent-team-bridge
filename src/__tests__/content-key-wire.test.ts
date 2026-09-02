import { describe, expect, it } from "vitest";
import {
	keyReceiptSigningBytes,
	keyRequestSigningBytes,
	signKeyReceipt,
	signKeyRequest,
	verifyKeyReceipt,
	verifyKeyRequest,
} from "../shared/content-envelope.js";
import { generateIdentity } from "../shared/crypto.js";
import { KeyGrantSchema, KeyReceiptSchema, KeyRequestSchema } from "../shared/schemasContentKey.js";

const identity = generateIdentity();

const request = {
	v: 1 as const,
	domainId: "domain-a",
	requesterSignPub: identity.sign.pub,
	epochs: [1, 3, 8],
	at: 1717171717171,
	nonce: "cmVxdWVzdC1ub25jZQ==",
	signature: "",
};

const receipt = {
	v: 1 as const,
	domainId: "domain-a",
	recipientSignPub: identity.sign.pub,
	epoch: 3,
	keyringGeneration: 4,
	at: 1717171717171,
	nonce: "cmVjZWlwdC1ub25jZQ==",
	signature: "",
};

describe("content key wire", () => {
	it("signs and verifies key requests", () => {
		const signed = signKeyRequest(request, identity.sign.priv);

		expect(verifyKeyRequest(signed)).toBe(true);
		expect(verifyKeyRequest({ ...signed, at: signed.at + 1 })).toBe(false);
	});

	it("signs and verifies key receipts", () => {
		const signed = signKeyReceipt(receipt, identity.sign.priv);

		expect(verifyKeyReceipt(signed)).toBe(true);
		expect(verifyKeyReceipt({ ...signed, epoch: signed.epoch + 1 })).toBe(false);
	});

	it("rejects newline-bearing fields and zero epochs", () => {
		expect(KeyRequestSchema.safeParse({ ...request, domainId: "domain\na" }).success).toBe(false);
		expect(KeyReceiptSchema.safeParse({ ...receipt, nonce: "nonce\n" }).success).toBe(false);
		expect(KeyRequestSchema.safeParse({ ...request, epochs: [0] }).success).toBe(false);
		expect(KeyReceiptSchema.safeParse({ ...receipt, epoch: 0 }).success).toBe(false);
	});

	it("keeps signing bytes stable", () => {
		expect(keyRequestSigningBytes({ ...request, requesterSignPub: "requester" }).toString("utf8")).toBe(
			"KEYREQUEST_V1\ndomain-a\nrequester\n1,3,8\n1717171717171\ncmVxdWVzdC1ub25jZQ==",
		);
		expect(keyReceiptSigningBytes({ ...receipt, recipientSignPub: "recipient" }).toString("utf8")).toBe(
			"KEYRECEIPT_V1\ndomain-a\nrecipient\n3\n4\n1717171717171\ncmVjZWlwdC1ub25jZQ==",
		);
	});

	it("accepts each key grant field shape", () => {
		expect(
			KeyGrantSchema.safeParse({
				v: 1,
				recipientSignPub: identity.sign.pub,
				envelope: {
					epoch: 1,
					signerSignPub: identity.sign.pub,
					sealed: {
						ephemeralPub: "ZXBo",
						nonce: "bm9uY2U=",
						ciphertext: "Y2lwaGVydGV4dA==",
						signature: "c2ln",
					},
				},
				at: 0,
			}).success,
		).toBe(true);
	});
});
