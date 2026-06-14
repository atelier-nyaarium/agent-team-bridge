import { describe, expect, it } from "vitest";
import { fingerprint, generateIdentity, seal, sign, unseal, verify } from "../shared/crypto.js";

describe("federation crypto", () => {
	it("generates an identity with raw 32-byte keys", () => {
		const id = generateIdentity();
		for (const raw of [id.sign.pub, id.sign.priv, id.box.pub, id.box.priv]) {
			expect(Buffer.from(raw, "base64")).toHaveLength(32);
		}
	});

	it("signs and verifies, and rejects a wrong key or tampered data", () => {
		const id = generateIdentity();
		const other = generateIdentity();
		const data = Buffer.from("admit host laptop");
		const sig = sign(data, id.sign.priv);
		expect(verify(data, sig, id.sign.pub)).toBe(true);
		expect(verify(data, sig, other.sign.pub)).toBe(false);
		expect(verify(Buffer.from("admit host desktop"), sig, id.sign.pub)).toBe(false);
	});

	it("seals and unseals a round trip", () => {
		const sender = generateIdentity();
		const recipient = generateIdentity();
		const msg = Buffer.from(JSON.stringify({ kind: "send", body: "status?" }));
		const env = seal(msg, recipient.box.pub, sender.sign.priv);
		const opened = unseal(env, recipient.box.priv, sender.sign.pub);
		expect(opened.toString()).toBe(msg.toString());
	});

	it("rejects a forged sender signature", () => {
		const sender = generateIdentity();
		const attacker = generateIdentity();
		const recipient = generateIdentity();
		const env = seal(Buffer.from("hi"), recipient.box.pub, attacker.sign.priv);
		// Recipient expects the real sender's key; the attacker signed it.
		expect(() => unseal(env, recipient.box.priv, sender.sign.pub)).toThrow(/bad signature/);
	});

	it("rejects a tampered ciphertext", () => {
		const sender = generateIdentity();
		const recipient = generateIdentity();
		const env = seal(Buffer.from("transfer 100"), recipient.box.pub, sender.sign.priv);
		const bytes = Buffer.from(env.ciphertext, "base64");
		bytes[0] ^= 0xff;
		// Tampering invalidates the signature first (it covers the ciphertext).
		const tampered = { ...env, ciphertext: bytes.toString("base64") };
		expect(() => unseal(tampered, recipient.box.priv, sender.sign.pub)).toThrow();
	});

	it("rejects the wrong recipient (decrypt fails even with a valid signature)", () => {
		const sender = generateIdentity();
		const recipient = generateIdentity();
		const wrong = generateIdentity();
		const env = seal(Buffer.from("secret"), recipient.box.pub, sender.sign.priv);
		// Signature verifies (sender is right) but the ECDH yields the wrong key.
		expect(() => unseal(env, wrong.box.priv, sender.sign.pub)).toThrow();
	});

	it("uses a fresh ephemeral per message (forward secrecy)", () => {
		const sender = generateIdentity();
		const recipient = generateIdentity();
		const a = seal(Buffer.from("same"), recipient.box.pub, sender.sign.priv);
		const b = seal(Buffer.from("same"), recipient.box.pub, sender.sign.priv);
		expect(a.ephemeralPub).not.toBe(b.ephemeralPub);
		expect(a.ciphertext).not.toBe(b.ciphertext);
		// Both still open to the same plaintext.
		expect(unseal(a, recipient.box.priv, sender.sign.pub).toString()).toBe("same");
		expect(unseal(b, recipient.box.priv, sender.sign.pub).toString()).toBe("same");
	});

	it("fingerprints deterministically and distinctly", () => {
		const id = generateIdentity();
		const other = generateIdentity();
		expect(fingerprint(id.sign.pub)).toBe(fingerprint(id.sign.pub));
		expect(fingerprint(id.sign.pub)).not.toBe(fingerprint(other.sign.pub));
		expect(fingerprint(id.sign.pub)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
	});
});
