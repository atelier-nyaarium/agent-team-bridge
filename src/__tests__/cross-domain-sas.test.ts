import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CrossDomainParty,
	crossDomainCommitment,
	crossDomainCommitmentPreimage,
	crossDomainSas,
	crossDomainSasPreimage,
	verifyCrossDomainCommitment,
} from "../shared/cross-domain-sas.js";

////////////////////////////////
//  Cross-Domain commit-reveal SAS vectors
//
//  vectors.json is read by BOTH this suite and (in the Phase F Android pass)
//  SasCryptoTest.kt, so the hand-authored Kotlin twin (SasCrypto.kt) cannot drift
//  from this TS source: a SAS or commitment either runtime derives differently fails
//  one of the two suites. Until then, this suite alone pins the canonical TS reference.

interface SasCase {
	a: CrossDomainParty;
	b: CrossDomainParty;
	pin: string;
	sas: string;
}

const vectors = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/cross-domain-sas/vectors.json"), "utf8"),
) as {
	cases: SasCase[];
	orderIndependent: SasCase & { equalsCase: number };
	substitution: SasCase & { differsFrom: string };
	commitment: { a: CrossDomainParty; salt: string; commitment: string };
	commitmentSaltBinding: { a: CrossDomainParty; salt: string; commitment: string; differsFrom: string };
	handComputed: SasCase & {
		salt: string;
		sasPreimage: string;
		commitmentPreimage: string;
		commitment: string;
	};
};

describe("cross-domain SAS vectors", () => {
	it.each(vectors.cases.map((c, i) => [i, c] as const))("crossDomainSas reproduces case %i", (_, c) => {
		expect(crossDomainSas(c.a, c.b, c.pin)).toBe(c.sas);
		// Width is fixed at 12 digits so the two phones compare equal-length strings.
		expect(c.sas).toMatch(/^\d{12}$/);
	});

	it("is order-independent (swapping the two parties yields the first case's SAS)", () => {
		const { a, b, pin, sas, equalsCase } = vectors.orderIndependent;
		expect(crossDomainSas(a, b, pin)).toBe(sas);
		expect(sas).toBe(vectors.cases[equalsCase].sas);
		// Direct: the same pair in either order derives the same code.
		expect(crossDomainSas(a, b, pin)).toBe(crossDomainSas(b, a, pin));
	});

	it("changes when a single committed key is substituted (the residual MITM detector)", () => {
		const { a, b, pin, sas, differsFrom } = vectors.substitution;
		expect(crossDomainSas(a, b, pin)).toBe(sas);
		expect(sas).not.toBe(differsFrom);
		expect(differsFrom).toBe(vectors.cases[0].sas);
	});

	it("changes when only the pin differs (same parties, different pin)", () => {
		const { a, b, pin } = vectors.cases[0];
		expect(crossDomainSas(a, b, `${pin}-x`)).not.toBe(crossDomainSas(a, b, pin));
	});

	it("changes when only an id (domainId/gatewayId) differs (id binding)", () => {
		const { a, b, pin } = vectors.cases[0];
		const relabeled = { ...b, domainId: `${b.domainId}-x` };
		expect(crossDomainSas(a, relabeled, pin)).not.toBe(crossDomainSas(a, b, pin));
	});

	it("builds exactly the documented SAS_V1 preimage (ten fields sorted, newline-joined)", () => {
		const { a, b, pin, sasPreimage, sas } = vectors.handComputed;
		expect(crossDomainSasPreimage(a, b, pin).toString("utf8")).toBe(sasPreimage);
		// The documented derivation recomputes the digits independently of the helper:
		// first 8 digest bytes as a big-endian BigInt mod 10^12, zero-padded to 12.
		const digest = crypto.createHash("sha256").update(Buffer.from(sasPreimage, "utf8")).digest();
		let n = 0n;
		for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(digest[i]);
		const expected = (n % 1_000_000_000_000n).toString(10).padStart(12, "0");
		expect(crossDomainSas(a, b, pin)).toBe(expected);
		expect(crossDomainSas(a, b, pin)).toBe(sas);
	});
});

describe("cross-domain commitment vectors", () => {
	it("reproduces the committed hash over a party + salt", () => {
		const { a, salt, commitment } = vectors.commitment;
		expect(crossDomainCommitment(a, salt)).toBe(commitment);
		expect(verifyCrossDomainCommitment(commitment, a, salt)).toBe(true);
	});

	it("the salt is load-bearing (a different salt yields a different commitment)", () => {
		const { a, salt, commitment, differsFrom } = vectors.commitmentSaltBinding;
		expect(crossDomainCommitment(a, salt)).toBe(commitment);
		expect(commitment).not.toBe(differsFrom);
		expect(differsFrom).toBe(vectors.commitment.commitment);
	});

	it("verifyCrossDomainCommitment rejects a substituted key (the commit-reveal binding)", () => {
		const { a, salt, commitment } = vectors.commitment;
		const tampered = { ...a, gatewayBoxPub: `${a.gatewayBoxPub}-tampered` };
		expect(verifyCrossDomainCommitment(commitment, tampered, salt)).toBe(false);
	});

	it("verifyCrossDomainCommitment rejects a wrong salt", () => {
		const { a, salt, commitment } = vectors.commitment;
		expect(verifyCrossDomainCommitment(commitment, a, `${salt}-wrong`)).toBe(false);
	});

	it("builds exactly the documented SAS_COMMIT_V1 preimage (fixed field order)", () => {
		const { a, salt, commitmentPreimage, commitment } = vectors.handComputed;
		expect(crossDomainCommitmentPreimage(a, salt).toString("utf8")).toBe(commitmentPreimage);
		const digest = crypto.createHash("sha256").update(Buffer.from(commitmentPreimage, "utf8")).digest("base64");
		expect(digest).toBe(commitment);
		expect(crossDomainCommitment(a, salt)).toBe(commitment);
	});
});
