import { describe, expect, it } from "vitest";
import { EnrollmentCoordinator, inMemoryEnrollmentStore } from "../federation-server/enrollmentCoordinator.js";
import type { EnrollmentState } from "../federation-server/federationSecret.js";
import { signAdmission } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";

const evie = generateIdentity();
const owner = generateIdentity();
const now = 1_000_000;

function coordinator(initial?: EnrollmentState) {
	return new EnrollmentCoordinator(evie, inMemoryEnrollmentStore(initial), "alice");
}

describe("EnrollmentCoordinator enroll-owner", () => {
	it("mint then redeem roots the Domain at the owner key", () => {
		const c = coordinator();
		expect(c.rooted).toBe(false);
		expect(c.getDomainSnapshot()).toBeNull();
		const payload = c.mintEnrollOwner("alice", "https://evie", now);
		expect(payload.evieSignPub).toBe(evie.sign.pub);
		const denied = c.redeemEnrollOwner(payload.nonce, owner.sign.pub, owner.box.pub, now + 1000);
		expect(denied).toBeNull();
		expect(c.rooted).toBe(true);
		expect(c.getDomainSnapshot()).toMatchObject({ ownerSignPub: owner.sign.pub });
	});

	it("rejects an unknown nonce", () => {
		const c = coordinator();
		expect(c.redeemEnrollOwner("never-minted", owner.sign.pub, owner.box.pub, now)).toMatch(/unknown/);
		expect(c.rooted).toBe(false);
	});

	it("rejects an expired nonce", () => {
		const c = coordinator();
		const payload = c.mintEnrollOwner("alice", "https://evie", now);
		const denied = c.redeemEnrollOwner(payload.nonce, owner.sign.pub, owner.box.pub, now + 600_001);
		expect(denied).toMatch(/expired/);
		expect(c.rooted).toBe(false);
	});

	it("a nonce is single-use", () => {
		const c = coordinator();
		const payload = c.mintEnrollOwner("alice", "https://evie", now);
		expect(c.redeemEnrollOwner(payload.nonce, owner.sign.pub, owner.box.pub, now)).toBeNull();
		const second = generateIdentity();
		expect(c.redeemEnrollOwner(payload.nonce, second.sign.pub, second.box.pub, now)).toMatch(/already-redeemed/);
		expect(c.getDomainSnapshot()?.ownerSignPub).toBe(owner.sign.pub);
	});

	it("refuses to re-root at a different owner", () => {
		const c = coordinator();
		const p1 = c.mintEnrollOwner("alice", "https://evie", now);
		c.redeemEnrollOwner(p1.nonce, owner.sign.pub, owner.box.pub, now);
		const intruder = generateIdentity();
		const p2 = c.mintEnrollOwner("alice", "https://evie", now);
		expect(c.redeemEnrollOwner(p2.nonce, intruder.sign.pub, intruder.box.pub, now)).toMatch(/different owner/);
		expect(c.getDomainSnapshot()?.ownerSignPub).toBe(owner.sign.pub);
	});

	it("fires the QR cleanup when the nonce is redeemed", () => {
		const c = coordinator();
		const p = c.mintEnrollOwner("alice", "https://evie", now);
		let deleted = false;
		c.registerNonceCleanup(p.nonce, () => {
			deleted = true;
		});
		expect(c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now)).toBeNull();
		expect(deleted).toBe(true);
	});

	it("fires the cleanup even on an expired redeem (the QR is dead either way)", () => {
		const c = coordinator();
		const p = c.mintEnrollOwner("alice", "https://evie", now);
		let deleted = false;
		c.registerNonceCleanup(p.nonce, () => {
			deleted = true;
		});
		expect(c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now + 600_001)).toMatch(/expired/);
		expect(deleted).toBe(true);
	});

	it("a throwing cleanup does not break redeem", () => {
		const c = coordinator();
		const p = c.mintEnrollOwner("alice", "https://evie", now);
		c.registerNonceCleanup(p.nonce, () => {
			throw new Error("DM already gone");
		});
		expect(c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now)).toBeNull();
		expect(c.rooted).toBe(true);
	});
});

