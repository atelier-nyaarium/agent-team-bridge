import crypto from "node:crypto";

////////////////////////////////
//  Federation crypto (node:crypto only - no third-party dependency)
//
//  Identity = an Ed25519 signing keypair (authentication, admissions) + an
//  X25519 box keypair (encryption). The wire carries RAW 32-byte keys (base64),
//  the same encoding Android's BouncyCastle uses, so the two platforms interop.
//  Local storage uses PKCS8/SPKI DER (only the owner of a key reads it).
//
//  Seal = a stateless per-message ephemeral box with a detached signature (the
//  proportionate forward-secrecy fit per Owner decision D1, not a stateful
//  ratchet): an ephemeral X25519 keypair does ECDH to the recipient's STATIC box
//  key -> HKDF-SHA256 -> AES-256-GCM, and the whole sealed blob is signed by
//  the sender's STATIC Ed25519 identity. Forward secrecy comes from the ephemeral
//  (its private half is discarded after sealing); authenticity from the signature;
//  recipient-binding from the ECDH to the recipient's static key. evie never seals
//  or unseals - it routes the sealed blob opaquely (content-blind).

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

/** The sealed envelope: confidentiality (ephemeral box) + authenticity (sig). */
export interface SealedEnvelope {
	/** Ephemeral X25519 public key for this message (raw 32 bytes, base64). */
	ephemeralPub: string;
	/** AES-256-GCM nonce / IV (12 bytes, base64). */
	nonce: string;
	/** Ciphertext || 16-byte auth tag (base64). */
	ciphertext: string;
	/** Ed25519 signature over ephemeralPub||nonce||ciphertext (base64). */
	signature: string;
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
	const ephemeralPubRaw = Buffer.from(env.ephemeralPub, "base64");
	const nonce = Buffer.from(env.nonce, "base64");
	const sealed = Buffer.from(env.ciphertext, "base64");
	const signed = Buffer.concat([ephemeralPubRaw, nonce, sealed]);
	if (!verify(signed, env.signature, senderSignPubB64)) throw new Error("seal: bad signature");
	if (sealed.length < 16) throw new Error("seal: ciphertext too short");
	const ct = sealed.subarray(0, -16);
	const tag = sealed.subarray(-16);
	const recipientPriv = rawPrivToKey(Buffer.from(recipientBoxPrivB64, "base64"), "x25519");
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
