import { describe, expect, it } from "vitest";
import { resolveAdmitted, signAdmission, verifyAdmission } from "../shared/admission.js";
import { fingerprint, generateIdentity } from "../shared/crypto.js";
import {
	admissionFromScan,
	EnrollmentPayloadSchema,
	EnrollOpSchema,
	payloadSas,
	signXDomainLinkEdge,
	signXDomainLinkRevocation,
	verifyXDomainLinkEdge,
	verifyXDomainLinkRevocation,
	type XDomainLinkEdge,
	type XDomainLinkRevocation,
} from "../shared/federation-lifecycle.js";

const owner = generateIdentity();
const host = generateIdentity();

describe("enrollment", () => {
	it("parses each enrollment payload type and rejects an unknown one", () => {
		expect(
			EnrollmentPayloadSchema.safeParse({ type: "admit-gateway", gatewayId: "laptop", signPub: "a", boxPub: "b" })
				.success,
		).toBe(true);
		expect(
			EnrollmentPayloadSchema.safeParse({
				type: "enroll-owner",
				domainId: "d",
				evieAddr: "https://evie",
				evieSignPub: "s",
				evieBoxPub: "b",
				nonce: "n",
			}).success,
		).toBe(true);
		expect(EnrollmentPayloadSchema.safeParse({ type: "nope" }).success).toBe(false);
	});

	it("derives the SAS from the confirmed signing key", () => {
		const payload = {
			type: "admit-gateway" as const,
			gatewayId: "laptop",
			signPub: host.sign.pub,
			boxPub: host.box.pub,
		};
		expect(payloadSas(payload)).toBe(fingerprint(host.sign.pub));
	});

	it("admits a scanned Gateway into the allowlist", () => {
		const payload = {
			type: "admit-gateway" as const,
			gatewayId: "laptop",
			signPub: host.sign.pub,
			boxPub: host.box.pub,
		};
		const signed = admissionFromScan(payload, owner.sign.priv, owner.sign.pub, 1000, "bg==");
		expect(verifyAdmission(signed, owner.sign.pub)).toBe(true);
		const got = resolveAdmitted([signed], [], owner.sign.pub, host.sign.pub);
		expect(got).toMatchObject({ kind: "gateway", gatewayId: "laptop", boxPub: host.box.pub });
	});

	it("parses each enroll op and rejects an unfilled redeem", () => {
		expect(
			EnrollOpSchema.safeParse({ kind: "enroll_redeem", nonce: "n", ownerSignPub: "s", ownerBoxPub: "b" })
				.success,
		).toBe(true);
		const signed = signAdmission(
			{
				kind: "gateway",
				signPub: host.sign.pub,
				boxPub: host.box.pub,
				gatewayId: "laptop",
				issuedAt: 1,
				nonce: "bg==",
			},
			owner.sign.priv,
			owner.sign.pub,
		);
		expect(EnrollOpSchema.safeParse({ kind: "submit_admission", admission: signed }).success).toBe(true);
		// Missing the owner keys: a redeem without them cannot root the Domain.
		expect(EnrollOpSchema.safeParse({ kind: "enroll_redeem", nonce: "n" }).success).toBe(false);
	});

	it("admits a scanned console with kind console (no gatewayId)", () => {
		const device = generateIdentity();
		const payload = {
			type: "authorize-console" as const,
			domainId: "d",
			signPub: device.sign.pub,
			boxPub: device.box.pub,
		};
		const signed = admissionFromScan(payload, owner.sign.priv, owner.sign.pub, 2000, "cg==");
		expect(signed.admission.kind).toBe("console");
		expect(signed.admission.gatewayId).toBeUndefined();
		expect(resolveAdmitted([signed], [], owner.sign.pub, device.sign.pub)?.kind).toBe("console");
	});
});

