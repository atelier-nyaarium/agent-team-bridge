import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type EnrollParty,
	type EnrollRole,
	enrollCommitment,
	enrollCommitmentPreimage,
	enrollSas,
	enrollSasPreimage,
	verifyEnrollCommitment,
} from "../shared/cross-domain-sas.js";

////////////////////////////////
//  Owner-anchored role-tagged enroll SAS vectors
//
//  vectors.json is read by BOTH this suite and (in the Android pass) SasCryptoTest.kt, so
//  the hand-authored Kotlin twin cannot drift from this TS source. Unlike the gateway SAS,
//  the enroll preimage is FIXED-SLOT / role-tagged: it is NOT order-independent, and a
//  field-role swap changes the code (the injective property the red-team required).

interface EnrollCase {
	admin: EnrollParty;
	enrollee: EnrollParty;
	pin: string;
	sas: string;
}

const vectors = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/enroll-sas/vectors.json"), "utf8"),
) as {
	cases: EnrollCase[];
	roleSwap: EnrollCase & { differsFrom: string };
	fieldReassign: EnrollCase & { differsFrom: string };
	substitution: EnrollCase & { differsFrom: string };
	commitment: { party: EnrollParty; role: EnrollRole; salt: string; commitment: string };
	commitmentRoleBinding: {
		party: EnrollParty;
		role: EnrollRole;
		salt: string;
		commitment: string;
		differsFrom: string;
	};
	commitmentSaltBinding: {
		party: EnrollParty;
		role: EnrollRole;
		salt: string;
		commitment: string;
		differsFrom: string;
	};
	handComputed: EnrollCase & {
		role: EnrollRole;
		salt: string;
		sasPreimage: string;
		commitmentPreimage: string;
		commitment: string;
	};
};

describe("enroll SAS vectors", () => {
	it.each(vectors.cases.map((c, i) => [i, c] as const))("enrollSas reproduces case %i", (_, c) => {
		expect(enrollSas(c.admin, c.enrollee, c.pin)).toBe(c.sas);
		// Width is fixed at 6 digits so the two phones compare equal-length strings.
		expect(c.sas).toMatch(/^\d{6}$/);
	});

	it("is role-FIXED (swapping ADMIN and ENROLLEE yields a different code, NOT order-independent)", () => {
		const { admin, enrollee, pin, sas, differsFrom } = vectors.roleSwap;
		expect(enrollSas(admin, enrollee, pin)).toBe(sas);
		expect(sas).not.toBe(differsFrom);
		expect(differsFrom).toBe(vectors.cases[0].sas);
	});

	it("is injective under field-role reassignment (ownerSignPub<->ownerBoxPub swap changes the code)", () => {
		const { admin, enrollee, pin, sas, differsFrom } = vectors.fieldReassign;
		expect(enrollSas(admin, enrollee, pin)).toBe(sas);
		expect(sas).not.toBe(differsFrom);
		expect(differsFrom).toBe(vectors.cases[0].sas);
	});

	it("changes when a committed enrollee key is substituted (the residual MITM detector)", () => {
		const { admin, enrollee, pin, sas, differsFrom } = vectors.substitution;
		expect(enrollSas(admin, enrollee, pin)).toBe(sas);
		expect(sas).not.toBe(differsFrom);
		expect(differsFrom).toBe(vectors.cases[0].sas);
	});

	it("changes when only the pin differs (the OOB shared secret binds the code)", () => {
		const { admin, enrollee, pin } = vectors.cases[0];
		expect(enrollSas(admin, enrollee, `${pin}-x`)).not.toBe(enrollSas(admin, enrollee, pin));
	});

	it("changes when only a domainId differs (Domain binding, closes the confirm->sign edge gap)", () => {
		const { admin, enrollee, pin } = vectors.cases[0];
		const relabeled = { ...enrollee, domainId: `${enrollee.domainId}-x` };
		expect(enrollSas(admin, relabeled, pin)).not.toBe(enrollSas(admin, enrollee, pin));
	});

	it("builds exactly the documented ENROLL_SAS_V1 fixed-slot preimage", () => {
		const { admin, enrollee, pin, sasPreimage, sas } = vectors.handComputed;
		expect(enrollSasPreimage(admin, enrollee, pin).toString("utf8")).toBe(sasPreimage);
		// The documented derivation recomputes the digits independently of the helper:
		// first 8 digest bytes as a big-endian BigInt mod 10^6, zero-padded to 6.
		const digest = crypto.createHash("sha256").update(Buffer.from(sasPreimage, "utf8")).digest();
		let n = 0n;
		for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(digest[i]);
		const expected = (n % 1_000_000n).toString(10).padStart(6, "0");
		expect(enrollSas(admin, enrollee, pin)).toBe(expected);
		expect(enrollSas(admin, enrollee, pin)).toBe(sas);
	});
});

describe("enroll commitment vectors", () => {
	it("reproduces the committed hash over a party + role + salt", () => {
		const { party, role, salt, commitment } = vectors.commitment;
		expect(enrollCommitment(party, role, salt)).toBe(commitment);
		expect(verifyEnrollCommitment(commitment, party, role, salt)).toBe(true);
	});

	it("the role is load-bearing (the same party+salt under a different role yields a different commitment)", () => {
		const { party, role, salt, commitment, differsFrom } = vectors.commitmentRoleBinding;
		expect(enrollCommitment(party, role, salt)).toBe(commitment);
		expect(commitment).not.toBe(differsFrom);
		expect(differsFrom).toBe(vectors.commitment.commitment);
	});

	it("the salt is load-bearing (a different salt yields a different commitment)", () => {
		const { party, role, salt, commitment, differsFrom } = vectors.commitmentSaltBinding;
		expect(enrollCommitment(party, role, salt)).toBe(commitment);
		expect(commitment).not.toBe(differsFrom);
		expect(differsFrom).toBe(vectors.commitment.commitment);
	});

	it("verifyEnrollCommitment rejects a substituted key, a wrong role, and a wrong salt", () => {
		const { party, role, salt, commitment } = vectors.commitment;
		expect(
			verifyEnrollCommitment(commitment, { ...party, ownerBoxPub: `${party.ownerBoxPub}-x` }, role, salt),
		).toBe(false);
		expect(verifyEnrollCommitment(commitment, party, "ENROLLEE", salt)).toBe(false);
		expect(verifyEnrollCommitment(commitment, party, role, `${salt}-wrong`)).toBe(false);
	});

	it("builds exactly the documented ENROLL_COMMIT_V1 preimage (role-tagged fixed order)", () => {
		const { admin, role, salt, commitmentPreimage, commitment } = vectors.handComputed;
		expect(enrollCommitmentPreimage(admin, role, salt).toString("utf8")).toBe(commitmentPreimage);
		const digest = crypto.createHash("sha256").update(Buffer.from(commitmentPreimage, "utf8")).digest("base64");
		expect(digest).toBe(commitment);
		expect(enrollCommitment(admin, role, salt)).toBe(commitment);
	});
});
