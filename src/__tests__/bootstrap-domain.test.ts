import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	pendingAdminDomain,
	readAdminDomain,
	removeDomain,
	removeGatewayAdmission,
} from "../../scripts/bootstrap-domain.js";
import { buildProvisioningBlob } from "../../scripts/write-provisioning-blob.js";
import { type Admission, type SignedAdmission, signAdmission } from "../shared/admission.js";
import { b64Field, generateIdentity } from "../shared/crypto.js";

// The test-fixture admin Domain id (production mints a random hex id).
const TEST_DOMAIN_ID = "alice";

////////////////////////////////
//  Harness

const evie = generateIdentity();
const owner = generateIdentity();
const otherOwner = generateIdentity();
const member = generateIdentity();

function adminAdmission(ownerId = owner): SignedAdmission {
	const admission: Admission = {
		kind: "console",
		signPub: member.sign.pub,
		boxPub: member.box.pub,
		issuedAt: 1000,
		nonce: "bm9uY2U=",
	};
	return signAdmission(admission, ownerId.sign.priv, ownerId.sign.pub);
}

/** A v2 (multi-tenant) federation Secret: the admin Domain rooted at `owner` with one admission,
 * plus a friend Domain "work" rooted at a DIFFERENT owner. */
function v2Secret() {
	return JSON.stringify({
		schema: 2,
		identity: evie,
		enrollment: {
			[TEST_DOMAIN_ID]: {
				ownerSignPub: owner.sign.pub,
				ownerBoxPub: owner.box.pub,
				admissions: [adminAdmission()],
				revocations: [],
			},
			work: {
				ownerSignPub: otherOwner.sign.pub,
				ownerBoxPub: otherOwner.box.pub,
				admissions: [],
				revocations: [],
			},
		},
	});
}

////////////////////////////////
//  Tests
//
//  displayName + slice fixtures shared by the pendingAdminDomain / readAdminDomain blocks,
//  which cover the live fresh-vs-reprovision flow.

interface SliceWithName {
	ownerSignPub: string | null;
	admissions: SignedAdmission[];
	displayName?: string | null;
	pendingTenant?: { displayName: string; nonce: string; issuedAt: number; ttlMs: number; rooted: boolean };
}

/** A v2 Secret whose admin Domain is rooted at `owner` AND carries an displayName, so
 * readAdminDomain can be checked to surface that label on an already-rooted admin Domain. */
function v2RootedWithName(name: string) {
	return JSON.stringify({
		schema: 2,
		identity: evie,
		enrollment: {
			[TEST_DOMAIN_ID]: {
				ownerSignPub: owner.sign.pub,
				ownerBoxPub: owner.box.pub,
				admissions: [adminAdmission()],
				revocations: [],
				displayName: name,
			},
		},
	});
}

////////////////////////////////
//  pendingAdminDomain (fresh setup: pre-stage the rootless admin Domain)

describe("pendingAdminDomain (the fresh-setup pending admin slice)", () => {
	const NONCE = randomBytes(18).toString("base64");

	it("writes a rootless admin slice mirroring evie's PendingTenantRecord", () => {
		const fresh = JSON.stringify({ schema: 2, identity: evie, enrollment: {} });
		const { federationJson } = pendingAdminDomain(fresh, TEST_DOMAIN_ID, "Nyaarium", NONCE, 1000, 86_400_000);
		expect((federationJson as { schema?: number }).schema).toBe(2);
		const slice = (federationJson as { enrollment: Record<string, SliceWithName> }).enrollment[TEST_DOMAIN_ID];
		// No owner yet (the phone first-roots on scan); the displayName + pendingTenant are set.
		expect(slice.ownerSignPub).toBeNull();
		expect(slice.displayName).toBe("Nyaarium");
		expect(slice.pendingTenant).toEqual({
			displayName: "Nyaarium",
			nonce: NONCE,
			issuedAt: 1000,
			ttlMs: 86_400_000,
			rooted: false,
		});
	});

	it("mints the invite nonce as STANDARD base64 (not base64url - the wire field is a b64Field)", () => {
		// randomBytes(18).toString("base64") is the byte-identical mint evie uses, and it must pass
		// the b64Field charset that the first_root wire `nonce` enforces. A base64url nonce carrying
		// -/_ would fail this, reintroducing the Phase 3 bug.
		expect(b64Field().safeParse(NONCE).success).toBe(true);
		expect(NONCE).not.toMatch(/[-_]/);
	});

	it("preserves evie's identity and every friend Domain when pre-staging the admin Domain", () => {
		// A v2 Secret already hosting a friend Domain "work": pre-staging the admin Domain must not touch it.
		const { federationJson } = pendingAdminDomain(v2Secret(), TEST_DOMAIN_ID, "Nyaarium", NONCE, 1000, 86_400_000);
		expect(federationJson.identity.sign.pub).toBe(evie.sign.pub);
		const enrollment = (federationJson as { enrollment: Record<string, SliceWithName> }).enrollment;
		expect(enrollment.work.ownerSignPub).toBe(otherOwner.sign.pub);
		expect(enrollment[TEST_DOMAIN_ID].ownerSignPub).toBeNull();
		expect(enrollment[TEST_DOMAIN_ID].pendingTenant?.rooted).toBe(false);
	});
});

