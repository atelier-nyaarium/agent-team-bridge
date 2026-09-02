import crypto from "node:crypto";
import { z } from "zod";

////////////////////////////////
//  Federation crypto (node:crypto only - no third-party dependency)
//
//  Identity = an Ed25519 signing keypair + an X25519 box keypair. The wire carries
//  RAW 32-byte keys (base64), the same encoding Android's BouncyCastle uses, so the
//  two platforms interop. Local storage uses PKCS8/SPKI DER.
//
//  Seal = a stateless per-message ephemeral box with a detached signature. An
//  ephemeral X25519 keypair does ECDH to the recipient's static box key, then
//  HKDF-SHA256 -> AES-256-GCM, and the sealed blob is signed by the sender's static
//  Ed25519 identity. Forward secrecy comes from the ephemeral (its private half is
//  discarded after sealing), authenticity from the signature, recipient-binding from
//  the ECDH to the recipient's static key. The Router routes the sealed blob content-blind.

////////////////////////////////
//  Interfaces & Types

/** A keypair on the wire: raw 32-byte keys, base64. */
export interface KeyPairRaw {
	pub: string;
	priv: string;
}

/** A node-local identity: an Ed25519 signing pair + an X25519 box pair. The
 * public halves are shared (allowlist, admissions); the private halves persist
 * to the owner's volume / Keystore. */
export interface Identity {
	sign: KeyPairRaw;
	box: KeyPairRaw;
}

////////////////////////////////
//  Functions & Helpers

type Curve = "ed25519" | "x25519";

// Fixed DER prefixes for the two fixed-length curves; raw <-> KeyObject is then a
// prefix concat / tail slice, avoiding the JWK x/d round-trip.
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
	// Literal arg per call so the per-algorithm overload resolves (a Curve union
	// matches none of them).
	const { publicKey, privateKey } =
		curve === "ed25519" ? crypto.generateKeyPairSync("ed25519") : crypto.generateKeyPairSync("x25519");
	return { pub: keyToRawPub(publicKey).toString("base64"), priv: keyToRawPriv(privateKey).toString("base64") };
}

/** Mint a fresh identity (Ed25519 signing + X25519 box). */
export function generateIdentity(): Identity {
	return { sign: genPair("ed25519"), box: genPair("x25519") };
}

/** Sign data with a raw Ed25519 private key; returns a base64 signature. */
export function sign(data: Buffer, signPrivB64: string): string {
	const key = rawPrivToKey(Buffer.from(signPrivB64, "base64"), "ed25519");
	return crypto.sign(null, data, key).toString("base64");
}

/** Verify an Ed25519 signature (base64) over data against a raw public key. */
export function verify(data: Buffer, signatureB64: string, signPubB64: string): boolean {
	try {
		const key = rawPubToKey(Buffer.from(signPubB64, "base64"), "ed25519");
		return crypto.verify(null, data, key, Buffer.from(signatureB64, "base64"));
	} catch {
		return false;
	}
}

function deriveKey(shared: Buffer, ephemeralPub: Buffer): Buffer {
	// salt = ephemeral public (binds the key to this message's ephemeral).
	return Buffer.from(crypto.hkdfSync("sha256", shared, ephemeralPub, HKDF_INFO, 32));
}

/** Seal plaintext to a recipient's raw X25519 box public key, signed by the
 * sender's raw Ed25519 private key. */
export function seal(plaintext: Buffer, recipientBoxPubB64: string, senderSignPrivB64: string): SealedEnvelope {
	const ephemeral = crypto.generateKeyPairSync("x25519");
	const ephemeralPubRaw = keyToRawPub(ephemeral.publicKey);
	const recipientPub = rawPubToKey(Buffer.from(recipientBoxPubB64, "base64"), "x25519");
	const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPub });
	const key = deriveKey(shared, ephemeralPubRaw);
	const nonce = crypto.randomBytes(12);
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

/** Open a sealed envelope: verify the sender's signature (against the EXPECTED
 * sender raw Ed25519 public key the caller resolved from the allowlist), then
 * decrypt with the recipient's raw X25519 private key. Throws on tamper / wrong
 * sender / wrong recipient. */
export function unseal(env: SealedEnvelope, recipientBoxPrivB64: string, senderSignPubB64: string): Buffer {
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

/** A short, human-comparable fingerprint of a raw public key (base64), for the
 * enrollment SAS and key identification. SHA-256, first 8 bytes, grouped hex. */
export function fingerprint(pubB64: string): string {
	const hash = crypto.createHash("sha256").update(Buffer.from(pubB64, "base64")).digest();
	const hex = hash.subarray(0, 8).toString("hex").toUpperCase();
	return (hex.match(/.{1,4}/g) ?? []).join("-");
}

////////////////////////////////
//  Signing-safe field constraints
//
//  The signing-bytes preimages join their fields with "\n" in a fixed order, so a
//  newline inside any field would shift the boundary between two fields and make
//  the encoding ambiguous (one value's tail could read as the next value's head).
//  These factories pin the CHARSET of a field so it can never carry that newline,
//  enforcing the no-ambiguous-preimage invariant at the schema boundary - the
//  verifier always reads from the parsed object, never by re-splitting the preimage.

/** A base64 field (raw key / nonce / signature): the base64 alphabet only, so it
 * holds no newline that could blur a signing-bytes boundary. */
export const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

/** Sealed envelope schema. */
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

/** A slug field (an opaque id like a domainId): lowercase alphanumeric segments joined
 * by single dashes, bounded length, holding no boundary-blurring newline. The regex matches
 * sanitizeDomainId's canonical output (no leading/trailing or doubled dashes), so a value
 * that passes here always survives sanitizeDomainId unchanged - a pure-separator id like
 * "---" cannot slip past validation only to throw at sanitize. */
export function slugField(): z.ZodString {
	return z
		.string()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		.max(64);
}

/** A free-text display label bounded only in length and the no-newline rule. Under the
 * cooperative threat model the label carries no trust weight; this only keeps the
 * signing-bytes preimage unambiguous. */
export function displayField(max: number): z.ZodString {
	return z
		.string()
		.min(1)
		.max(max)
		.regex(/^[^\n\r]+$/);
}
