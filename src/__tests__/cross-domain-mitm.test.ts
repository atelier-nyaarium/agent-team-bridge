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
//  The fixed vulnerability: the old SAS was over only the public keys + the pin, all
//  relayed by the content-blind Router with no commitment. A malicious Router could
//  substitute its own keys on BOTH legs and grind offline until both phones showed the
//  SAME short code, a full double-MITM. These tests reproduce the attack against the
//  commit-reveal exchange and assert it now FAILS: a reveal that does not hash to the
//  earlier commitment is rejected, and the commitment forces the Router to fix its
//  substituted keys BEFORE it learns the peer's, so it cannot search for a colliding SAS.

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
		const recv = makeDomain("home", "sakura-laptop");
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
		const receiver = makeDomain("home", "sakura-laptop");
		const mitm = makeDomain("home", "sakura-laptop"); // same ids, attacker keys

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
		const a = makeDomain("home", "sakura-laptop"); // listener
		const b = makeDomain("bob", "bob-desktop"); // requester
		// The Router's substituted identity, presented to each honest side in place of the peer.
		const mitm = makeDomain("mitm", "mitm-gw");

		// The exchange the HONEST sides actually run is: each side commits to its OWN keys, the
		// MITM forwards those commitments, and at reveal the MITM swaps in ITS keys. The
		// commitment is fixed BEFORE the MITM reveals, so on each leg the SAS the honest side
		// computes is over (its real keys, the MITM's keys). The MITM controls its own keys but
		// must use the SAME committed keys it sent each side, so:
		//
		//   A's leg SAS = SAS(A, mitm-as-seen-by-A)   // A's honest keys + the MITM keys to A
		//   B's leg SAS = SAS(mitm-as-seen-by-B, B)   // the MITM keys to B + B's honest keys
		//
		// For the double-MITM to go undetected, A's SAS must equal B's SAS. The ACTUAL defense is
		// the commit-reveal ordering (the test above): the MITM is committed to ONE key set per leg
		// before it sees the honest reveal, so it cannot align the legs - A's SAS binds A's real
		// keys, B's SAS binds B's real keys. (The flat-sort SAS preimage alone is NOT injective - a
		// within-party field swap collides it - so the safety here is the commitment timing doing
		// the work, not the SAS structure.)
		const mitmParty = partyOf(mitm);
		const sasOnAsLeg = crossDomainSas(partyOf(a), mitmParty, PIN);
		const sasOnBsLeg = crossDomainSas(mitmParty, partyOf(b), PIN);
		expect(sasOnAsLeg).not.toBe(sasOnBsLeg);

		// The MITM cannot grind its OWN keys to force the two legs to agree, because changing
		// its key set changes BOTH legs at once (it is committed to one value per leg before it
		// sees the honest reveal). Sample many candidate MITM key sets: none collide the legs.
		for (let i = 0; i < 64; i++) {
			const candidate = partyOf(makeDomain("mitm", "mitm-gw"));
			expect(crossDomainSas(partyOf(a), candidate, PIN)).not.toBe(crossDomainSas(candidate, partyOf(b), PIN));
		}
	});

	it("two different committed key-sets yield different SAS (no second key-set reproduces a target code)", () => {
		const a = makeDomain("home", "sakura-laptop");
		const b = makeDomain("bob", "bob-desktop");
		const target = crossDomainSas(partyOf(a), partyOf(b), PIN);

		// The grind, simulated: the MITM is committed to A's real keys on B's leg and searches
		// over its OWN substituted key sets for one whose SAS(A, candidate) equals the target it
		// wants B to see. The real defense is the COMMITMENT, not the width: because the MITM is
		// committed before it learns the peer's keys, it gets only the single online guess the
		// attempt cap allows, not an offline search. The 6-digit width sets only the residual of
		// that one guess (~1-in-10^6), so a small batch of blind substitutions essentially never
		// reproduces the honest target.
		let collisions = 0;
		for (let i = 0; i < 256; i++) {
			const candidate = partyOf(makeDomain("x", "y"));
			if (crossDomainSas(partyOf(a), candidate, PIN) === target) collisions++;
		}
		// 256 blind tries against a 10^6 space: the expected count is ~2.6e-4, so >1 collision is a
		// ~3e-8 event. Tolerate the astronomically rare single hit to stay non-flaky; the security
		// claim is the committed single-guess, not zero collisions across a batch.
		expect(collisions).toBeLessThanOrEqual(1);
	});

	it("an honest end-to-end pairing yields the SAME SAS on both sides (no false abort)", async () => {
		const a = makeDomain("home", "sakura-laptop"); // receiver
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
		const d = makeDomain("home", "sakura-laptop");
		const c1 = crossDomainCommitment(partyOf(d), "c2FsdC1vbmU");
		const c2 = crossDomainCommitment(partyOf(d), "c2FsdC10d28");
		expect(c1).not.toBe(c2);
		// And neither salt verifies the other's commitment.
		expect(verifyCrossDomainCommitment(c1, partyOf(d), "c2FsdC10d28")).toBe(false);
	});
});
