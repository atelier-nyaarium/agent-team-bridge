import { afterEach, describe, expect, it } from "vitest";
import { CrossDomainHandshakeCoordinator, type XDomainCommitWire } from "../gateway/federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import {
	cleanupTmpDirs,
	commitmentOf,
	type Domain,
	expectedSas,
	makeDomain,
	PIN,
	partyOf,
	selfFor,
	signLinkSide,
	tmp,
} from "./helpers/cross-domain-handshake.js";

afterEach(cleanupTmpDirs);

////////////////////////////////
//  Receiver role: listen -> commit -> reveal -> confirm

describe("CrossDomainHandshakeCoordinator - receiver role", () => {
	it("mints a listening token prefixed with this Gateway's id, returning its own keys", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });

		const r = coord.listen();
		expect(r.listeningToken.startsWith("sakura-laptop.")).toBe(true);
		expect(r.receiverOwnerSignPub).toBe(recv.owner.sign.pub);
		expect(r.receiverGatewaySignPub).toBe(recv.gateway.sign.pub);
		expect(r.receiverGatewayBoxPub).toBe(recv.gateway.box.pub);
		expect(r.receiverDomainId).toBe("alice");
		expect(r.receiverGatewayId).toBe("sakura-laptop");
		expect(r.expiresAt).toBeGreaterThan(Date.now());
		expect(coord.openCount).toBe(1);
	});

	it("refuses to listen without a Domain owner", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const coord = new CrossDomainHandshakeCoordinator({
			self: { ...selfFor(recv), ownerSignPub: () => null },
			peers: new CrossDomainPeers(tmp()),
		});
		expect(() => coord.listen()).toThrow(/no Domain owner/);
	});

	it("round 1 returns a commitment (no keys); round 2 verifies the reveal and returns the SAS", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		const token = coord.listen().listeningToken;

		// Round 1: the requester sends its commitment; the receiver returns ITS commitment.
		const requesterParty = partyOf(req);
		const requesterSalt = "cmVxLXNhbHQ";
		const requesterCommitment = commitmentOf(requesterParty, requesterSalt);
		const commitReply = coord.handleIncomingCommit({ listeningToken: token, pin: PIN, requesterCommitment });
		expect(commitReply.receiverCommitment).toMatch(/.+/);
		// The reply carries NO keys (the receiver has not revealed yet).
		expect(Object.keys(commitReply)).toEqual(["receiverCommitment"]);

		// Round 2: the requester reveals; the receiver verifies and returns its reveal + SAS.
		const revealReply = coord.handleIncomingReveal({
			listeningToken: token,
			pin: PIN,
			requesterParty,
			requesterSalt,
		});
		expect(revealReply.sas).toBe(expectedSas(recv, req, PIN));
		expect(revealReply.receiverParty.ownerSignPub).toBe(recv.owner.sign.pub);
		// The receiver's reveal must reproduce the commitment it sent in round 1.
		expect(commitmentOf(revealReply.receiverParty, revealReply.receiverSalt)).toBe(commitReply.receiverCommitment);
	});

	it("rejects a commit for an unknown / closed token (no unsolicited surface)", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		expect(() =>
			coord.handleIncomingCommit({
				listeningToken: "sakura-laptop.never-minted",
				pin: PIN,
				requesterCommitment: commitmentOf(partyOf(req), "s"),
			}),
		).toThrow(/no open listening window/);
	});

	it("rejects a reveal whose keys do not match the round-1 commitment (the binding)", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		const token = coord.listen().listeningToken;

		// Commit to req's keys...
		coord.handleIncomingCommit({
			listeningToken: token,
			pin: PIN,
			requesterCommitment: commitmentOf(partyOf(req), "cmVxLXNhbHQ"),
		});
		// ...then reveal a DIFFERENT party (a substituted box key) under the same salt.
		const substituted = { ...partyOf(req), gatewayBoxPub: "c3Vic3RpdHV0ZWQtYm94" };
		expect(() =>
			coord.handleIncomingReveal({
				listeningToken: token,
				pin: PIN,
				requesterParty: substituted,
				requesterSalt: "cmVxLXNhbHQ",
			}),
		).toThrow(/does not match its commitment/);
	});

	it("rejects a reveal under a wrong salt (the salt is part of the commitment)", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		const token = coord.listen().listeningToken;
		coord.handleIncomingCommit({
			listeningToken: token,
			pin: PIN,
			requesterCommitment: commitmentOf(partyOf(req), "cmVxLXNhbHQ"),
		});
		expect(() =>
			coord.handleIncomingReveal({
				listeningToken: token,
				pin: PIN,
				requesterParty: partyOf(req),
				requesterSalt: "d3Jvbmctc2FsdA",
			}),
		).toThrow(/does not match its commitment/);
	});

	it("rejects a reveal with no prior commitment for the pin", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		const token = coord.listen().listeningToken;
		expect(() =>
			coord.handleIncomingReveal({
				listeningToken: token,
				pin: PIN,
				requesterParty: partyOf(req),
				requesterSalt: "s",
			}),
		).toThrow(/no matching commitment/);
	});

	it("is single-flight: a second commit on a pairing window is rejected", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		const token = coord.listen().listeningToken;
		const commit = (pin: string): XDomainCommitWire => ({
			listeningToken: token,
			pin,
			requesterCommitment: commitmentOf(partyOf(req), `salt-${pin}`),
		});
		coord.handleIncomingCommit(commit(PIN));
		expect(() => coord.handleIncomingCommit(commit("c2Vjb25kLXBpbg"))).toThrow(/already pairing/);
	});

	it("caps pairing attempts and invalidates the token on the cap (full restart)", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({
			self: selfFor(recv),
			peers: new CrossDomainPeers(tmp()),
			maxAttempts: 3,
		});
		const token = coord.listen().listeningToken;
		const token2 = coord.listen().listeningToken;
		const attempt = (t: string): XDomainCommitWire => ({
			listeningToken: t,
			pin: `${Math.random()}`,
			requesterCommitment: commitmentOf(partyOf(req), `${Math.random()}`),
		});
		// First commit pairs token2; subsequent commits hit single-flight (still counting attempts).
		coord.handleIncomingCommit(attempt(token2)); // attempts=1, pairs
		expect(() => coord.handleIncomingCommit(attempt(token2))).toThrow(/already pairing/); // 2
		expect(() => coord.handleIncomingCommit(attempt(token2))).toThrow(/already pairing/); // 3
		// The 4th exceeds maxAttempts=3 and invalidates the token before the single-flight check.
		expect(() => coord.handleIncomingCommit(attempt(token2))).toThrow(/too many pairing attempts/);
		// Token is gone now: a further commit reports the closed window.
		expect(() => coord.handleIncomingCommit(attempt(token2))).toThrow(/no open listening window/);
		// The unrelated first token is unaffected.
		expect(() => coord.handleIncomingCommit(attempt(token))).not.toThrow();
	});

	it("a fresh commit after expiry is rejected (TTL sweep closes the window)", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		let t = 1_000_000;
		const coord = new CrossDomainHandshakeCoordinator({
			self: selfFor(recv),
			peers: new CrossDomainPeers(tmp()),
			ttlMs: 600_000,
			now: () => t,
		});
		const token = coord.listen().listeningToken;
		t += 600_001; // past the window
		expect(() =>
			coord.handleIncomingCommit({
				listeningToken: token,
				pin: PIN,
				requesterCommitment: commitmentOf(partyOf(req), "s"),
			}),
		).toThrow(/no open listening window/);
		expect(coord.openCount).toBe(0);
	});

	it("confirm writes the friend as a cross-Domain peer after the local link verifies (Model A)", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const peers = new CrossDomainPeers(tmp());
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers });
		runReceiverRounds(coord, recv, req, PIN);

		// The receiver phone signs only ITS OWN side (binding the friend's keys from the pairing);
		// the friend confirms independently with their own side. No friend-link is exchanged.
		const mySide = signLinkSide(recv, req);
		const result = coord.confirm({ pin: PIN, mySignedLink: mySide });
		expect(result.ok).toBe(true);

		const stored = peers.resolveByGateway("bob", "bob-desktop");
		expect(stored).not.toBeNull();
		expect(stored?.friendOwnerSignPub).toBe(req.owner.sign.pub);
		expect(stored?.friendSignPub).toBe(req.gateway.sign.pub);
		expect(stored?.friendBoxPub).toBe(req.gateway.box.pub);
		// The stored link is the LOCAL owner's own side (verifiable under THIS owner's key).
		expect(stored?.link).toEqual(mySide);
		// The pairing was consumed: the window is closed.
		expect(coord.openCount).toBe(0);
	});

	it("confirm rejects an own link not signed by this Domain's owner", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const imposter = makeDomain("alice", "sakura-laptop"); // same ids, different owner key
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		runReceiverRounds(coord, recv, req, PIN);
		// The "own" side is signed by an IMPOSTER owner, not this Gateway's admitted owner key.
		const mySide = signLinkSide(imposter, req);
		expect(() => coord.confirm({ pin: PIN, mySignedLink: mySide })).toThrow(
			/did not verify under this Domain's owner key/,
		);
	});

	it("confirm rejects an own link that does not bind the friend's keys", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const otherFriend = makeDomain("bob", "bob-desktop"); // owner-signed, but binds the WRONG gateway keys
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		runReceiverRounds(coord, recv, req, PIN);
		// Correctly signed by our owner, but binds otherFriend's keys, not the paired friend's.
		const mySide = signLinkSide(recv, otherFriend);
		expect(() => coord.confirm({ pin: PIN, mySignedLink: mySide })).toThrow(/does not bind the friend's keys/);
	});

	it("confirm without a pairing for the pin is rejected (single-use)", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		const mySide = signLinkSide(recv, req);
		expect(() => coord.confirm({ pin: "no-such-pin", mySignedLink: mySide })).toThrow(/no pending pairing/);
	});

	it("a confirmed pin cannot be confirmed twice (the pairing is consumed)", () => {
		const recv = makeDomain("alice", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		runReceiverRounds(coord, recv, req, PIN);
		const mySide = signLinkSide(recv, req);
		coord.confirm({ pin: PIN, mySignedLink: mySide });
		expect(() => coord.confirm({ pin: PIN, mySignedLink: mySide })).toThrow(/no pending pairing/);
	});
});

/** Drive a receiver coordinator's two rounds with an honest requester so a `confirm` test
 * can start from a paired window, mirroring what the Router relay feeds. */
function runReceiverRounds(coord: CrossDomainHandshakeCoordinator, recv: Domain, req: Domain, pin: string): void {
	// Find the open token by minting one (the test created the coordinator fresh + listened).
	const token = coord.listen().listeningToken;
	const requesterParty = partyOf(req);
	const salt = "cmVxLXNhbHQtZml4ZWQ";
	coord.handleIncomingCommit({ listeningToken: token, pin, requesterCommitment: commitmentOf(requesterParty, salt) });
	coord.handleIncomingReveal({ listeningToken: token, pin, requesterParty, requesterSalt: salt });
}
