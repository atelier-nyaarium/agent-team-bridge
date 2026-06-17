import { describe, expect, it } from "vitest";
import {
	type Admission,
	REGISTER_MAX_SKEW_MS,
	resolveAdmitted,
	signAdmission,
	signRegister,
	signRevocation,
	verifyAdmission,
	verifyRegistration,
} from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";

const owner = generateIdentity();
const host = generateIdentity();

function admission(over: Partial<Admission> = {}): Admission {
	return {
		kind: "switch",
		signPub: host.sign.pub,
		boxPub: host.box.pub,
		switchId: "laptop",
		issuedAt: 1000,
		nonce: "bm9uY2Ux",
		...over,
	};
}

describe("domain admission", () => {
	it("owner-signs and verifies an admission", () => {
		const s = signAdmission(admission(), owner.sign.priv, owner.sign.pub);
		expect(verifyAdmission(s, owner.sign.pub)).toBe(true);
	});

	it("rejects an admission signed by a non-owner", () => {
		const attacker = generateIdentity();
		const s = signAdmission(admission(), attacker.sign.priv, attacker.sign.pub);
		// Verifier expects the real owner; the attacker's claimed owner key mismatches.
		expect(verifyAdmission(s, owner.sign.pub)).toBe(false);
	});

	it("rejects a tampered admission (e.g. swapped switchId)", () => {
		const s = signAdmission(admission(), owner.sign.priv, owner.sign.pub);
		const tampered = { ...s, admission: { ...s.admission, switchId: "evil" } };
		expect(verifyAdmission(tampered, owner.sign.pub)).toBe(false);
	});

	it("rejects an admission whose claimed owner key was substituted", () => {
		const attacker = generateIdentity();
		const s = signAdmission(admission(), owner.sign.priv, owner.sign.pub);
		// Attacker swaps the ownerSignPub to their own; verifier expects the owner.
		const forged = { ...s, ownerSignPub: attacker.sign.pub };
		expect(verifyAdmission(forged, owner.sign.pub)).toBe(false);
	});

	it("resolves an admitted subject and returns its keys", () => {
		const list = [signAdmission(admission(), owner.sign.priv, owner.sign.pub)];
		const got = resolveAdmitted(list, [], owner.sign.pub, host.sign.pub);
		expect(got?.boxPub).toBe(host.box.pub);
		expect(got?.switchId).toBe("laptop");
	});

	it("returns null for an unknown subject", () => {
		const list = [signAdmission(admission(), owner.sign.priv, owner.sign.pub)];
		const stranger = generateIdentity();
		expect(resolveAdmitted(list, [], owner.sign.pub, stranger.sign.pub)).toBeNull();
	});

	it("honors a revocation issued at or after the admission", () => {
		const list = [signAdmission(admission({ issuedAt: 1000 }), owner.sign.priv, owner.sign.pub)];
		const revs = [
			signRevocation(
				{ signPub: host.sign.pub, issuedAt: 1000, nonce: "cmV2MQ==" },
				owner.sign.priv,
				owner.sign.pub,
			),
		];
		expect(resolveAdmitted(list, revs, owner.sign.pub, host.sign.pub)).toBeNull();
	});

	it("a re-admission newer than the revocation restores membership", () => {
		const list = [
			signAdmission(admission({ issuedAt: 1000 }), owner.sign.priv, owner.sign.pub),
			signAdmission(admission({ issuedAt: 3000, nonce: "bm9uY2Uy" }), owner.sign.priv, owner.sign.pub),
		];
		const revs = [
			signRevocation(
				{ signPub: host.sign.pub, issuedAt: 2000, nonce: "cmV2MQ==" },
				owner.sign.priv,
				owner.sign.pub,
			),
		];
		// The 3000 admission post-dates the 2000 revocation, so it stands.
		expect(resolveAdmitted(list, revs, owner.sign.pub, host.sign.pub)?.issuedAt).toBe(3000);
	});

	it("ignores a forged revocation (non-owner)", () => {
		const attacker = generateIdentity();
		const list = [signAdmission(admission(), owner.sign.priv, owner.sign.pub)];
		const revs = [
			signRevocation(
				{ signPub: host.sign.pub, issuedAt: 5000, nonce: "eA==" },
				attacker.sign.priv,
				attacker.sign.pub,
			),
		];
		// The attacker's revocation does not verify under the owner key.
		expect(resolveAdmitted(list, revs, owner.sign.pub, host.sign.pub)).not.toBeNull();
	});
});

