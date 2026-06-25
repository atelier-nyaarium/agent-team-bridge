import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprint, generateIdentity, verify } from "../shared/crypto.js";
import {
	EnrollOpSchema,
	type FirstRoot,
	firstRootSigningBytes,
	type ProvisionTenant,
	provisionTenantSigningBytes,
	type RemoveTenant,
	removeTenantSigningBytes,
	rosterRequestSigningBytes,
	type SetProfileName,
	setProfileNameSigningBytes,
	signFirstRoot,
	signProvisionTenant,
	signRemoveTenant,
	signRosterRequest,
	signSetProfileName,
	signTrustPendingRequest,
	trustPendingSigningBytes,
	verifyFirstRoot,
	verifyProvisionTenant,
	verifyRemoveTenant,
	verifySetProfileName,
} from "../shared/enrollment.js";
import { ConsoleOpSchema, ProvisioningSchema } from "../shared/schemas.js";
import { assertCanonicalBytes } from "./_canonical-bytes.js";

////////////////////////////////
//  Friend cross-Domain onboarding signing-bytes vectors
//
//  vectors.json is read by BOTH this suite and ProvisionOpsTest.kt (Kotlin), so the
//  hand-authored Kotlin twin (ProvisionOpsCrypto.kt) cannot drift from this TS source:
//  the canonical bytes / signature either runtime derives differently fails one of the two
//  suites. This suite also guards the fixture against a hand-edit (the recorded bytes +
//  signature must reproduce from the live TS reference). The provision / remove ops are
//  operator-signed, first_root is SELF-signed by the fresh owner key, set_profile_name is
//  owner-signed.

interface SignedVec<T> {
	value: T;
	signingBytes: string;
	signingBytesHex: string;
	signingBytesBase64: string;
	signature: string;
}

const vectors = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/provision-ops/vectors.json"), "utf8"),
) as {
	adminSignPub: string;
	adminSignPriv: string;
	adminFingerprint: string;
	friendOwnerSignPub: string;
	friendOwnerSignPriv: string;
	friendOwnerBoxPub: string;
	friendOwnerFingerprint: string;
	provision: SignedVec<ProvisionTenant>;
	removal: SignedVec<RemoveTenant>;
	firstRoot: SignedVec<FirstRoot>;
	rename: SignedVec<SetProfileName>;
	roster: SignedVec<{ signerSignPub: string; proofAt: number; nonce: string }>;
	trustPending: SignedVec<{ signerSignPub: string; proofAt: number; nonce: string }>;
};

describe("provision_tenant vectors (operator-signed)", () => {
	const { adminSignPub, adminSignPriv } = vectors;

	it("reproduces the canonical PROVISION_TENANT_V1 signing bytes", () => {
		const bytes = provisionTenantSigningBytes(vectors.provision.value, adminSignPub);
		assertCanonicalBytes(bytes, vectors.provision);
	});

	it("embeds the operator fingerprint in the signing bytes", () => {
		// The signing bytes bind fingerprint(adminSignPub), not the raw key, so the verifier
		// can recompute it from the signed wrapper's adminSignPub.
		expect(vectors.adminFingerprint).toBe(fingerprint(adminSignPub));
		expect(vectors.provision.signingBytes).toContain(`\n${vectors.adminFingerprint}\n`);
	});

	it("reproduces the recorded signature and verifies it", () => {
		// Ed25519 is deterministic (RFC 8032), so re-signing with the fixed key reproduces the
		// pinned signature byte-for-byte.
		const signed = signProvisionTenant(vectors.provision.value, adminSignPriv, adminSignPub);
		expect(signed.signature).toBe(vectors.provision.signature);
		expect(verifyProvisionTenant(signed, adminSignPub)).toBe(true);
	});

	it("rejects the provision under a different operator key", () => {
		const forged = {
			...signProvisionTenant(vectors.provision.value, adminSignPriv, adminSignPub),
			adminSignPub: "AAAA",
		};
		expect(verifyProvisionTenant(forged, adminSignPub)).toBe(false);
	});

	it("parses a provision_tenant enroll op and rejects a non-slug domainId", () => {
		const signed = signProvisionTenant(vectors.provision.value, adminSignPriv, adminSignPub);
		expect(EnrollOpSchema.safeParse({ kind: "provision_tenant", provision: signed }).success).toBe(true);
		const badSlug = signProvisionTenant(
			{ ...vectors.provision.value, domainId: "Has Spaces" } as ProvisionTenant,
			adminSignPriv,
			adminSignPub,
		);
		expect(EnrollOpSchema.safeParse({ kind: "provision_tenant", provision: badSlug }).success).toBe(false);
	});
});

