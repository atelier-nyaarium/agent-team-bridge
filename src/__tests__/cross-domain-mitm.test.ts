import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CrossDomainHandshakeCoordinator,
	type CrossDomainRouter,
	type CrossDomainSelf,
	type XDomainCommitReplyWire,
	type XDomainCommitWire,
	type XDomainRevealReplyWire,
	type XDomainRevealWire,
} from "../gateway/federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import {
	type CrossDomainParty,
	crossDomainCommitment,
	crossDomainSas,
	verifyCrossDomainCommitment,
} from "../shared/cross-domain-sas.js";
import { generateIdentity, type Identity } from "../shared/crypto.js";

////////////////////////////////
//  MITM-closure proof for the commit-reveal SAS-AKE
//
//  The old SAS covered only the public keys plus the pin with no commitment, so a
//  content-blind Router could substitute its own keys on both legs and grind offline
//  until both phones showed the same code (a double-MITM). These tests reproduce the
//  attack and assert it fails: a reveal that does not hash to its commitment is rejected,
//  and the commitment forces the Router to fix its keys before it learns the peer's, so
//  it cannot search for a colliding SAS.

////////////////////////////////
//  Fixtures

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "xdomain-mitm-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface Domain {
	owner: Identity;
	gateway: Identity;
	domainId: string;
	gatewayId: string;
}
function makeDomain(domainId: string, gatewayId: string): Domain {
	return { owner: generateIdentity(), gateway: generateIdentity(), domainId, gatewayId };
}
function selfFor(d: Domain): CrossDomainSelf {
	return {
		ownerSignPub: () => d.owner.sign.pub,
		gatewaySignPub: d.gateway.sign.pub,
		gatewayBoxPub: d.gateway.box.pub,
		domainId: d.domainId,
		gatewayId: d.gatewayId,
	};
}
function partyOf(d: Domain): CrossDomainParty {
	return {
		ownerSignPub: d.owner.sign.pub,
		gatewaySignPub: d.gateway.sign.pub,
		gatewayBoxPub: d.gateway.box.pub,
		domainId: d.domainId,
		gatewayId: d.gatewayId,
	};
}

const PIN = "cGluLXJlbmRlenZvdXM";

////////////////////////////////
//  (a) A reveal not matching its commitment is rejected

describe("commit-reveal binding: a reveal must reproduce the earlier commitment", () => {
	it("the RECEIVER rejects a requester reveal whose keys do not hash to the round-1 commitment", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const honest = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		const token = coord.listen().listeningToken;

		// Round 1: the requester commits to its HONEST keys.
		const honestSalt = "aG9uZXN0LXNhbHQ";
		coord.handleIncomingCommit({
			listeningToken: token,
			pin: PIN,
			requesterCommitment: crossDomainCommitment(partyOf(honest), honestSalt),
		});

		// Round 2: a MITM tries to reveal SUBSTITUTED keys (its own box key) under the same
		// salt - the hash no longer matches the committed value, so the receiver aborts.
		const mitm = makeDomain("bob", "bob-desktop"); // same ids, attacker keys
		expect(() =>
			coord.handleIncomingReveal({
				listeningToken: token,
				pin: PIN,
				requesterParty: { ...partyOf(honest), gatewayBoxPub: mitm.gateway.box.pub },
				requesterSalt: honestSalt,
			}),
		).toThrow(/does not match its commitment/);
	});

	it("the REQUESTER rejects a receiver reveal that does not match the receiver's round-1 commitment", async () => {
		const requester = makeDomain("bob", "bob-desktop");
		const receiver = makeDomain("alice", "sakura-laptop");
		const mitm = makeDomain("alice", "sakura-laptop"); // same ids, attacker keys

		// A Router that commits to the receiver's HONEST keys in round 1 but reveals its OWN
		// substituted keys in round 2 (a late substitution after committing).
		const honestSalt = "cmVjdi1zYWx0";
		const route: CrossDomainRouter = {
			sendCommit: async (): Promise<XDomainCommitReplyWire> => ({
				receiverCommitment: crossDomainCommitment(partyOf(receiver), honestSalt),
			}),
			sendReveal: async (): Promise<XDomainRevealReplyWire> => {
				const substituted: CrossDomainParty = { ...partyOf(receiver), gatewayBoxPub: mitm.gateway.box.pub };
				return {
					receiverParty: substituted,
					receiverSalt: honestSalt,
					// The Router even forges a matching SAS over its substituted view; it never gets
					// used because the commitment check fails first.
					sas: crossDomainSas(partyOf(requester), substituted, PIN),
				};
			},
		};
		const coord = new CrossDomainHandshakeCoordinator({
			self: selfFor(requester),
			peers: new CrossDomainPeers(tmp()),
			route,
		});
		await expect(
			coord.request({
				listeningToken: "sakura-laptop.tok",
				pin: PIN,
				requesterOwnerSignPub: requester.owner.sign.pub,
				requesterDomainId: requester.domainId,
				requesterGatewayId: requester.gatewayId,
			}),
		).rejects.toThrow(/reveal does not match its commitment/);
	});
});