describe("registration proof-of-possession", () => {
	const now = 1_000_000;
	function claim(over: Partial<{ proofAt: number; signPriv: string }> = {}) {
		const proofAt = over.proofAt ?? now;
		const nonce = "cHJvb2Y=";
		return {
			switchId: "laptop",
			signPub: host.sign.pub,
			boxPub: host.box.pub,
			admission: signAdmission(admission(), owner.sign.priv, owner.sign.pub),
			proof: signRegister("laptop", proofAt, nonce, over.signPriv ?? host.sign.priv),
			proofAt,
			nonce,
		};
	}

	it("accepts an admitted Switch that proves possession freshly", () => {
		expect(verifyRegistration(claim(), { ownerSignPub: owner.sign.pub, nowMs: now })).toBeNull();
	});

	it("rejects a registration whose admission is not owner-signed", () => {
		const attacker = generateIdentity();
		const c = { ...claim(), admission: signAdmission(admission(), attacker.sign.priv, attacker.sign.pub) };
		expect(verifyRegistration(c, { ownerSignPub: owner.sign.pub, nowMs: now })).toMatch(/not owner-signed/);
	});

	it("rejects a replayed admission without the matching private key", () => {
		// Attacker has the (public) admission but signs the proof with a different key.
		const attacker = generateIdentity();
		const c = claim({ signPriv: attacker.sign.priv });
		expect(verifyRegistration(c, { ownerSignPub: owner.sign.pub, nowMs: now })).toMatch(/proof invalid/);
	});

	it("rejects a stale proof outside the freshness window", () => {
		const c = claim({ proofAt: now - REGISTER_MAX_SKEW_MS - 1 });
		expect(verifyRegistration(c, { ownerSignPub: owner.sign.pub, nowMs: now })).toMatch(/stale/);
	});

	it("rejects an admission that grants a different switchId", () => {
		const c = { ...claim(), switchId: "desktop" };
		// The proof is over "desktop" but the admission binds "laptop".
		const proof = signRegister("desktop", now, c.nonce, host.sign.priv);
		expect(verifyRegistration({ ...c, proof }, { ownerSignPub: owner.sign.pub, nowMs: now })).toMatch(
			/switchId does not match/,
		);
	});

	it("rejects a registration presenting a different boxPub than the admission", () => {
		const stranger = generateIdentity();
		const c = { ...claim(), boxPub: stranger.box.pub };
		expect(verifyRegistration(c, { ownerSignPub: owner.sign.pub, nowMs: now })).toMatch(/boxPub does not match/);
	});

	it("rejects a proof whose nonce was swapped (signature no longer matches)", () => {
		const c = { ...claim(), nonce: "ZGlmZmVyZW50" };
		// The proof was signed over the original nonce; a swapped nonce fails.
		expect(verifyRegistration(c, { ownerSignPub: owner.sign.pub, nowMs: now })).toMatch(/proof invalid/);
	});

	it("rejects once the admitted key is revoked", () => {
		const revs = [
			signRevocation({ signPub: host.sign.pub, issuedAt: 9999, nonce: "cmV2" }, owner.sign.priv, owner.sign.pub),
		];
		expect(verifyRegistration(claim(), { ownerSignPub: owner.sign.pub, nowMs: now, revocations: revs })).toMatch(
			/revoked/,
		);
	});
});