////////////////////////////////
//  readAdminDomain (the fresh-vs-reprovision state-machine discriminator)

describe("readAdminDomain (fresh vs re-provision detection)", () => {
	it("reads ROOTED for a rooted admin Domain and surfaces its owner + displayName", () => {
		const r = readAdminDomain(v2RootedWithName("Nyaarium"), TEST_DOMAIN_ID);
		expect(r.rooted).toBe(true);
		expect(r.ownerSignPub).toBe(owner.sign.pub);
		expect(r.displayName).toBe("Nyaarium");
	});

	it("reads NOT-rooted for a freshly pre-staged pending admin Domain, surfacing the pending displayName", () => {
		const fresh = JSON.stringify({ schema: 2, identity: evie, enrollment: {} });
		const { federationJson } = pendingAdminDomain(
			fresh,
			TEST_DOMAIN_ID,
			"Nyaarium",
			randomBytes(18).toString("base64"),
			1000,
			1,
		);
		const r = readAdminDomain(JSON.stringify(federationJson), TEST_DOMAIN_ID);
		expect(r.rooted).toBe(false);
		expect(r.ownerSignPub).toBeNull();
		// The label is read off the pending record before rooting (so a re-run shows the same name).
		expect(r.displayName).toBe("Nyaarium");
	});

	it("reads NOT-rooted for an absent admin Domain (a never-staged Secret)", () => {
		const r = readAdminDomain(JSON.stringify({ schema: 2, identity: evie, enrollment: {} }), TEST_DOMAIN_ID);
		expect(r).toEqual({ rooted: false, ownerSignPub: null, displayName: null });
	});

	it("reads NOT-rooted for a malformed Secret (fresh setup pre-stages it rather than throwing)", () => {
		const r = readAdminDomain("not json {", TEST_DOMAIN_ID);
		expect(r).toEqual({ rooted: false, ownerSignPub: null, displayName: null });
	});
});

////////////////////////////////
//  Blob pendingTenant wiring (the discriminator the app reads)

describe("provisioning blob pendingTenant (the pending vs rooted discriminator)", () => {
	const base = { apiUrl: "https://k8s.example:6443", caPem: "ca", saToken: "sa", appToken: "app" };

	it("carries pendingTenant when fresh (admin domainId + the standard-base64 invite nonce)", () => {
		const nonce = randomBytes(18).toString("base64");
		const blob = buildProvisioningBlob({ ...base, pendingTenant: { domainId: TEST_DOMAIN_ID, nonce } });
		expect(blob.pendingTenant).toEqual({ domainId: TEST_DOMAIN_ID, nonce });
	});

	it("omits pendingTenant on a re-provision (rooted Domain)", () => {
		const blob = buildProvisioningBlob(base);
		expect(blob.pendingTenant).toBeUndefined();
	});

	it("rejects a base64url nonce in pendingTenant (guards the Phase 3 bug at the schema)", () => {
		expect(() =>
			buildProvisioningBlob({ ...base, pendingTenant: { domainId: TEST_DOMAIN_ID, nonce: "ab-cd_ef" } }),
		).toThrow();
	});
});

////////////////////////////////
//  Purge helpers (removeGatewayAdmission / removeDomain) - the evie-side deletes
//
//  The lossless property: the mutation operates on the raw parsed JSON, so every field the setup
//  write paths never carry (a friend Domain's linkEdges / linkRevocations / isAdminDomain) survives.

/** A gateway admission for `gatewayId`, owner-signed. The fixture below seats two of these so a
 * purge can be checked to drop ONLY the named one. */
function gatewayAdmission(gatewayId: string): SignedAdmission {
	const admission: Admission = {
		kind: "gateway",
		signPub: generateIdentity().sign.pub,
		boxPub: generateIdentity().box.pub,
		gatewayId,
		issuedAt: 2000,
		nonce: b64Field().parse(randomBytes(12).toString("base64")),
	};
	return signAdmission(admission, owner.sign.priv, owner.sign.pub);
}

/** A v2 Secret with a rooted ADMIN Domain (isAdminDomain, owner root, 2 gateway admissions + 1
 * console admission + a revocation) AND a FRIEND Domain carrying its own admissions plus the
 * link-edge fields the setup write paths never touch. Returned as the JSON string the helpers take.
 * `revocation` and `linkEdges`/`linkRevocations` are opaque structural blobs here (the purge helpers
 * never parse them); they exist to prove they survive byte-for-byte. */