describe("cross-Domain link edge", () => {
	const edge: XDomainLinkEdge = { srcDomainId: "alice", dstDomainId: "carol", issuedAt: 1000, nonce: "bm9uY2U=" };

	it("owner-signs and verifies a link edge under the owner key", () => {
		const signed = signXDomainLinkEdge(edge, owner.sign.priv, owner.sign.pub);
		expect(verifyXDomainLinkEdge(signed, owner.sign.pub)).toBe(true);
	});

	it("rejects a link edge under a different owner key", () => {
		const attacker = generateIdentity();
		const signed = signXDomainLinkEdge(edge, owner.sign.priv, owner.sign.pub);
		expect(verifyXDomainLinkEdge(signed, attacker.sign.pub)).toBe(false);
	});

	it("rejects a tampered Domain id (the signature covers both ids)", () => {
		const signed = signXDomainLinkEdge(edge, owner.sign.priv, owner.sign.pub);
		const tampered = { ...signed, edge: { ...signed.edge, dstDomainId: "mallory" } };
		expect(verifyXDomainLinkEdge(tampered, owner.sign.pub)).toBe(false);
	});

	it("rejects a claimed ownerSignPub that disagrees with the verifier key", () => {
		const attacker = generateIdentity();
		// Signed by the real owner but the artifact claims the attacker's key: the claimed
		// key must equal the verifier key, so this fails before the signature even checks.
		const signed = signXDomainLinkEdge(edge, owner.sign.priv, owner.sign.pub);
		const relabeled = { ...signed, ownerSignPub: attacker.sign.pub };
		expect(verifyXDomainLinkEdge(relabeled, attacker.sign.pub)).toBe(false);
	});

	it("parses a submit_xdomain_link enroll op and rejects a non-slug Domain id", () => {
		const signed = signXDomainLinkEdge(edge, owner.sign.priv, owner.sign.pub);
		expect(EnrollOpSchema.safeParse({ kind: "submit_xdomain_link", edge: signed }).success).toBe(true);
		// Domain ids are slug-constrained so the signing bytes stay unambiguous.
		const badSlug = signXDomainLinkEdge(
			{ ...edge, srcDomainId: "Has Spaces" } as XDomainLinkEdge,
			owner.sign.priv,
			owner.sign.pub,
		);
		expect(EnrollOpSchema.safeParse({ kind: "submit_xdomain_link", edge: badSlug }).success).toBe(false);
	});
});

describe("cross-Domain link-edge revocation", () => {
	const revocation: XDomainLinkRevocation = {
		srcDomainId: "alice",
		dstDomainId: "carol",
		revokedAt: 2000,
		nonce: "cmV2b2tl",
	};

	it("owner-signs and verifies a revocation under the owner key", () => {
		const signed = signXDomainLinkRevocation(revocation, owner.sign.priv, owner.sign.pub);
		expect(verifyXDomainLinkRevocation(signed, owner.sign.pub)).toBe(true);
	});

	it("rejects a revocation under a different owner key", () => {
		const attacker = generateIdentity();
		const signed = signXDomainLinkRevocation(revocation, owner.sign.priv, owner.sign.pub);
		expect(verifyXDomainLinkRevocation(signed, attacker.sign.pub)).toBe(false);
	});

	it("rejects a revocation signed by a non-owner", () => {
		const attacker = generateIdentity();
		// Signed by the attacker but verified under the real owner key: the signature fails.
		const forged = signXDomainLinkRevocation(revocation, attacker.sign.priv, owner.sign.pub);
		expect(verifyXDomainLinkRevocation(forged, owner.sign.pub)).toBe(false);
	});

	it("rejects a tampered Domain id (the signature covers both ids)", () => {
		const signed = signXDomainLinkRevocation(revocation, owner.sign.priv, owner.sign.pub);
		const tampered = { ...signed, revocation: { ...signed.revocation, dstDomainId: "mallory" } };
		expect(verifyXDomainLinkRevocation(tampered, owner.sign.pub)).toBe(false);
	});

	it("rejects a claimed ownerSignPub that disagrees with the verifier key", () => {
		const attacker = generateIdentity();
		// Signed by the real owner but the artifact claims the attacker's key: the claimed
		// key must equal the verifier key, so this fails before the signature even checks.
		const signed = signXDomainLinkRevocation(revocation, owner.sign.priv, owner.sign.pub);
		const relabeled = { ...signed, ownerSignPub: attacker.sign.pub };
		expect(verifyXDomainLinkRevocation(relabeled, attacker.sign.pub)).toBe(false);
	});

	it("does not verify a link-edge signature as a revocation (distinct versioned prefix)", () => {
		// A captured edge signature must not be replayable as a revocation: the signing-bytes
		// prefix differs, so an edge artifact reshaped into the revocation envelope fails.
		const edgeSigned = signXDomainLinkEdge(
			{ srcDomainId: "alice", dstDomainId: "carol", issuedAt: 2000, nonce: "cmV2b2tl" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const reshaped = {
			revocation: { srcDomainId: "alice", dstDomainId: "carol", revokedAt: 2000, nonce: "cmV2b2tl" },
			ownerSignPub: edgeSigned.ownerSignPub,
			signature: edgeSigned.signature,
		};
		expect(verifyXDomainLinkRevocation(reshaped, owner.sign.pub)).toBe(false);
	});

	it("parses a revoke_xdomain_link enroll op and rejects a non-slug Domain id", () => {
		const signed = signXDomainLinkRevocation(revocation, owner.sign.priv, owner.sign.pub);
		expect(EnrollOpSchema.safeParse({ kind: "revoke_xdomain_link", revocation: signed }).success).toBe(true);
		// Domain ids are slug-constrained so the signing bytes stay unambiguous.
		const badSlug = signXDomainLinkRevocation(
			{ ...revocation, srcDomainId: "Has Spaces" } as XDomainLinkRevocation,
			owner.sign.priv,
			owner.sign.pub,
		);
		expect(EnrollOpSchema.safeParse({ kind: "revoke_xdomain_link", revocation: badSlug }).success).toBe(false);
	});
});
