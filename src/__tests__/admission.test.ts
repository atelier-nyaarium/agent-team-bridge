import { describe, expect, it } from "vitest";
import {
	type Admission,
	resolveAdmitted,
	signAdmission,
	signRevocation,
	verifyAdmission,
} from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";

const owner = generateIdentity();
const host = generateIdentity();

function admission(over: Partial<Admission> = {}): Admission {
	return {
		kind: "host",
		signPub: host.sign.pub,
		boxPub: host.box.pub,
		hostId: "laptop",
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

	it("rejects a tampered admission (e.g. swapped hostId)", () => {
		const s = signAdmission(admission(), owner.sign.priv, owner.sign.pub);
		const tampered = { ...s, admission: { ...s.admission, hostId: "evil" } };
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
		expect(got?.hostId).toBe("laptop");
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
