import { describe, expect, it } from "vitest";
import { bootstrapDomain } from "../../scripts/bootstrap-domain.js";
import { type Admission, type SignedAdmission, signAdmission } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";
import { DEFAULT_DOMAIN_ID } from "../shared/domain-id.js";

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
		const { federationJson } = bootstrapDomain(v2Secret(), owner.sign.pub, owner.box.pub);
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
		const { federationJson } = bootstrapDomain(v2Secret(), owner.sign.pub, owner.box.pub);
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
		const { federationJson } = bootstrapDomain(v2Secret(), otherOwner.sign.pub, otherOwner.box.pub);
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
		const { federationJson } = bootstrapDomain(secret, owner.sign.pub, owner.box.pub);
		const keys = Object.keys((federationJson as { enrollment: Record<string, unknown> }).enrollment).sort();
		expect(keys).toEqual(["home", "lab", "work"]);
	});

	it("first-root on a fresh v2 empty-map Secret writes the home slice in v2 shape", () => {
		// evie's KubeSecretStore.init writes { schema:2, identity, enrollment:{} } on first
		// boot; rooting must produce a v2 blob with just the home slice.
		const fresh = JSON.stringify({ schema: 2, identity: evie, enrollment: {} });
		const { federationJson } = bootstrapDomain(fresh, owner.sign.pub, owner.box.pub);
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
		const { federationJson } = bootstrapDomain(v1, owner.sign.pub, owner.box.pub);
		// v1 output: NO schema marker, enrollment is the single state (not a map).
		expect((federationJson as { schema?: number }).schema).toBeUndefined();
		const enrollment = federationJson.enrollment as { ownerSignPub: string; admissions: SignedAdmission[] };
		expect(enrollment.ownerSignPub).toBe(owner.sign.pub);
		// Same-owner: the admission is preserved on the v1 path too.
		expect(enrollment.admissions).toHaveLength(1);
	});

	it("preserves evie's identity verbatim (rooting must not change evie's SAS)", () => {
		const { federationJson } = bootstrapDomain(v2Secret(), owner.sign.pub, owner.box.pub);
		expect(federationJson.identity.sign.pub).toBe(evie.sign.pub);
		expect(federationJson.identity.sign.priv).toBe(evie.sign.priv);
	});

	it("rejects a malformed owner key with an actionable error", () => {
		expect(() => bootstrapDomain(v2Secret(), "not-a-key", owner.box.pub)).toThrow(/32-byte key/);
	});
});