describe("remove_tenant vectors (operator-signed)", () => {
	const { adminSignPub, adminSignPriv } = vectors;

	it("reproduces the canonical REMOVE_TENANT_V1 signing bytes", () => {
		const bytes = removeTenantSigningBytes(vectors.removal.value, adminSignPub);
		assertCanonicalBytes(bytes, vectors.removal);
	});

	it("reproduces the recorded signature and verifies it", () => {
		const signed = signRemoveTenant(vectors.removal.value, adminSignPriv, adminSignPub);
		expect(signed.signature).toBe(vectors.removal.signature);
		expect(verifyRemoveTenant(signed, adminSignPub)).toBe(true);
	});

	it("a provision signature never replays as a removal (distinct versioned prefix)", () => {
		// Same domainId across provision and removal, but the version prefix differs, so the
		// provision's signature must not verify over the removal bytes.
		const asRemoval: RemoveTenant = {
			domainId: vectors.provision.value.domainId,
			issuedAt: vectors.provision.value.issuedAt,
			nonce: vectors.provision.value.nonce,
		};
		expect(
			verify(removeTenantSigningBytes(asRemoval, adminSignPub), vectors.provision.signature, adminSignPub),
		).toBe(false);
	});

	it("parses a remove_tenant enroll op", () => {
		const signed = signRemoveTenant(vectors.removal.value, adminSignPriv, adminSignPub);
		expect(EnrollOpSchema.safeParse({ kind: "remove_tenant", removal: signed }).success).toBe(true);
	});
});

describe("first_root vectors (self-signed by the fresh owner key)", () => {
	const { friendOwnerSignPub, friendOwnerSignPriv } = vectors;

	it("reproduces the canonical FIRST_ROOT_V1 signing bytes", () => {
		const bytes = firstRootSigningBytes(vectors.firstRoot.value);
		assertCanonicalBytes(bytes, vectors.firstRoot);
	});

	it("reproduces the recorded self-signature and verifies it against the rooted key", () => {
		const signed = signFirstRoot(vectors.firstRoot.value, friendOwnerSignPriv);
		expect(signed.signature).toBe(vectors.firstRoot.signature);
		// The first-root has no separate ownerSignPub: it verifies against firstRoot.ownerSignPub.
		expect(verifyFirstRoot(signed)).toBe(true);
		expect(signed.firstRoot.ownerSignPub).toBe(friendOwnerSignPub);
	});

	it("rejects a first_root whose ownerSignPub was substituted (self-signature breaks)", () => {
		const attacker = generateIdentity();
		const signed = signFirstRoot(vectors.firstRoot.value, friendOwnerSignPriv);
		// Swapping the key inside firstRoot changes the preimage AND the verify key, so the
		// pinned self-signature no longer checks: a captured first-root cannot be re-pointed at
		// an attacker's owner key.
		const forged = { ...signed, firstRoot: { ...signed.firstRoot, ownerSignPub: attacker.sign.pub } };
		expect(verifyFirstRoot(forged)).toBe(false);
	});

	it("rejects a tampered nonce (the one-time QR token is covered by the signature)", () => {
		const signed = signFirstRoot(vectors.firstRoot.value, friendOwnerSignPriv);
		const tampered = { ...signed, firstRoot: { ...signed.firstRoot, nonce: "b3RoZXItbm9uY2U=" } };
		expect(verifyFirstRoot(tampered)).toBe(false);
	});

	it("parses as a console op (a defensive reject), never an enroll op", () => {
		const signed = signFirstRoot(vectors.firstRoot.value, friendOwnerSignPriv);
		// first_root stays a ConsoleOp variant the gateway can defensively reject; the live
		// first-root POSTs DIRECTLY to evie (a pending Domain has no gateway), and it is NOT on
		// the evie enroll surface either (pre-root, the friend has no admission to authenticate).
		expect(ConsoleOpSchema.safeParse({ kind: "first_root", firstRoot: signed }).success).toBe(true);
		expect(EnrollOpSchema.safeParse({ kind: "first_root", firstRoot: signed }).success).toBe(false);
	});
});

