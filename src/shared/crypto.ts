import crypto from "node:crypto";
import { z } from "zod";
import { CONTENT_NONCE_BYTES } from "./wire-vocabulary.js";

export interface KeyPairRaw {
	pub: string;
	priv: string;
}

export interface Identity {
	sign: KeyPairRaw;
	box: KeyPairRaw;
}

type Curve = "ed25519" | "x25519";

// Raw keys match Android wire encoding.
const SPKI_PREFIX: Record<Curve, Buffer> = {
	ed25519: Buffer.from("302a300506032b6570032100", "hex"),
	x25519: Buffer.from("302a300506032b656e032100", "hex"),
};
const PKCS8_PREFIX: Record<Curve, Buffer> = {
	ed25519: Buffer.from("302e020100300506032b657004220420", "hex"),
	x25519: Buffer.from("302e020100300506032b656e04220420", "hex"),
};

const HKDF_INFO = Buffer.from("switchboard-seal-v1");

function rawPubToKey(raw: Buffer, curve: Curve): crypto.KeyObject {
	return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX[curve], raw]), format: "der", type: "spki" });
}

function rawPrivToKey(raw: Buffer, curve: Curve): crypto.KeyObject {
	return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX[curve], raw]), format: "der", type: "pkcs8" });
}

function keyToRawPub(key: crypto.KeyObject): Buffer {
	return key.export({ type: "spki", format: "der" }).subarray(-32);
}

function keyToRawPriv(key: crypto.KeyObject): Buffer {
	return key.export({ type: "pkcs8", format: "der" }).subarray(-32);
}

function genPair(curve: Curve): KeyPairRaw {
	const { publicKey, privateKey } =
		curve === "ed25519" ? crypto.generateKeyPairSync("ed25519") : crypto.generateKeyPairSync("x25519");
	return { pub: keyToRawPub(publicKey).toString("base64"), priv: keyToRawPriv(privateKey).toString("base64") };
}

export function generateIdentity(): Identity {
	return { sign: genPair("ed25519"), box: genPair("x25519") };
}

export function sign(data: Buffer, signPrivB64: string): string {
	const key = rawPrivToKey(Buffer.from(signPrivB64, "base64"), "ed25519");
	return crypto.sign(null, data, key).toString("base64");
}

export function verify(data: Buffer, signatureB64: string, signPubB64: string): boolean {
	try {
		const key = rawPubToKey(Buffer.from(signPubB64, "base64"), "ed25519");
		return crypto.verify(null, data, key, Buffer.from(signatureB64, "base64"));
	} catch {
		return false;
	}
}

function deriveKey(shared: Buffer, ephemeralPub: Buffer): Buffer {
	// Ephemeral public key salts each message key.
	return Buffer.from(crypto.hkdfSync("sha256", shared, ephemeralPub, HKDF_INFO, 32));
}

export function seal(plaintext: Buffer, recipientBoxPubB64: string, senderSignPrivB64: string): SealedEnvelope {
	// Ephemeral ECDH binds envelope to recipient.
	const ephemeral = crypto.generateKeyPairSync("x25519");
	const ephemeralPubRaw = keyToRawPub(ephemeral.publicKey);
	const recipientPub = rawPubToKey(Buffer.from(recipientBoxPubB64, "base64"), "x25519");
	const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPub });
	const key = deriveKey(shared, ephemeralPubRaw);
	const nonce = crypto.randomBytes(CONTENT_NONCE_BYTES);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
	const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const sealed = Buffer.concat([ct, cipher.getAuthTag()]);
	const signed = Buffer.concat([ephemeralPubRaw, nonce, sealed]);
	return {
		ephemeralPub: ephemeralPubRaw.toString("base64"),
		nonce: nonce.toString("base64"),
		ciphertext: sealed.toString("base64"),
		signature: sign(signed, senderSignPrivB64),
	};
}

export function unseal(env: SealedEnvelope, recipientBoxPrivB64: string, senderSignPubB64: string): Buffer {
	// Verify sender before decrypting.
	const ephemeralPubRaw = decodeB64(env.ephemeralPub);
	const nonce = decodeB64(env.nonce);
	const sealed = decodeB64(env.ciphertext);
	decodeB64(env.signature);
	const signed = Buffer.concat([ephemeralPubRaw, nonce, sealed]);
	if (!verify(signed, env.signature, senderSignPubB64)) throw new Error("seal: bad signature");
	if (sealed.length < 16) throw new Error("seal: ciphertext too short");
	const ct = sealed.subarray(0, -16);
	const tag = sealed.subarray(-16);
	const recipientPriv = rawPrivToKey(decodeB64(recipientBoxPrivB64), "x25519");
	const shared = crypto.diffieHellman({
		privateKey: recipientPriv,
		publicKey: rawPubToKey(ephemeralPubRaw, "x25519"),
	});
	const key = deriveKey(shared, ephemeralPubRaw);
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function fingerprint(pubB64: string): string {
	const hash = crypto.createHash("sha256").update(Buffer.from(pubB64, "base64")).digest();
	const hex = hash.subarray(0, 8).toString("hex").toUpperCase();
	return (hex.match(/.{1,4}/g) ?? []).join("-");
}

export const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

// Signing fields reject newlines.
export const SealedEnvelopeSchema = z
	.object({
		ephemeralPub: b64Field(),
		nonce: b64Field(),
		ciphertext: b64Field(),
		signature: b64Field(),
	})
	.meta({ id: "SealedEnvelope" });

export type SealedEnvelope = z.infer<typeof SealedEnvelopeSchema>;

export function b64Field(): z.ZodString {
	return z.string().regex(B64_RE).min(1);
}

export function decodeB64(value: string): Buffer {
	if (value.length === 0 || !B64_RE.test(value)) throw new Error("invalid base64 field");
	return Buffer.from(value, "base64");
}

export function slugField(): z.ZodString {
	return z
		.string()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		.max(64);
}

export function displayField(max: number): z.ZodString {
	return z
		.string()
		.min(1)
		.max(max)
		.regex(/^[^\n\r]+$/);
}
