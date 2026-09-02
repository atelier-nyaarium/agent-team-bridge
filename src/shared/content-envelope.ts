import crypto from "node:crypto";
import { decodeB64, seal, sign, unseal, verify } from "./crypto.js";
import type { ContentEnvelope, ContentKind, KeyEnvelope, KeyReceipt, KeyRequest } from "./schemasContentKey.js";

const CONTENT_SALT = Buffer.from("switchboard-content-salt-v1", "utf8");
const CONTENT_INFO_PREFIX = "switchboard-content-v1\n";

function assertContentEpoch(epoch: number): void {
	if (!Number.isInteger(epoch) || epoch < 1 || epoch > 2147483647) {
		throw new Error("content epoch must be an integer from 1 to 2147483647");
	}
}

export function deriveContentKey(ownerSignPrivB64: string, domainId: string, epoch: number): Buffer;
export function deriveContentKey(ownerSignPrivB64: string, domainId: string, epoch: number): Buffer {
	assertContentEpoch(epoch);
	const ikm = Buffer.from(ownerSignPrivB64, "base64");
	if (ikm.length !== 32) throw new Error("content key derivation requires a 32-byte ikm");
	return Buffer.from(
		crypto.hkdfSync(
			"sha256",
			ikm,
			CONTENT_SALT,
			Buffer.from(`${CONTENT_INFO_PREFIX}${domainId}\n${epoch}`, "utf8"),
			32,
		),
	);
}

export interface ContentAad {
	domainId: string;
	ownerSignPub: string;
	epoch: number;
	kind: ContentKind | `blob\n${string}\n${number}\n${0 | 1}`;
}

export function contentAad({ domainId, ownerSignPub, epoch, kind }: ContentAad): Buffer {
	return Buffer.from(`${CONTENT_INFO_PREFIX}${domainId}\n${ownerSignPub}\n${String(epoch)}\n${kind}`, "utf8");
}

export function sealContent(plaintext: Buffer, key: Buffer, aad: ContentAad): ContentEnvelope {
	return sealContentWithNonce(plaintext, key, aad, crypto.randomBytes(12));
}

export function sealContentWithNonce(plaintext: Buffer, key: Buffer, aad: ContentAad, nonce: Buffer): ContentEnvelope {
	if (nonce.length !== 12) throw new Error("content nonce must be 12 bytes");
	const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
	cipher.setAAD(contentAad(aad));
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
	return { v: 1, epoch: aad.epoch, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function openContent(env: ContentEnvelope, key: Buffer, aad: ContentAad): Buffer {
	if (env.v !== 1) throw new Error("content envelope version is unsupported");
	if (env.epoch !== aad.epoch) throw new Error("content envelope epoch does not match AAD");
	const nonce = decodeB64(env.nonce);
	const sealed = decodeB64(env.ciphertext);
	if (nonce.length !== 12) throw new Error("content nonce must be 12 bytes");
	if (sealed.length < 16) throw new Error("content ciphertext is too short");
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
	decipher.setAAD(contentAad(aad));
	decipher.setAuthTag(sealed.subarray(-16));
	return Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
}

export function wrapContentKey(
	key: Buffer,
	epoch: number,
	recipientBoxPubB64: string,
	senderSignPubB64: string,
	senderSignPrivB64: string,
): KeyEnvelope {
	if (key.length !== 32) throw new Error("content key must be 32 bytes");
	assertContentEpoch(epoch);
	const body = Buffer.concat([Buffer.from(`KEYENVELOPE_V1\n${epoch}\n`, "utf8"), key]);
	return { epoch, signerSignPub: senderSignPubB64, sealed: seal(body, recipientBoxPubB64, senderSignPrivB64) };
}

export function unwrapContentKey(env: KeyEnvelope, recipientBoxPrivB64: string): { epoch: number; key: Buffer } {
	assertContentEpoch(env.epoch);
	const body = unseal(env.sealed, recipientBoxPrivB64, env.signerSignPub);
	const prefix = Buffer.from(`KEYENVELOPE_V1\n${env.epoch}\n`, "utf8");
	if (!body.subarray(0, prefix.length).equals(prefix)) throw new Error("key envelope prefix is invalid");
	const key = body.subarray(prefix.length);
	if (key.length !== 32) throw new Error("content key must be 32 bytes");
	return { epoch: env.epoch, key: Buffer.from(key) };
}

export function keyRequestSigningBytes(r: KeyRequest): Buffer {
	return Buffer.from(
		["KEYREQUEST_V1", r.domainId, r.requesterSignPub, r.epochs.join(","), String(r.at), r.nonce].join("\n"),
		"utf8",
	);
}

export function keyReceiptSigningBytes(r: KeyReceipt): Buffer {
	return Buffer.from(
		["KEYRECEIPT_V1", r.domainId, r.recipientSignPub, String(r.epoch), String(r.at), r.nonce].join("\n"),
		"utf8",
	);
}

export function signKeyRequest(request: KeyRequest, signPrivB64: string): KeyRequest {
	return { ...request, signature: sign(keyRequestSigningBytes(request), signPrivB64) };
}

export function verifyKeyRequest(request: KeyRequest): boolean {
	return verify(keyRequestSigningBytes(request), request.signature, request.requesterSignPub);
}

export function signKeyReceipt(receipt: KeyReceipt, signPrivB64: string): KeyReceipt {
	return { ...receipt, signature: sign(keyReceiptSigningBytes(receipt), signPrivB64) };
}

export function verifyKeyReceipt(receipt: KeyReceipt): boolean {
	return verify(keyReceiptSigningBytes(receipt), receipt.signature, receipt.recipientSignPub);
}