function purgeFixture() {
	const revocation = {
		revocation: { signPub: generateIdentity().sign.pub, issuedAt: 1500, nonce: "cmV2" },
		ownerSignPub: owner.sign.pub,
		signature: "sig",
	};
	const linkEdge = {
		edge: { srcDomainId: "work", dstDomainId: TEST_DOMAIN_ID, issuedAt: 3000, nonce: "ZWRnZQ==" },
		ownerSignPub: otherOwner.sign.pub,
		signature: "edgesig",
	};
	const linkRevocation = {
		revocation: { srcDomainId: "work", dstDomainId: TEST_DOMAIN_ID, revokedAt: 4000, nonce: "cmV2ZWRnZQ==" },
		ownerSignPub: otherOwner.sign.pub,
		signature: "linkrevsig",
	};
	return JSON.stringify({
		schema: 2,
		identity: evie,
		enrollment: {
			[TEST_DOMAIN_ID]: {
				ownerSignPub: owner.sign.pub,
				ownerBoxPub: owner.box.pub,
				admissions: [gatewayAdmission("gw-keep"), gatewayAdmission("gw-drop"), adminAdmission()],
				revocations: [revocation],
				displayName: "Nyaarium",
				isAdminDomain: true,
			},
			work: {
				ownerSignPub: otherOwner.sign.pub,
				ownerBoxPub: otherOwner.box.pub,
				admissions: [adminAdmission(otherOwner)],
				revocations: [],
				displayName: "Work",
				linkEdges: [linkEdge],
				linkRevocations: [linkRevocation],
			},
		},
	});
}

describe("removeGatewayAdmission (purge gateway: drop one gateway's admission)", () => {
	// One fixture string per test, reused for both the input and the baseline - the fixture's keys /
	// nonces are randomly minted, so comparing two separate purgeFixture() calls would always differ.
	it("drops ONLY the named gateway, keeping the other gateway, the console admission, and the revocation", () => {
		const fixture = purgeFixture();
		const before = JSON.parse(fixture);
		const after = JSON.parse(removeGatewayAdmission(fixture, TEST_DOMAIN_ID, "gw-drop"));
		const admissions = after.enrollment[TEST_DOMAIN_ID].admissions as SignedAdmission[];
		const gwIds = admissions.filter((a) => a.admission.kind === "gateway").map((a) => a.admission.gatewayId);
		expect(gwIds).toEqual(["gw-keep"]);
		// The console admission and the revocation are untouched.
		expect(admissions.some((a) => a.admission.kind === "console")).toBe(true);
		expect(after.enrollment[TEST_DOMAIN_ID].revocations).toEqual(before.enrollment[TEST_DOMAIN_ID].revocations);
		// The owner root + isAdminDomain survive.
		expect(after.enrollment[TEST_DOMAIN_ID].ownerSignPub).toBe(owner.sign.pub);
		expect(after.enrollment[TEST_DOMAIN_ID].isAdminDomain).toBe(true);
	});

	it("leaves the FRIEND Domain byte-for-byte intact (including its linkEdges - the lossless property)", () => {
		const fixture = purgeFixture();
		const before = JSON.parse(fixture);
		const after = JSON.parse(removeGatewayAdmission(fixture, TEST_DOMAIN_ID, "gw-drop"));
		expect(after.enrollment.work).toEqual(before.enrollment.work);
		// The link-edge fields the setup write paths never carry are still present.
		expect(after.enrollment.work.linkEdges).toHaveLength(1);
		expect(after.enrollment.work.linkRevocations).toHaveLength(1);
	});

	it("preserves evie's identity verbatim", () => {
		const after = JSON.parse(removeGatewayAdmission(purgeFixture(), TEST_DOMAIN_ID, "gw-drop"));
		expect(after.identity.sign.pub).toBe(evie.sign.pub);
		expect(after.identity.sign.priv).toBe(evie.sign.priv);
	});

	it("is idempotent for an absent gateway id (no slice change)", () => {
		const fixture = purgeFixture();
		const before = JSON.parse(fixture);
		const after = JSON.parse(removeGatewayAdmission(fixture, TEST_DOMAIN_ID, "nope"));
		expect(after).toEqual(before);
	});

	it("is idempotent for an absent Domain (returns the input unchanged)", () => {
		const input = purgeFixture();
		expect(removeGatewayAdmission(input, "no-such-domain", "gw-drop")).toBe(input);
	});
});

describe("removeDomain (purge federation: drop one Domain, keep the rest)", () => {
	it("drops ONLY the admin Domain; the friend Domain and identity survive", () => {
		const fixture = purgeFixture();
		const before = JSON.parse(fixture);
		const after = JSON.parse(removeDomain(fixture, TEST_DOMAIN_ID));
		expect(after.enrollment[TEST_DOMAIN_ID]).toBeUndefined();
		// The friend tenant survives whole (including its linkEdges).
		expect(after.enrollment.work).toEqual(before.enrollment.work);
		expect(after.enrollment.work.linkEdges).toHaveLength(1);
		expect(after.identity.sign.pub).toBe(evie.sign.pub);
	});

	it("is idempotent for an absent Domain", () => {
		const fixture = purgeFixture();
		const before = JSON.parse(fixture);
		const after = JSON.parse(removeDomain(fixture, "no-such-domain"));
		expect(after).toEqual(before);
	});
});
