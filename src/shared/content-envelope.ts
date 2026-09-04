import crypto from "node:crypto";
import { decodeB64, seal, unseal } from "./crypto.js";
import type { ContentEnvelope, ContentKind, KeyEnvelope } from "./schemasContentKey.js";

export {
	keyReceiptSigningBytes,
	keyRequestSigningBytes,
	signKeyReceipt,
	signKeyRequest,
	verifyKeyReceipt,
	verifyKeyRequest,
} from "./key-delivery.js";

const CONTENT_SALT = Buffer.from("switchboard-content-salt-v1", "utf8");
const CONTENT_INFO_PREFIX = "switchboard-content-v1\n";

// Sole AAD derivation owner.

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

export type BoardTextKind = "board.title" | "board.body" | "board.name";
export const BOARD_TITLE_KIND: BoardTextKind = "board.title";
export const BOARD_BODY_KIND: BoardTextKind = "board.body";
export const BOARD_NAME_KIND: BoardTextKind = "board.name";

export function assertNewlineFree(...values: readonly string[]): void {
	if (values.some((value) => /[\r\n]/.test(value))) throw new Error("AAD fields must be newline-free");
}

/** Board kinds require entry IDs. */
export function boardTextAadKind(
	kind: BoardTextKind,
	entryId: string,
	attachmentId?: string,
): `${BoardTextKind}\n${string}` {
	assertNewlineFree(kind, entryId, ...(attachmentId === undefined ? [] : [attachmentId]));
	return [kind, entryId, attachmentId]
		.filter((value): value is string => value !== undefined)
		.join("\n") as `${BoardTextKind}\n${string}`;
}

/** Inbox kinds require row IDs. */
export function inboxBodyAadKind(conversationId: string, opId: string): `inbox.body\n${string}` {
	assertNewlineFree(conversationId, opId);
	return `inbox.body\n${conversationId}\n${opId}`;
}

export function scheduledBodyAadKind(conversationId: string, opId: string): `inbox.body\n${string}` {
	assertNewlineFree(conversationId, opId);
	return `inbox.body\n${conversationId}\n${opId}`;
}

export function opPayloadAadKind(): "op.payload" {
	return "op.payload";
}

const resultAadKind = (...parts: string[]): `op.result\n${string}` => `op.result\n${parts.join("\n")}`;

export function valueResultAadKind(opId: string): `op.result\n${string}` {
	assertNewlineFree(opId);
	return resultAadKind(opId);
}

export function opResultAadKind(conversationId: string, opId: string): `op.result\n${string}` {
	assertNewlineFree(conversationId, opId);
	return resultAadKind(conversationId, opId);
}

export interface ContentAad {
	domainId: string;
	ownerSignPub: string;
	epoch: number;
	// Owner key is the domain root key.
	// Kind is an AAD input, never wire data.
	kind:
		| Exclude<ContentKind, BoardTextKind | "inbox.body">
		| `${BoardTextKind}\n${string}`
		| `inbox.body\n${string}`
		| `op.result\n${string}`
		| `blob\n${string}\n${number}\n${0 | 1}`;
}

export function contentAad({ domainId, ownerSignPub, epoch, kind }: ContentAad): Buffer {
	// Revision absent so untouched halves survive edits.
	// BoardSealing.kt is the byte-for-byte twin.
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
	const body = keyEnvelopePreimage(epoch, key);
	return { epoch, signerSignPub: senderSignPubB64, sealed: seal(body, recipientBoxPubB64, senderSignPrivB64) };
}

export function keyEnvelopePreimage(epoch: number, key: Buffer): Buffer {
	assertContentEpoch(epoch);
	if (key.length !== 32) throw new Error("content key must be 32 bytes");
	return Buffer.concat([Buffer.from(`KEYENVELOPE_V1\n${epoch}\n`, "utf8"), key]);
}

export function unwrapContentKey(env: KeyEnvelope, recipientBoxPrivB64: string): { epoch: number; key: Buffer } {
	assertContentEpoch(env.epoch);
	const body = unseal(env.sealed, recipientBoxPrivB64, env.signerSignPub);
	const preimage = keyEnvelopePreimage(env.epoch, Buffer.alloc(32));
	const prefix = preimage.subarray(0, preimage.length - 32);
	if (!body.subarray(0, prefix.length).equals(prefix)) throw new Error("key envelope prefix is invalid");
	const key = body.subarray(prefix.length);
	if (key.length !== 32) throw new Error("content key must be 32 bytes");
	return { epoch: env.epoch, key: Buffer.from(key) };
}