////////////////////////////////
//  (b) Two different committed key-sets yield different SAS (the grind is impossible)

describe("the offline grind across both legs is impossible", () => {
	it("a double-MITM cannot make both legs' SAS agree once each side is committed", () => {
		// The honest parties.
		const a = makeDomain("alice", "sakura-laptop"); // listener
		const b = makeDomain("bob", "bob-desktop"); // requester
		// The Router's substituted identity, presented to each honest side in place of the peer.
		const mitm = makeDomain("mitm", "mitm-gw");

		// Each honest side commits to its OWN keys; the MITM forwards those commitments and at
		// reveal swaps in ITS keys. The commitment is fixed before the MITM reveals, so each leg's
		// SAS binds the honest side's real keys against the MITM keys committed to that side
		// (A's leg = SAS(A, mitm-to-A), B's leg = SAS(mitm-to-B, B)). The MITM cannot align the
		// legs, being committed to one key set per leg before it sees the honest reveal. The
		// flat-sort SAS preimage alone is not injective (a within-party field swap collides it),
		// so the commitment timing does the safety work, not the SAS structure.
		const mitmParty = partyOf(mitm);
		const sasOnAsLeg = crossDomainSas(partyOf(a), mitmParty, PIN);
		const sasOnBsLeg = crossDomainSas(mitmParty, partyOf(b), PIN);
		expect(sasOnAsLeg).not.toBe(sasOnBsLeg);

		// The MITM cannot grind its OWN keys to force the legs to agree: changing its key set
		// changes BOTH legs at once. Sample many candidate MITM key sets; none collide the legs.
		for (let i = 0; i < 64; i++) {
			const candidate = partyOf(makeDomain("mitm", "mitm-gw"));
			expect(crossDomainSas(partyOf(a), candidate, PIN)).not.toBe(crossDomainSas(candidate, partyOf(b), PIN));
		}
	});

	it("two different committed key-sets yield different SAS (no second key-set reproduces a target code)", () => {
		const a = makeDomain("alice", "sakura-laptop");
		const b = makeDomain("bob", "bob-desktop");
		const target = crossDomainSas(partyOf(a), partyOf(b), PIN);

		// The grind, simulated: the MITM is committed to A's real keys on B's leg and searches its
		// OWN substituted key sets for one whose SAS(A, candidate) equals the target. The defense
		// is the commitment: committed before it learns the peer's keys, the MITM gets only the
		// single online guess the attempt cap allows, not an offline search. The 6-digit width
		// sets the residual of that one guess (~1-in-10^6), so a small batch essentially never hits.
		let collisions = 0;
		for (let i = 0; i < 256; i++) {
			const candidate = partyOf(makeDomain("x", "y"));
			if (crossDomainSas(partyOf(a), candidate, PIN) === target) collisions++;
		}
		// 256 blind tries against a 10^6 space: expected ~2.6e-4 hits, so >1 collision is a ~3e-8
		// event. Tolerate the rare single hit to stay non-flaky; the security claim is the committed
		// single-guess, not zero collisions across a batch.
		expect(collisions).toBeLessThanOrEqual(1);
	});

	it("an honest end-to-end pairing yields the SAME SAS on both sides (no false abort)", async () => {
		const a = makeDomain("alice", "sakura-laptop"); // receiver
		const b = makeDomain("bob", "bob-desktop"); // requester
		const coordA = new CrossDomainHandshakeCoordinator({ self: selfFor(a), peers: new CrossDomainPeers(tmp()) });
		const coordB = new CrossDomainHandshakeCoordinator({
			self: selfFor(b),
			peers: new CrossDomainPeers(tmp()),
			route: {
				sendCommit: async (_gw, req: XDomainCommitWire) => coordA.handleIncomingCommit(req),
				sendReveal: async (_gw, req: XDomainRevealWire) => coordA.handleIncomingReveal(req),
			},
		});
		const token = coordA.listen().listeningToken;
		const result = await coordB.request({
			listeningToken: token,
			pin: PIN,
			requesterOwnerSignPub: b.owner.sign.pub,
			requesterDomainId: b.domainId,
			requesterGatewayId: b.gatewayId,
		});
		// Honest: the requester's recomputed SAS matches, and it equals the canonical SAS over
		// both real parties. A's stored pairing carries the same SAS for the human compare.
		expect(result.sas).toBe(crossDomainSas(partyOf(a), partyOf(b), PIN));
	});
});

////////////////////////////////
//  The commitment is hiding (the salt prevents pre-image guessing of the public keys)

describe("the commitment hides the committed keys", () => {
	it("the same keys with different salts produce unrelated commitments", () => {
		const d = makeDomain("alice", "sakura-laptop");
		const c1 = crossDomainCommitment(partyOf(d), "c2FsdC1vbmU");
		const c2 = crossDomainCommitment(partyOf(d), "c2FsdC10d28");
		expect(c1).not.toBe(c2);
		// And neither salt verifies the other's commitment.
		expect(verifyCrossDomainCommitment(c1, partyOf(d), "c2FsdC10d28")).toBe(false);
	});
});
