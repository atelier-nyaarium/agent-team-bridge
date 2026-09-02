import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAdmittedConsole, signAdmission } from "../shared/admission.js";
import {
	type ContentAad,
	deriveContentKey,
	openContent,
	sealContentWithNonce,
	unwrapContentKey,
	wrapContentKey,
} from "../shared/content-envelope.js";
import { generateIdentity } from "../shared/crypto.js";
import { ContentEnvelopeSchema, KeyEnvelopeSchema } from "../shared/schemasContentKey.js";

type Fixture = {
	v: 1;
	derivation: Array<{ ownerSignPrivB64: string; domainId: string; epoch: number; keyB64: string }>;
	envelopes: Array<{
		keyB64: string;
		domainId: string;
		ownerSignPub: string;
		epoch: number;
		kind: ContentAad["kind"];
		nonceB64: string;
		plaintextUtf8: string;
		ciphertextB64: string;
	}>;
	keyEnvelope: {
		epoch: number;
		signerSignPub: string;
		keyB64: string;
		recipientBox: { pub: string; priv: string };
		senderSign: { pub: string; priv: string };
		envelope: Parameters<typeof unwrapContentKey>[0];
		relabeledEpoch: Parameters<typeof unwrapContentKey>[0];
	};
	refusedNonces: string[];
	refusedCiphertext: string;
	acceptedCiphertextB64: string;
};

const fixture = JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, "../../tests/fixtures/content-envelope/vectors.json"), "utf8"),
) as Fixture;

