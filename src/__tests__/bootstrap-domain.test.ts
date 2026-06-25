import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bootstrapDomain, pendingHomeDomain, readHomeDomain } from "../../scripts/bootstrap-domain.js";
import { buildProvisioningBlob } from "../../scripts/write-provisioning-blob.js";
import { type Admission, type SignedAdmission, signAdmission } from "../shared/admission.js";
import { b64Field, generateIdentity } from "../shared/crypto.js";

// The test-fixture home Domain id (production mints a random hex id).
const DEFAULT_DOMAIN_ID = "home";

////////////////////////////////
//  Harness

const evie = generateIdentity();
const owner = generateIdentity();
const otherOwner = generateIdentity();
const member = generateIdentity();

function homeAdmission(ownerId = owner): SignedAdmission {
	const admission: Admission = {
		kind: "console",
		signPub: member.sign.pub,
		boxPub: member.box.pub,
		issuedAt: 1000,
		nonce: "bm9uY2U=",
	};
	return signAdmission(admission, ownerId.sign.priv, ownerId.sign.pub);
}

/** A v2 (multi-tenant) federation Secret: home rooted at `owner` with one admission,
 * plus a friend Domain "work" rooted at a DIFFERENT owner. */
function v2Secret() {
	return JSON.stringify({
		schema: 2,
		identity: evie,
		enrollment: {
			[DEFAULT_DOMAIN_ID]: {
				ownerSignPub: owner.sign.pub,
				ownerBoxPub: owner.box.pub,
				admissions: [homeAdmission()],
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

describe("bootstrapDomain v2-awareness (red-team P5: data loss)", () => {
	it("re-roots ONLY the home slice of a v2 Secret and preserves a friend Domain", () => {
		const { federationJson } = bootstrapDomain(v2Secret(), DEFAULT_DOMAIN_ID, owner.sign.pub, owner.box.pub);
		// Written back in the v2 shape, not blind-overwritten as v1.
		expect((federationJson as { schema?: number }).schema).toBe(2);
		const enrollment = (federationJson as { enrollment: Record<string, { ownerSignPub: string }> }).enrollment;
		// The friend Domain "work" survives, still rooted at the OTHER owner.
		expect(enrollment.work).toBeDefined();
		expect(enrollment.work.ownerSignPub).toBe(otherOwner.sign.pub);
		// home is (re-)rooted at our owner.
		expect(enrollment[DEFAULT_DOMAIN_ID].ownerSignPub).toBe(owner.sign.pub);
	});

	it("preserves home's existing admissions when re-rooting at the SAME owner", () => {
		const { federationJson } = bootstrapDomain(v2Secret(), DEFAULT_DOMAIN_ID, owner.sign.pub, owner.box.pub);
		const home = (federationJson as { enrollment: Record<string, { admissions: SignedAdmission[] }> }).enrollment[
			DEFAULT_DOMAIN_ID
		];
		// The home admission survived (same-owner re-root keeps the allowlist).
		expect(home.admissions).toHaveLength(1);
		expect(home.admissions[0].admission.signPub).toBe(member.sign.pub);
	});

	it("drops home's admissions when re-rooting at a DIFFERENT owner, but still keeps the friend Domain", () => {
		// A different owner is a fresh home Domain (old admissions would not verify), yet the
		// friend Domain must NOT be touched.
		const { federationJson } = bootstrapDomain(
			v2Secret(),
			DEFAULT_DOMAIN_ID,
			otherOwner.sign.pub,
			otherOwner.box.pub,
		);
		const enrollment = (
			federationJson as {
				enrollment: Record<string, { ownerSignPub: string; admissions: SignedAdmission[] }>;
			}
		).enrollment;
		expect(enrollment[DEFAULT_DOMAIN_ID].ownerSignPub).toBe(otherOwner.sign.pub);
		expect(enrollment[DEFAULT_DOMAIN_ID].admissions).toHaveLength(0);
		// "work" (rooted at otherOwner already) is carried through untouched.
		expect(enrollment.work.ownerSignPub).toBe(otherOwner.sign.pub);
	});

	it("does not double-count: a v2 Secret never wipes a non-home Domain", () => {
		// Two friend Domains plus home: all three slices must be present after rooting home.
		const secret = JSON.stringify({
			schema: 2,
			identity: evie,
			enrollment: {
				home: { ownerSignPub: "old-home", ownerBoxPub: "b", admissions: [], revocations: [] },
				work: { ownerSignPub: "work-owner", ownerBoxPub: "wb", admissions: [], revocations: [] },
				lab: { ownerSignPub: "lab-owner", ownerBoxPub: "lb", admissions: [], revocations: [] },
			},
		});
		const { federationJson } = bootstrapDomain(secret, DEFAULT_DOMAIN_ID, owner.sign.pub, owner.box.pub);
		const keys = Object.keys((federationJson as { enrollment: Record<string, unknown> }).enrollment).sort();
		expect(keys).toEqual(["home", "lab", "work"]);
	});

	it("first-root on a fresh v2 empty-map Secret writes the home slice in v2 shape", () => {
		// evie's KubeSecretStore.init writes { schema:2, identity, enrollment:{} } on first
		// boot; rooting must produce a v2 blob with just the home slice.
		const fresh = JSON.stringify({ schema: 2, identity: evie, enrollment: {} });
		const { federationJson } = bootstrapDomain(fresh, DEFAULT_DOMAIN_ID, owner.sign.pub, owner.box.pub);
		expect((federationJson as { schema?: number }).schema).toBe(2);
		const enrollment = (federationJson as { enrollment: Record<string, { ownerSignPub: string }> }).enrollment;
		expect(Object.keys(enrollment)).toEqual(["home"]);
		expect(enrollment.home.ownerSignPub).toBe(owner.sign.pub);
	});

	it("keeps the legacy v1 single-Domain write path for a v1 Secret", () => {
		// A genuinely old v1 Secret (no schema, enrollment IS an EnrollmentState).
		const v1 = JSON.stringify({
			identity: evie,
			enrollment: {
				ownerSignPub: owner.sign.pub,
				ownerBoxPub: owner.box.pub,
				admissions: [homeAdmission()],
				revocations: [],
			},
		});
		const { federationJson } = bootstrapDomain(v1, DEFAULT_DOMAIN_ID, owner.sign.pub, owner.box.pub);
		// v1 output: NO schema marker, enrollment is the single state (not a map).
		expect((federationJson as { schema?: number }).schema).toBeUndefined();
		const enrollment = federationJson.enrollment as { ownerSignPub: string; admissions: SignedAdmission[] };
		expect(enrollment.ownerSignPub).toBe(owner.sign.pub);
		// Same-owner: the admission is preserved on the v1 path too.
		expect(enrollment.admissions).toHaveLength(1);
	});

	it("preserves evie's identity verbatim (rooting must not change evie's SAS)", () => {
		const { federationJson } = bootstrapDomain(v2Secret(), DEFAULT_DOMAIN_ID, owner.sign.pub, owner.box.pub);
		expect(federationJson.identity.sign.pub).toBe(evie.sign.pub);
		expect(federationJson.identity.sign.priv).toBe(evie.sign.priv);
	});

	it("rejects a malformed owner key with an actionable error", () => {
		expect(() => bootstrapDomain(v2Secret(), DEFAULT_DOMAIN_ID, "not-a-key", owner.box.pub)).toThrow(/32-byte key/);
	});
});

////////////////////////////////
//  displayName preservation on the owner-key bootstrapDomain rooting helper.
//
//  These cover bootstrapDomain (the owner-key-in-hand same-owner re-root case), NOT the live
//  provision() re-provision path - that path never rewrites the Secret for an already-rooted home,
//  so it preserves displayName by not touching the slice. The pendingHomeDomain / readHomeDomain
//  blocks below cover the live fresh-vs-reprovision flow.

interface SliceWithName {
	ownerSignPub: string | null;
	admissions: SignedAdmission[];
	displayName?: string | null;
	pendingTenant?: { displayName: string; nonce: string; issuedAt: number; ttlMs: number; rooted: boolean };
}

/** A v2 Secret whose home Domain is rooted at `owner` AND carries an displayName, so the
 * same-owner re-root path can be checked to PRESERVE that label. */
function v2RootedWithName(name: string) {
	return JSON.stringify({
		schema: 2,
		identity: evie,
		enrollment: {
			[DEFAULT_DOMAIN_ID]: {
				ownerSignPub: owner.sign.pub,
				ownerBoxPub: owner.box.pub,
				admissions: [homeAdmission()],
				revocations: [],
				displayName: name,
			},
		},
	});
}

describe("bootstrapDomain displayName preservation (owner-key re-root helper, not the live path)", () => {
	it("keeps displayName on a SAME-owner re-root", () => {
		const { federationJson } = bootstrapDomain(
			v2RootedWithName("Nyaarium"),
			DEFAULT_DOMAIN_ID,
			owner.sign.pub,
			owner.box.pub,
		);
		const home = (federationJson as { enrollment: Record<string, SliceWithName> }).enrollment[DEFAULT_DOMAIN_ID];
		expect(home.displayName).toBe("Nyaarium");
		// The same-owner allowlist is preserved alongside the name.
		expect(home.admissions).toHaveLength(1);
	});

	it("drops displayName on a DIFFERENT-owner re-root (fresh Domain, the label was the prior owner's)", () => {
		const { federationJson } = bootstrapDomain(
			v2RootedWithName("Nyaarium"),
			DEFAULT_DOMAIN_ID,
			otherOwner.sign.pub,
			otherOwner.box.pub,
		);
		const home = (federationJson as { enrollment: Record<string, SliceWithName> }).enrollment[DEFAULT_DOMAIN_ID];
		expect(home.displayName).toBeUndefined();
		expect(home.admissions).toHaveLength(0);
	});
});

////////////////////////////////
//  pendingHomeDomain (fresh setup: pre-stage the rootless home Domain)

describe("pendingHomeDomain (the fresh-setup pending home slice)", () => {
	const NONCE = randomBytes(18).toString("base64");

	it("writes a rootless home slice mirroring evie's PendingTenantRecord", () => {
		const fresh = JSON.stringify({ schema: 2, identity: evie, enrollment: {} });
		const { federationJson } = pendingHomeDomain(fresh, DEFAULT_DOMAIN_ID, "Nyaarium", NONCE, 1000, 86_400_000);
		expect((federationJson as { schema?: number }).schema).toBe(2);
		const home = (federationJson as { enrollment: Record<string, SliceWithName> }).enrollment[DEFAULT_DOMAIN_ID];
		// No owner yet (the phone first-roots on scan); the displayName + pendingTenant are set.
		expect(home.ownerSignPub).toBeNull();
		expect(home.displayName).toBe("Nyaarium");
		expect(home.pendingTenant).toEqual({
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

	it("preserves evie's identity and every friend Domain when pre-staging home", () => {
		// A v2 Secret already hosting a friend Domain "work": pre-staging home must not touch it.
		const { federationJson } = pendingHomeDomain(
			v2Secret(),
			DEFAULT_DOMAIN_ID,
			"Nyaarium",
			NONCE,
			1000,
			86_400_000,
		);
		expect(federationJson.identity.sign.pub).toBe(evie.sign.pub);
		const enrollment = (federationJson as { enrollment: Record<string, SliceWithName> }).enrollment;
		expect(enrollment.work.ownerSignPub).toBe(otherOwner.sign.pub);
		expect(enrollment[DEFAULT_DOMAIN_ID].ownerSignPub).toBeNull();
		expect(enrollment[DEFAULT_DOMAIN_ID].pendingTenant?.rooted).toBe(false);
	});

	it("keeps the v1 single-Domain write path on a legacy Secret", () => {
		const v1 = JSON.stringify({
			identity: evie,
			enrollment: { ownerSignPub: null, ownerBoxPub: null, admissions: [], revocations: [] },
		});
		const { federationJson } = pendingHomeDomain(v1, DEFAULT_DOMAIN_ID, "Nyaarium", NONCE, 1000, 86_400_000);
		expect((federationJson as { schema?: number }).schema).toBeUndefined();
		const home = federationJson.enrollment as SliceWithName;
		expect(home.ownerSignPub).toBeNull();
		expect(home.pendingTenant?.displayName).toBe("Nyaarium");
	});
});

////////////////////////////////
//  readHomeDomain (the fresh-vs-reprovision state-machine discriminator)

describe("readHomeDomain (fresh vs re-provision detection)", () => {
	it("reads ROOTED for a rooted home Domain and surfaces its owner + displayName", () => {
		const r = readHomeDomain(v2RootedWithName("Nyaarium"), DEFAULT_DOMAIN_ID);
		expect(r.rooted).toBe(true);
		expect(r.ownerSignPub).toBe(owner.sign.pub);
		expect(r.displayName).toBe("Nyaarium");
	});

	it("reads NOT-rooted for a freshly pre-staged pending home, surfacing the pending displayName", () => {
		const fresh = JSON.stringify({ schema: 2, identity: evie, enrollment: {} });
		const { federationJson } = pendingHomeDomain(
			fresh,
			DEFAULT_DOMAIN_ID,
			"Nyaarium",
			randomBytes(18).toString("base64"),
			1000,
			1,
		);
		const r = readHomeDomain(JSON.stringify(federationJson), DEFAULT_DOMAIN_ID);
		expect(r.rooted).toBe(false);
		expect(r.ownerSignPub).toBeNull();
		// The label is read off the pending record before rooting (so a re-run shows the same name).
		expect(r.displayName).toBe("Nyaarium");
	});

	it("reads NOT-rooted for an absent home (a never-staged Secret)", () => {
		const r = readHomeDomain(JSON.stringify({ schema: 2, identity: evie, enrollment: {} }), DEFAULT_DOMAIN_ID);
		expect(r).toEqual({ rooted: false, ownerSignPub: null, displayName: null });
	});

	it("reads NOT-rooted for a malformed Secret (fresh setup pre-stages it rather than throwing)", () => {
		const r = readHomeDomain("not json {", DEFAULT_DOMAIN_ID);
		expect(r).toEqual({ rooted: false, ownerSignPub: null, displayName: null });
	});
});

////////////////////////////////
//  Blob pendingTenant wiring (the discriminator the app reads)

describe("provisioning blob pendingTenant (the pending vs rooted discriminator)", () => {
	const base = { apiUrl: "https://k8s.example:6443", caPem: "ca", saToken: "sa", appToken: "app" };

	it("carries pendingTenant when fresh (home domainId + the standard-base64 invite nonce)", () => {
		const nonce = randomBytes(18).toString("base64");
		const blob = buildProvisioningBlob({ ...base, pendingTenant: { domainId: DEFAULT_DOMAIN_ID, nonce } });
		expect(blob.pendingTenant).toEqual({ domainId: DEFAULT_DOMAIN_ID, nonce });
	});

	it("omits pendingTenant on a re-provision (rooted Domain)", () => {
		const blob = buildProvisioningBlob(base);
		expect(blob.pendingTenant).toBeUndefined();
	});

	it("rejects a base64url nonce in pendingTenant (guards the Phase 3 bug at the schema)", () => {
		expect(() =>
			buildProvisioningBlob({ ...base, pendingTenant: { domainId: DEFAULT_DOMAIN_ID, nonce: "ab-cd_ef" } }),
		).toThrow();
	});
});