describe("set_profile_name vectors (owner-signed)", () => {
	const { friendOwnerSignPub, friendOwnerSignPriv } = vectors;

	it("reproduces the canonical SET_PROFILE_NAME_V1 signing bytes", () => {
		const bytes = setProfileNameSigningBytes(vectors.rename.value, friendOwnerSignPub);
		assertCanonicalBytes(bytes, vectors.rename);
	});

	it("reproduces the recorded signature and verifies it", () => {
		const signed = signSetProfileName(vectors.rename.value, friendOwnerSignPriv, friendOwnerSignPub);
		expect(signed.signature).toBe(vectors.rename.signature);
		expect(verifySetProfileName(signed, friendOwnerSignPub)).toBe(true);
	});

	it("rejects the rename under a different owner key", () => {
		const attacker = generateIdentity();
		const signed = signSetProfileName(vectors.rename.value, friendOwnerSignPriv, friendOwnerSignPub);
		expect(verifySetProfileName(signed, attacker.sign.pub)).toBe(false);
	});

	it("parses a set_profile_name enroll op", () => {
		const signed = signSetProfileName(vectors.rename.value, friendOwnerSignPriv, friendOwnerSignPub);
		expect(EnrollOpSchema.safeParse({ kind: "set_profile_name", rename: signed }).success).toBe(true);
	});
});

describe("ProvisioningSchema pendingTenant (the pending-Domain discriminator)", () => {
	const base = {
		apiUrl: "https://k8s.example:6443",
		caPem: "-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----",
		saToken: "sa-token-value",
	};

	it("round-trips a blob carrying pendingTenant", () => {
		const blob = {
			...base,
			pendingTenant: { domainId: "guest-network-7", nonce: "bm9uY2UtdmFsdWU=" },
		};
		const parsed = ProvisioningSchema.safeParse(blob);
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.pendingTenant).toEqual({
			domainId: "guest-network-7",
			nonce: "bm9uY2UtdmFsdWU=",
		});
	});

	it("stays optional: a rooted-Domain blob omits pendingTenant", () => {
		const parsed = ProvisioningSchema.safeParse(base);
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.pendingTenant).toBeUndefined();
	});

	it("rejects a non-slug domainId and a non-base64 nonce inside pendingTenant", () => {
		expect(
			ProvisioningSchema.safeParse({ ...base, pendingTenant: { domainId: "Bad Domain", nonce: "bm9uY2U=" } })
				.success,
		).toBe(false);
		expect(
			ProvisioningSchema.safeParse({ ...base, pendingTenant: { domainId: "ok-domain", nonce: "not base64!" } })
				.success,
		).toBe(false);
	});
});

describe("roster request proof vectors (console-signed)", () => {
	it("reproduces the canonical ROSTER_V1 bytes + signature (cross-runtime pin)", () => {
		const { signerSignPub, proofAt, nonce } = vectors.roster.value;
		const bytes = rosterRequestSigningBytes(signerSignPub, proofAt, nonce);
		assertCanonicalBytes(bytes, vectors.roster);
		// Deterministic Ed25519: re-signing with the fixed key reproduces the pinned signature.
		expect(signRosterRequest(signerSignPub, proofAt, nonce, vectors.friendOwnerSignPriv)).toBe(
			vectors.roster.signature,
		);
		expect(verify(bytes, vectors.roster.signature, signerSignPub)).toBe(true);
	});
});

describe("trust-pending proof vectors (owner-signed, FLOW-2)", () => {
	it("reproduces the canonical TRUST_PENDING_V1 bytes + signature (cross-runtime pin)", () => {
		const { signerSignPub, proofAt, nonce } = vectors.trustPending.value;
		const bytes = trustPendingSigningBytes(signerSignPub, proofAt, nonce);
		assertCanonicalBytes(bytes, vectors.trustPending);
		expect(signTrustPendingRequest(signerSignPub, proofAt, nonce, vectors.friendOwnerSignPriv)).toBe(
			vectors.trustPending.signature,
		);
		expect(verify(bytes, vectors.trustPending.signature, signerSignPub)).toBe(true);
	});

	it("the distinct version tag stops a roster proof from verifying as a trust-pending query", () => {
		// Same key + proofAt + nonce, but ROSTER_V1 vs TRUST_PENDING_V1, so neither proof crosses over.
		const { signerSignPub, proofAt, nonce } = vectors.trustPending.value;
		const rosterSig = signRosterRequest(signerSignPub, proofAt, nonce, vectors.friendOwnerSignPriv);
		expect(verify(trustPendingSigningBytes(signerSignPub, proofAt, nonce), rosterSig, signerSignPub)).toBe(false);
	});
});
