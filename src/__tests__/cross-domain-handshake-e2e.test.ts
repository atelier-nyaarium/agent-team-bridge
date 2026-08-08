import { afterEach, describe, expect, it } from "vitest";
import { CrossDomainHandshakeCoordinator } from "../gateway/federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import {
	cleanupTmpDirs,
	directRoute,
	expectedSas,
	makeDomain,
	PIN,
	selfFor,
	signLinkSide,
	tmp,
} from "./helpers/cross-domain-handshake.js";

afterEach(cleanupTmpDirs);

////////////////////////////////
//  End-to-end: two coordinators (one per Domain) pair through a shared Router

describe("CrossDomainHandshakeCoordinator - two-Gateway end to end", () => {
	it("the link COMPLETES on both sides: B drives the exchange, A learns the pairing via listenState, both confirm independently and both peer sets populate", async () => {
		const a = makeDomain("alice", "sakura-laptop"); // receiver / listener
		const b = makeDomain("bob", "bob-desktop"); // requester
		const peersA = new CrossDomainPeers(tmp());
		const peersB = new CrossDomainPeers(tmp());

		const coordA = new CrossDomainHandshakeCoordinator({ self: selfFor(a), peers: peersA });
		// B routes both rounds straight into A's receiver legs (the Router is a wire here).
		const coordB = new CrossDomainHandshakeCoordinator({
			self: selfFor(b),
			peers: peersB,
			route: directRoute(coordA),
		});

		// A opens a window and reads the token to B out of band.
		const token = coordA.listen().listeningToken;

		// Before B pairs, A's poll sees nothing yet (the receiver is blind until round 2 lands).
		const beforePairing = coordA.listenState(token);
		expect(beforePairing.pairingArrived).toBe(false);
		expect(beforePairing.sas).toBeUndefined();
		expect(beforePairing.expiresAt).toBeGreaterThan(0);

		// B requests against A's token (the gateway drives the full commit-reveal exchange).
		const bResult = await coordB.request({
			listeningToken: token,
			pin: PIN,
			requesterOwnerSignPub: b.owner.sign.pub,
			requesterDomainId: b.domainId,
			requesterGatewayId: b.gatewayId,
		});
		// Both sides see the SAME SAS (the anti-MITM property).
		expect(bResult.sas).toBe(expectedSas(a, b, PIN));

		// THE RECEIVER LEARNS THE PAIRING: A polls listenState and now sees the SAS + B's keys, so
		// the receiver phone can show the SAS and owner-sign its own link over B's keys.
		const arrived = coordA.listenState(token);
		expect(arrived.pairingArrived).toBe(true);
		// The receiver's SAS matches what the requester computed (the two humans compare one code).
		expect(arrived.sas).toBe(bResult.sas);
		// listenState surfaces exactly the friend keys A must sign its link over.
		expect(arrived.friendOwnerSignPub).toBe(b.owner.sign.pub);
		expect(arrived.friendGatewaySignPub).toBe(b.gateway.sign.pub);
		expect(arrived.friendGatewayBoxPub).toBe(b.gateway.box.pub);
		expect(arrived.friendDomainId).toBe("bob");
		expect(arrived.friendGatewayId).toBe("bob-desktop");
		// The receiver learns the (requester-minted) pin so it can confirm its own pairing.
		expect(arrived.pin).toBe(PIN);
		// listenState is read-only: a second poll still shows the pairing (it did not consume it).
		expect(coordA.listenState(token).pairingArrived).toBe(true);

		// The humans matched; each owner confirms INDEPENDENTLY with only its OWN signed link side.
		// A signs over B's keys (which it got from listenState) and confirms with the pin it learned;
		// B signs over A's keys (from request) and confirms with the pin it minted.
		if (!arrived.pin) throw new Error("receiver did not learn the pin");
		expect(coordA.confirm({ pin: arrived.pin, mySignedLink: signLinkSide(a, b) }).ok).toBe(true);
		expect(coordB.confirm({ pin: PIN, mySignedLink: signLinkSide(b, a) }).ok).toBe(true);

		// A now trusts B; B now trusts A. The disjoint peer sets are the handshake's only writes,
		// and each stores its OWN owner's attestation.
		const aPeer = peersA.resolveByGateway("bob", "bob-desktop");
		const bPeer = peersB.resolveByGateway("alice", "sakura-laptop");
		expect(aPeer?.friendOwnerSignPub).toBe(b.owner.sign.pub);
		expect(aPeer?.link.link.myOwnerSignPub).toBe(a.owner.sign.pub); // A stored A's own side
		expect(bPeer?.friendOwnerSignPub).toBe(a.owner.sign.pub);
		expect(bPeer?.link.link.myOwnerSignPub).toBe(b.owner.sign.pub); // B stored B's own side
		expect(coordA.openCount).toBe(0);
		expect(coordB.openCount).toBe(0);

		// The window is consumed by confirm: a later poll reports it gone.
		expect(coordA.listenState(token)).toEqual({ pairingArrived: false, expired: true });
	});
});