describe("EnrollmentCoordinator allowlist", () => {
	function admission(gatewayId: string) {
		return {
			kind: "gateway" as const,
			signPub: generateIdentity().sign.pub,
			boxPub: generateIdentity().box.pub,
			gatewayId,
			issuedAt: 1000,
			nonce: "bm9uY2U=",
		};
	}

	it("admit before rooting is refused", () => {
		const c = coordinator();
		const signed = signAdmission(admission("laptop"), owner.sign.priv, owner.sign.pub);
		expect(c.admit(signed)).toMatch(/not rooted/);
	});

	it("admits an owner-signed admission and surfaces revocations in the trust", () => {
		const c = coordinator();
		const p = c.mintEnrollOwner("alice", "https://evie", now);
		c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		const signed = signAdmission(admission("laptop"), owner.sign.priv, owner.sign.pub);
		expect(c.admit(signed)).toBeNull();
		const attacker = generateIdentity();
		const forged = signAdmission(admission("laptop"), attacker.sign.priv, attacker.sign.pub);
		expect(c.admit(forged)).toMatch(/not owner-signed/);
	});

	function rooted() {
		const c = coordinator();
		const p = c.mintEnrollOwner("alice", "https://evie", now);
		c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		return c;
	}

	it("rejects a structurally-invalid admission even when owner-signed", () => {
		const c = rooted();
		const id = generateIdentity();
		const hostNoId = signAdmission(
			{ kind: "gateway", signPub: id.sign.pub, boxPub: id.box.pub, issuedAt: 1, nonce: "YQ==" },
			owner.sign.priv,
			owner.sign.pub,
		);
		expect(c.admit(hostNoId)).toMatch(/gateway admission missing gatewayId/);
		const deviceWithHost = signAdmission(
			{ kind: "console", signPub: id.sign.pub, boxPub: id.box.pub, gatewayId: "x", issuedAt: 1, nonce: "Yg==" },
			owner.sign.priv,
			owner.sign.pub,
		);
		expect(c.admit(deviceWithHost)).toMatch(/must not carry a gatewayId/);
	});

	it("is idempotent: a re-submitted admission does not duplicate", () => {
		const c = rooted();
		const signed = signAdmission(admission("laptop"), owner.sign.priv, owner.sign.pub);
		expect(c.admit(signed)).toBeNull();
		expect(c.admit(signed)).toBeNull();
		expect(c.getDomainSnapshot()?.admissions).toHaveLength(1);
	});

	it("persists the root so a reloaded coordinator is already rooted", () => {
		const store = inMemoryEnrollmentStore();
		const c1 = new EnrollmentCoordinator(evie, store, "alice");
		const p = c1.mintEnrollOwner("alice", "https://evie", now);
		c1.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		const c2 = new EnrollmentCoordinator(evie, store, "alice");
		expect(c2.rooted).toBe(true);
		expect(c2.getDomainSnapshot()?.ownerSignPub).toBe(owner.sign.pub);
	});
});

describe("EnrollmentCoordinator domain status + display name (friend onboarding)", () => {
	it("getDomainStatus reflects unrooted / pending / rooted", () => {
		const unrooted = new EnrollmentCoordinator(evie, inMemoryEnrollmentStore(), "alice");
		expect(unrooted.getDomainStatus()).toBe("unrooted");
		expect(unrooted.displayName).toBeNull();

		const pending = new EnrollmentCoordinator(
			evie,
			inMemoryEnrollmentStore({
				ownerSignPub: null,
				ownerBoxPub: null,
				admissions: [],
				revocations: [],
				displayName: "Carol",
				pendingTenant: { displayName: "Carol", nonce: "aW52aXRl", issuedAt: 1, ttlMs: 60_000, rooted: false },
			}),
			"alice",
		);
		expect(pending.getDomainStatus()).toBe("pending");
		expect(pending.displayName).toBe("Carol");
		expect(pending.getDomainSnapshot()).toBeNull();

		const c = new EnrollmentCoordinator(evie, inMemoryEnrollmentStore(), "alice");
		const p = c.mintEnrollOwner("alice", "https://evie", now);
		c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		expect(c.getDomainStatus()).toBe("rooted");
	});

	it("getDomainSnapshot carries the displayName once rooted", () => {
		const c = new EnrollmentCoordinator(
			evie,
			inMemoryEnrollmentStore({
				ownerSignPub: owner.sign.pub,
				ownerBoxPub: owner.box.pub,
				admissions: [],
				revocations: [],
				displayName: "Nyaarium",
			}),
			"alice",
		);
		expect(c.getDomainSnapshot()?.displayName).toBe("Nyaarium");
		expect(c.displayName).toBe("Nyaarium");
	});
});