describe("content envelope", () => {
	it("opens every fixture and re-seals byte-identically", () => {
		for (const vector of fixture.envelopes) {
			const key = Buffer.from(vector.keyB64, "base64");
			const env = {
				v: 1 as const,
				epoch: vector.epoch,
				nonce: vector.nonceB64,
				ciphertext: vector.ciphertextB64,
			};
			expect(openContent(env, key, vector).toString("utf8")).toBe(vector.plaintextUtf8);
			expect(
				sealContentWithNonce(
					Buffer.from(vector.plaintextUtf8),
					key,
					vector,
					Buffer.from(vector.nonceB64, "base64"),
				),
			).toEqual(env);
		}
	});

	it("matches the derivation vectors", () => {
		for (const vector of fixture.derivation) {
			expect(deriveContentKey(vector.ownerSignPrivB64, vector.domainId, vector.epoch).toString("base64")).toBe(
				vector.keyB64,
			);
		}
	});

	it("binds content to its domain, owner, epoch, kind, and board entry", () => {
		const vector = fixture.envelopes[0];
		const env = {
			v: 1 as const,
			epoch: vector.epoch,
			nonce: vector.nonceB64,
			ciphertext: vector.ciphertextB64,
		};
		const key = Buffer.from(vector.keyB64, "base64");
		for (const changed of [
			{ kind: "board.body\nentry-1" as const },
			{ kind: "board.title\nentry-2" as const },
			{ epoch: vector.epoch + 1 },
			{ domainId: `${vector.domainId}-other` },
		]) {
			expect(() => openContent(env, key, { ...vector, ...changed })).toThrow();
		}
		const ciphertext = Buffer.from(vector.ciphertextB64, "base64");
		ciphertext[0] ^= 1;
		expect(() => openContent({ ...env, ciphertext: ciphertext.toString("base64") }, key, vector)).toThrow();
	});

	it("wraps and unwraps a content key", () => {
		const vector = fixture.keyEnvelope;
		expect(unwrapContentKey(vector.envelope, vector.recipientBox.priv)).toEqual({
			epoch: vector.epoch,
			key: Buffer.from(vector.keyB64, "base64"),
		});
		const key = Buffer.from(vector.keyB64, "base64");
		expect(() => unwrapContentKey(vector.relabeledEpoch, vector.recipientBox.priv)).toThrow();
		const envelope = wrapContentKey(
			key,
			vector.epoch,
			vector.recipientBox.pub,
			vector.senderSign.pub,
			vector.senderSign.priv,
		);
		expect(unwrapContentKey(envelope, vector.recipientBox.priv).key).toEqual(key);
	});

	it("refuses a signer that is not the one named", () => {
		const vector = fixture.keyEnvelope;
		const other = generateIdentity();
		expect(() =>
			unwrapContentKey({ ...vector.envelope, signerSignPub: other.sign.pub }, vector.recipientBox.priv),
		).toThrow();
	});

	it("refuses invalid envelope and key inputs", () => {
		const vector = fixture.envelopes[0];
		const env = { v: 1 as const, epoch: vector.epoch, nonce: vector.nonceB64, ciphertext: vector.ciphertextB64 };
		const key = Buffer.from(vector.keyB64, "base64");
		const aad = vector;
		expect(() => openContent({ ...env, v: 2 } as never, key, aad)).toThrow();
		expect(() => openContent({ ...env, nonce: Buffer.alloc(11).toString("base64") }, key, aad)).toThrow();
		expect(() => openContent({ ...env, ciphertext: Buffer.alloc(15).toString("base64") }, key, aad)).toThrow();
		expect(() => deriveContentKey(vector.keyB64, vector.domainId, 0)).toThrow();
		expect(() => deriveContentKey(vector.keyB64, vector.domainId, 2147483648)).toThrow();
		expect(() => deriveContentKey(Buffer.alloc(31).toString("base64"), vector.domainId, 1)).toThrow();
		expect(() =>
			wrapContentKey(
				Buffer.alloc(31),
				1,
				fixture.keyEnvelope.recipientBox.pub,
				fixture.keyEnvelope.senderSign.pub,
				fixture.keyEnvelope.senderSign.priv,
			),
		).toThrow();
		expect(() =>
			unwrapContentKey({ ...fixture.keyEnvelope.envelope, epoch: 0 }, fixture.keyEnvelope.recipientBox.priv),
		).toThrow();
		expect(() =>
			unwrapContentKey(
				{ ...fixture.keyEnvelope.envelope, epoch: 2147483648 },
				fixture.keyEnvelope.recipientBox.priv,
			),
		).toThrow();
	});

	it("refuses invalid schema values and accepts valid unpadded base64", () => {
		const vector = fixture.envelopes[0];
		const env = {
			v: 1 as const,
			epoch: vector.epoch,
			nonce: vector.nonceB64,
			ciphertext: vector.ciphertextB64,
		};
		const key = Buffer.from(vector.keyB64, "base64");
		const aad = vector;
		for (const value of [
			{ ...env, v: 2 },
			{ ...env, nonce: Buffer.alloc(11).toString("base64") },
			{ ...env, ciphertext: Buffer.alloc(15).toString("base64") },
			{ ...env, epoch: 0 },
			{ ...env, epoch: 2147483648 },
		]) {
			expect(ContentEnvelopeSchema.safeParse(value).success).toBe(false);
		}
		for (const nonce of fixture.refusedNonces) {
			expect(ContentEnvelopeSchema.safeParse({ ...env, nonce }).success).toBe(false);
			expect(() => openContent({ ...env, nonce }, key, aad)).toThrow();
		}
		expect(fixture.refusedNonces).toContain("AQEBAQEBAQEBAQEB ");
		expect(() => openContent({ ...env, ciphertext: fixture.refusedCiphertext }, key, aad)).toThrow();
		expect(ContentEnvelopeSchema.safeParse({ ...env, ciphertext: fixture.acceptedCiphertextB64 }).success).toBe(
			true,
		);
		expect(() => openContent({ ...env, ciphertext: fixture.acceptedCiphertextB64 }, key, aad)).not.toThrow();
		expect(KeyEnvelopeSchema.safeParse({ ...fixture.keyEnvelope.envelope, epoch: 0 }).success).toBe(false);
		expect(KeyEnvelopeSchema.safeParse({ ...fixture.keyEnvelope.envelope, epoch: 2147483648 }).success).toBe(false);
	});

	it("refuses a gateway admission through the console resolver", () => {
		const owner = generateIdentity();
		const gateway = generateIdentity();
		const admission = signAdmission(
			{
				kind: "gateway",
				signPub: gateway.sign.pub,
				boxPub: gateway.box.pub,
				gatewayId: "gateway",
				issuedAt: 1,
				nonce: "bm9uY2U=",
			},
			owner.sign.priv,
			owner.sign.pub,
		);
		expect(resolveAdmittedConsole([admission], [], owner.sign.pub, gateway.sign.pub)).toBeNull();
	});
});
