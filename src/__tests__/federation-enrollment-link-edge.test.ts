import { describe, expect, it } from "vitest";
import {
	dispatchEnrollOp,
	EnrollmentCoordinator,
	inMemoryEnrollmentStore,
} from "../federation-server/enrollmentCoordinator.js";
import type { EnrollmentState } from "../federation-server/federationSecret.js";
import { generateIdentity } from "../shared/crypto.js";
import {
	signXDomainLinkEdge,
	signXDomainLinkRevocation,
	type XDomainLinkEdge,
	type XDomainLinkRevocation,
} from "../shared/federation-lifecycle.js";

const router = generateIdentity();
const owner = generateIdentity();
const now = 1_000_000;

describe("EnrollmentCoordinator cross-Domain link edge", () => {
	function rootedFor(domainId: string) {
		const c = new EnrollmentCoordinator(router, inMemoryEnrollmentStore(), domainId);
		const p = c.mintEnrollOwner(domainId, "https://router", now);
		c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		return c;
	}
	function edge(srcDomainId: string, dstDomainId: string, nonce = "bm9uY2U="): XDomainLinkEdge {
		return { srcDomainId, dstDomainId, issuedAt: 1000, nonce };
	}
	function revocation(srcDomainId: string, dstDomainId: string, nonce = "cmV2b2tl"): XDomainLinkRevocation {
		return { srcDomainId, dstDomainId, revokedAt: 2000, nonce };
	}

	it("adding before rooting is refused", () => {
		const c = new EnrollmentCoordinator(router, inMemoryEnrollmentStore(), "alice");
		const signed = signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(c.addLinkEdge(signed)).toMatch(/not rooted/);
	});

	it("records an owner-signed edge and answers hasLinkEdge for the pair only", () => {
		const c = rootedFor("alice");
		const signed = signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(c.addLinkEdge(signed)).toBeNull();
		expect(c.hasLinkEdge("alice", "carol")).toBe(true);
		expect(c.hasLinkEdge("alice", "dave")).toBe(false);
	});

	it("rejects an edge signed by a non-owner", () => {
		const c = rootedFor("alice");
		const attacker = generateIdentity();
		const forged = signXDomainLinkEdge(edge("alice", "carol"), attacker.sign.priv, attacker.sign.pub);
		expect(c.addLinkEdge(forged)).toMatch(/not owner-signed/);
		expect(c.hasLinkEdge("alice", "carol")).toBe(false);
	});

	it("rejects an edge whose srcDomainId is not this Domain", () => {
		const c = rootedFor("alice");
		const signed = signXDomainLinkEdge(edge("elsewhere", "carol"), owner.sign.priv, owner.sign.pub);
		expect(c.addLinkEdge(signed)).toMatch(/srcDomainId does not match/);
	});

	it("records a NON-admin Domain owner's edge in its OWN coordinator (User-First, no gateway)", () => {
		const guest = rootedFor("guest42");
		const signed = signXDomainLinkEdge(edge("guest42", "alice"), owner.sign.priv, owner.sign.pub);
		expect(guest.addLinkEdge(signed)).toBeNull();
		expect(guest.hasLinkEdge("guest42", "alice")).toBe(true);
		const admin = rootedFor("alice");
		expect(admin.addLinkEdge(signed)).toMatch(/srcDomainId does not match/);
	});

	it("is idempotent on nonce: a re-submitted edge does not duplicate", () => {
		const c = rootedFor("alice");
		const signed = signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(c.addLinkEdge(signed)).toBeNull();
		expect(c.addLinkEdge(signed)).toBeNull();
		expect((c as unknown as { state: EnrollmentState }).state.linkEdges).toHaveLength(1);
	});

	it("dispatchEnrollOp routes submit_xdomain_link to addLinkEdge", () => {
		const c = rootedFor("alice");
		const signed = signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(dispatchEnrollOp(c, { kind: "submit_xdomain_link", edge: signed })).toEqual({ ok: true });
		expect(c.hasLinkEdge("alice", "carol")).toBe(true);
		const attacker = generateIdentity();
		const forged = signXDomainLinkEdge(edge("alice", "dave", "b3RoZXI="), attacker.sign.priv, attacker.sign.pub);
		expect(dispatchEnrollOp(c, { kind: "submit_xdomain_link", edge: forged })).toMatchObject({ ok: false });
	});

	it("persists edges so a reloaded coordinator still gates the pair", () => {
		const store = inMemoryEnrollmentStore();
		const c1 = new EnrollmentCoordinator(router, store, "alice");
		const p = c1.mintEnrollOwner("alice", "https://router", now);
		c1.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		c1.addLinkEdge(signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub));
		const c2 = new EnrollmentCoordinator(router, store, "alice");
		expect(c2.hasLinkEdge("alice", "carol")).toBe(true);
	});

	it("an owner-signed revocation drops the edge so hasLinkEdge goes true -> false", () => {
		const c = rootedFor("alice");
		c.addLinkEdge(signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub));
		expect(c.hasLinkEdge("alice", "carol")).toBe(true);
		const signed = signXDomainLinkRevocation(revocation("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(c.removeLinkEdge(signed)).toBeNull();
		expect(c.hasLinkEdge("alice", "carol")).toBe(false);
	});

	it("revoking before rooting is refused", () => {
		const c = new EnrollmentCoordinator(router, inMemoryEnrollmentStore(), "alice");
		const signed = signXDomainLinkRevocation(revocation("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(c.removeLinkEdge(signed)).toMatch(/not rooted/);
	});

	it("rejects a revocation signed by a non-owner and keeps the edge", () => {
		const c = rootedFor("alice");
		c.addLinkEdge(signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub));
		const attacker = generateIdentity();
		const forged = signXDomainLinkRevocation(revocation("alice", "carol"), attacker.sign.priv, attacker.sign.pub);
		expect(c.removeLinkEdge(forged)).toMatch(/not owner-signed/);
		expect(c.hasLinkEdge("alice", "carol")).toBe(true);
	});

	it("rejects a revocation whose srcDomainId is not this Domain", () => {
		const c = rootedFor("alice");
		const signed = signXDomainLinkRevocation(revocation("elsewhere", "carol"), owner.sign.priv, owner.sign.pub);
		expect(c.removeLinkEdge(signed)).toMatch(/srcDomainId does not match/);
	});

	it("revoking drops ONLY the matching pair; an unrelated edge survives", () => {
		const c = rootedFor("alice");
		c.addLinkEdge(signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub));
		c.addLinkEdge(signXDomainLinkEdge(edge("alice", "dave", "ZWRnZTI="), owner.sign.priv, owner.sign.pub));
		const signed = signXDomainLinkRevocation(revocation("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(c.removeLinkEdge(signed)).toBeNull();
		expect(c.hasLinkEdge("alice", "carol")).toBe(false);
		expect(c.hasLinkEdge("alice", "dave")).toBe(true);
	});

	it("revoking an already-absent edge is an idempotent no-op success", () => {
		const c = rootedFor("alice");
		const signed = signXDomainLinkRevocation(revocation("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(c.removeLinkEdge(signed)).toBeNull();
		expect(c.removeLinkEdge(signed)).toBeNull();
	});

	it("dispatchEnrollOp routes revoke_xdomain_link to removeLinkEdge", () => {
		const c = rootedFor("alice");
		c.addLinkEdge(signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub));
		const signed = signXDomainLinkRevocation(revocation("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(dispatchEnrollOp(c, { kind: "revoke_xdomain_link", revocation: signed })).toEqual({ ok: true });
		expect(c.hasLinkEdge("alice", "carol")).toBe(false);
		const attacker = generateIdentity();
		const forged = signXDomainLinkRevocation(revocation("alice", "dave"), attacker.sign.priv, attacker.sign.pub);
		expect(dispatchEnrollOp(c, { kind: "revoke_xdomain_link", revocation: forged })).toMatchObject({ ok: false });
	});

	it("persists the revocation so a reloaded coordinator no longer gates the pair", () => {
		const store = inMemoryEnrollmentStore();
		const c1 = new EnrollmentCoordinator(router, store, "alice");
		const p = c1.mintEnrollOwner("alice", "https://router", now);
		c1.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		c1.addLinkEdge(signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub));
		c1.removeLinkEdge(signXDomainLinkRevocation(revocation("alice", "carol"), owner.sign.priv, owner.sign.pub));
		const c2 = new EnrollmentCoordinator(router, store, "alice");
		expect(c2.hasLinkEdge("alice", "carol")).toBe(false);
	});

	it("a replayed original edge after a revoke stays revoked (no resurrect)", () => {
		const c = rootedFor("alice");
		const originalEdge = signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(dispatchEnrollOp(c, { kind: "submit_xdomain_link", edge: originalEdge })).toEqual({ ok: true });
		expect(c.hasLinkEdge("alice", "carol")).toBe(true);
		const rev = signXDomainLinkRevocation(revocation("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(dispatchEnrollOp(c, { kind: "revoke_xdomain_link", revocation: rev })).toEqual({ ok: true });
		expect(c.hasLinkEdge("alice", "carol")).toBe(false);

		expect(dispatchEnrollOp(c, { kind: "submit_xdomain_link", edge: originalEdge })).toEqual({ ok: true });
		expect(c.hasLinkEdge("alice", "carol")).toBe(false);
	});

	it("a genuinely NEW edge issued after the revoke re-links (issuedAt > revokedAt)", () => {
		const c = rootedFor("alice");
		c.addLinkEdge(signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub));
		c.removeLinkEdge(signXDomainLinkRevocation(revocation("alice", "carol"), owner.sign.priv, owner.sign.pub));
		expect(c.hasLinkEdge("alice", "carol")).toBe(false);

		const freshEdge: XDomainLinkEdge = {
			srcDomainId: "alice",
			dstDomainId: "carol",
			issuedAt: 3000,
			nonce: "ZnJlc2g=",
		};
		expect(c.addLinkEdge(signXDomainLinkEdge(freshEdge, owner.sign.priv, owner.sign.pub))).toBeNull();
		expect(c.hasLinkEdge("alice", "carol")).toBe(true);
	});

	it("a replayed stale revocation does not sever a newer relink", () => {
		const c = rootedFor("alice");
		c.addLinkEdge(signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub));
		const staleRevoke = signXDomainLinkRevocation(revocation("alice", "carol"), owner.sign.priv, owner.sign.pub);
		expect(c.removeLinkEdge(staleRevoke)).toBeNull();
		const freshEdge: XDomainLinkEdge = {
			srcDomainId: "alice",
			dstDomainId: "carol",
			issuedAt: 3000,
			nonce: "ZnJlc2gy",
		};
		expect(c.addLinkEdge(signXDomainLinkEdge(freshEdge, owner.sign.priv, owner.sign.pub))).toBeNull();
		expect(c.hasLinkEdge("alice", "carol")).toBe(true);

		expect(c.removeLinkEdge(staleRevoke)).toBeNull();
		expect(c.hasLinkEdge("alice", "carol")).toBe(true);
	});

	it("the revocation tombstone survives a reload and still blocks a replayed old edge", () => {
		const store = inMemoryEnrollmentStore();
		const c1 = new EnrollmentCoordinator(router, store, "alice");
		const p = c1.mintEnrollOwner("alice", "https://router", now);
		c1.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		const originalEdge = signXDomainLinkEdge(edge("alice", "carol"), owner.sign.priv, owner.sign.pub);
		c1.addLinkEdge(originalEdge);
		c1.removeLinkEdge(signXDomainLinkRevocation(revocation("alice", "carol"), owner.sign.priv, owner.sign.pub));

		const c2 = new EnrollmentCoordinator(router, store, "alice");
		expect(c2.hasLinkEdge("alice", "carol")).toBe(false);
		expect(c2.addLinkEdge(originalEdge)).toBeNull();
		expect(c2.hasLinkEdge("alice", "carol")).toBe(false);
	});
});
