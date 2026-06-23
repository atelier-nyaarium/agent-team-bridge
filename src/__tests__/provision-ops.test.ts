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
	type SetOperatorName,
	setOperatorNameSigningBytes,
	signFirstRoot,
	signProvisionTenant,
	signRemoveTenant,
	signSetOperatorName,
	verifyFirstRoot,
	verifyProvisionTenant,
	verifyRemoveTenant,
	verifySetOperatorName,
} from "../shared/enrollment.js";
import { ConsoleOpSchema } from "../shared/schemas.js";
import { assertCanonicalBytes } from "./_canonical-bytes.js";

////////////////////////////////
//  Friend cross-Domain onboarding signing-bytes vectors
//
//  vectors.json is read by BOTH this suite and ProvisionOpsTest.kt (Kotlin), so the
//  hand-authored Kotlin twin (ProvisionOpsCrypto.kt) cannot drift from this TS source:
//  the canonical bytes / signature either runtime derives differently fails one of the two
//  suites. This suite also guards the fixture against a hand-edit (the recorded bytes +
//  signature must reproduce from the live TS reference). The provision / remove ops are
//  operator-signed, first_root is SELF-signed by the fresh owner key, set_operator_name is
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
	operatorSignPub: string;
	operatorSignPriv: string;
	operatorFingerprint: string;
	friendOwnerSignPub: string;
	friendOwnerSignPriv: string;
	friendOwnerBoxPub: string;
	friendOwnerFingerprint: string;
	provision: SignedVec<ProvisionTenant>;
	removal: SignedVec<RemoveTenant>;
	firstRoot: SignedVec<FirstRoot>;
	rename: SignedVec<SetOperatorName>;
};

describe("provision_tenant vectors (operator-signed)", () => {
	const { operatorSignPub, operatorSignPriv } = vectors;

	it("reproduces the canonical PROVISION_TENANT_V1 signing bytes", () => {
		const bytes = provisionTenantSigningBytes(vectors.provision.value, operatorSignPub);
		assertCanonicalBytes(bytes, vectors.provision);
	});

	it("embeds the operator fingerprint in the signing bytes", () => {
		// The signing bytes bind fingerprint(operatorSignPub), not the raw key, so the verifier
		// can recompute it from the signed wrapper's operatorSignPub.
		expect(vectors.operatorFingerprint).toBe(fingerprint(operatorSignPub));
		expect(vectors.provision.signingBytes).toContain(`\n${vectors.operatorFingerprint}\n`);
	});

	it("reproduces the recorded signature and verifies it", () => {
		// Ed25519 is deterministic (RFC 8032), so re-signing with the fixed key reproduces the
		// pinned signature byte-for-byte.
		const signed = signProvisionTenant(vectors.provision.value, operatorSignPriv, operatorSignPub);
		expect(signed.signature).toBe(vectors.provision.signature);
		expect(verifyProvisionTenant(signed, operatorSignPub)).toBe(true);
	});

	it("rejects the provision under a different operator key", () => {
		const forged = {
			...signProvisionTenant(vectors.provision.value, operatorSignPriv, operatorSignPub),
			operatorSignPub: "AAAA",
		};
		expect(verifyProvisionTenant(forged, operatorSignPub)).toBe(false);
	});

	it("parses a provision_tenant enroll op and rejects a non-slug domainId", () => {
		const signed = signProvisionTenant(vectors.provision.value, operatorSignPriv, operatorSignPub);
		expect(EnrollOpSchema.safeParse({ kind: "provision_tenant", provision: signed }).success).toBe(true);
		const badSlug = signProvisionTenant(
			{ ...vectors.provision.value, domainId: "Has Spaces" } as ProvisionTenant,
			operatorSignPriv,
			operatorSignPub,
		);
		expect(EnrollOpSchema.safeParse({ kind: "provision_tenant", provision: badSlug }).success).toBe(false);
	});
});

describe("remove_tenant vectors (operator-signed)", () => {
	const { operatorSignPub, operatorSignPriv } = vectors;

	it("reproduces the canonical REMOVE_TENANT_V1 signing bytes", () => {
		const bytes = removeTenantSigningBytes(vectors.removal.value, operatorSignPub);
		assertCanonicalBytes(bytes, vectors.removal);
	});

	it("reproduces the recorded signature and verifies it", () => {
		const signed = signRemoveTenant(vectors.removal.value, operatorSignPriv, operatorSignPub);
		expect(signed.signature).toBe(vectors.removal.signature);
		expect(verifyRemoveTenant(signed, operatorSignPub)).toBe(true);
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
			verify(removeTenantSigningBytes(asRemoval, operatorSignPub), vectors.provision.signature, operatorSignPub),
		).toBe(false);
	});

	it("parses a remove_tenant enroll op", () => {
		const signed = signRemoveTenant(vectors.removal.value, operatorSignPriv, operatorSignPub);
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

	it("is a console op, not an enroll op (the gateway PENDING_ENROLL path consumes it)", () => {
		const signed = signFirstRoot(vectors.firstRoot.value, friendOwnerSignPriv);
		expect(ConsoleOpSchema.safeParse({ kind: "first_root", firstRoot: signed }).success).toBe(true);
		// first_root is NOT on the evie enroll surface (pre-root, the friend has no admission).
		expect(EnrollOpSchema.safeParse({ kind: "first_root", firstRoot: signed }).success).toBe(false);
	});
});

describe("set_operator_name vectors (owner-signed)", () => {
	const { friendOwnerSignPub, friendOwnerSignPriv } = vectors;

	it("reproduces the canonical SET_OPERATOR_NAME_V1 signing bytes", () => {
		const bytes = setOperatorNameSigningBytes(vectors.rename.value, friendOwnerSignPub);
		assertCanonicalBytes(bytes, vectors.rename);
	});

	it("reproduces the recorded signature and verifies it", () => {
		const signed = signSetOperatorName(vectors.rename.value, friendOwnerSignPriv, friendOwnerSignPub);
		expect(signed.signature).toBe(vectors.rename.signature);
		expect(verifySetOperatorName(signed, friendOwnerSignPub)).toBe(true);
	});

	it("rejects the rename under a different owner key", () => {
		const attacker = generateIdentity();
		const signed = signSetOperatorName(vectors.rename.value, friendOwnerSignPriv, friendOwnerSignPub);
		expect(verifySetOperatorName(signed, attacker.sign.pub)).toBe(false);
	});

	it("parses a set_operator_name enroll op", () => {
		const signed = signSetOperatorName(vectors.rename.value, friendOwnerSignPriv, friendOwnerSignPub);
		expect(EnrollOpSchema.safeParse({ kind: "set_operator_name", rename: signed }).success).toBe(true);
	});
});
