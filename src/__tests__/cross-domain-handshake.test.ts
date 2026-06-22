import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CrossDomainHandshakeCoordinator,
	type CrossDomainRouter,
	type CrossDomainSelf,
	type XDomainCommitWire,
} from "../gateway/federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { type CrossDomainParty, crossDomainCommitment, crossDomainSas } from "../shared/cross-domain-sas.js";
import { generateIdentity, type Identity } from "../shared/crypto.js";
import { signXDomainLink, type XDomainLink } from "../shared/federation-protocol.js";

////////////////////////////////
//  Fixtures

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "xdomain-handshake-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** One Domain's identity: the phone-held owner root key + the Gateway's keys + ids. */
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

/** Owner-sign a link side binding the FRIEND's keys, as the phone would. `me` is the
 * signing owner's Domain; `friend` is the Domain whose keys the link commits to. */
function signLinkSide(me: Domain, friend: Domain): ReturnType<typeof signXDomainLink> {
	const link: XDomainLink = {
		myOwnerSignPub: me.owner.sign.pub,
		peerOwnerSignPub: friend.owner.sign.pub,
		peerDomainId: friend.domainId,
		peerGatewayId: friend.gatewayId,
		peerSignPub: friend.gateway.sign.pub,
		peerBoxPub: friend.gateway.box.pub,
		issuedAt: 1000,
		nonce: "bm9uY2Ux",
	};
	return signXDomainLink(link, me.owner.sign.priv, me.owner.sign.pub);
}

/** The SAS over both parties + the pin (the order does not matter; the helper sorts). */
function expectedSas(a: Domain, b: Domain, pin: string): string {
	return crossDomainSas(partyOf(a), partyOf(b), pin);
}

/** A Router seam that drives both commit-reveal rounds straight into a receiver
 * coordinator (the Router is a direct wire here). This is exactly how index.ts routes,
 * minus the evie hop. */
function directRoute(receiver: CrossDomainHandshakeCoordinator): CrossDomainRouter {
	return {
		sendCommit: async (_gw, req) => receiver.handleIncomingCommit(req),
		sendReveal: async (_gw, req) => receiver.handleIncomingReveal(req),
	};
}

const PIN = "cGluLXJlbmRlenZvdXM";

////////////////////////////////
//  Receiver role: listen -> commit -> reveal -> confirm

describe("CrossDomainHandshakeCoordinator - receiver role", () => {
	it("mints a listening token prefixed with this Gateway's id, returning its own keys", () => {
		const recv = makeDomain("home", "sakura-laptop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });

		const r = coord.listen();
		expect(r.listeningToken.startsWith("sakura-laptop.")).toBe(true);
		expect(r.receiverOwnerSignPub).toBe(recv.owner.sign.pub);
		expect(r.receiverGatewaySignPub).toBe(recv.gateway.sign.pub);
		expect(r.receiverGatewayBoxPub).toBe(recv.gateway.box.pub);
		expect(r.receiverDomainId).toBe("home");
		expect(r.receiverGatewayId).toBe("sakura-laptop");
		expect(r.expiresAt).toBeGreaterThan(Date.now());
		expect(coord.openCount).toBe(1);
	});

	it("refuses to listen without a Domain owner", () => {
		const recv = makeDomain("home", "sakura-laptop");
		const coord = new CrossDomainHandshakeCoordinator({
			self: { ...selfFor(recv), ownerSignPub: () => null },
			peers: new CrossDomainPeers(tmp()),
		});
		expect(() => coord.listen()).toThrow(/no Domain owner/);
	});

	it("round 1 returns a commitment (no keys); round 2 verifies the reveal and returns the SAS", () => {
		const recv = makeDomain("home", "sakura-laptop");
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
		const recv = makeDomain("home", "sakura-laptop");
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
		const recv = makeDomain("home", "sakura-laptop");
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
		const recv = makeDomain("home", "sakura-laptop");
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
		const recv = makeDomain("home", "sakura-laptop");
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
		const recv = makeDomain("home", "sakura-laptop");
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
		const recv = makeDomain("home", "sakura-laptop");
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
		const recv = makeDomain("home", "sakura-laptop");
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

	it("confirm writes the friend as a cross-Domain peer after both links verify", () => {
		const recv = makeDomain("home", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const peers = new CrossDomainPeers(tmp());
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers });
		runReceiverRounds(coord, recv, req, PIN);

		// The receiver phone signs ITS side (binding the friend's keys); the friend phone
		// signed the receiver's keys.
		const mySide = signLinkSide(recv, req);
		const friendSide = signLinkSide(req, recv);
		const result = coord.confirm({ pin: PIN, mySignedLink: mySide, friendSignedLink: friendSide });
		expect(result.ok).toBe(true);

		const stored = peers.resolveByGateway("bob", "bob-desktop");
		expect(stored).not.toBeNull();
		expect(stored?.friendOwnerSignPub).toBe(req.owner.sign.pub);
		expect(stored?.friendSignPub).toBe(req.gateway.sign.pub);
		expect(stored?.friendBoxPub).toBe(req.gateway.box.pub);
		// The stored link is the FRIEND's side (verifiable under friendOwnerSignPub).
		expect(stored?.link).toEqual(friendSide);
		// The pairing was consumed: the window is closed.
		expect(coord.openCount).toBe(0);
	});

	it("confirm rejects a friend link not signed by the paired friend owner", () => {
		const recv = makeDomain("home", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const imposter = makeDomain("bob", "bob-desktop"); // same ids, different keys
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		runReceiverRounds(coord, recv, req, PIN);
		// The friend side is signed by an IMPOSTER owner, not the owner key in the pairing.
		const mySide = signLinkSide(recv, req);
		const friendSide = signLinkSide(imposter, recv);
		expect(() => coord.confirm({ pin: PIN, mySignedLink: mySide, friendSignedLink: friendSide })).toThrow(
			/did not verify under the friend owner key/,
		);
	});

	it("confirm rejects a friend link that does not bind THIS Gateway's keys", () => {
		const recv = makeDomain("home", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const otherTarget = makeDomain("home", "sakura-laptop"); // friend signed a DIFFERENT gateway's keys
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		runReceiverRounds(coord, recv, req, PIN);
		const mySide = signLinkSide(recv, req);
		// friend correctly signs under their owner, but binds otherTarget's gateway keys.
		const friendSide = signLinkSide(req, otherTarget);
		expect(() => coord.confirm({ pin: PIN, mySignedLink: mySide, friendSignedLink: friendSide })).toThrow(
			/does not bind this Gateway's keys/,
		);
	});

	it("confirm without a pairing for the pin is rejected (single-use)", () => {
		const recv = makeDomain("home", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		const mySide = signLinkSide(recv, req);
		const friendSide = signLinkSide(req, recv);
		expect(() => coord.confirm({ pin: "no-such-pin", mySignedLink: mySide, friendSignedLink: friendSide })).toThrow(
			/no pending pairing/,
		);
	});

	it("a confirmed pin cannot be confirmed twice (the pairing is consumed)", () => {
		const recv = makeDomain("home", "sakura-laptop");
		const req = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		runReceiverRounds(coord, recv, req, PIN);
		const mySide = signLinkSide(recv, req);
		const friendSide = signLinkSide(req, recv);
		coord.confirm({ pin: PIN, mySignedLink: mySide, friendSignedLink: friendSide });
		expect(() => coord.confirm({ pin: PIN, mySignedLink: mySide, friendSignedLink: friendSide })).toThrow(
			/no pending pairing/,
		);
	});
});

////////////////////////////////
//  Requester role: request (via the Router seam) -> confirm

describe("CrossDomainHandshakeCoordinator - requester role", () => {
	it("drives both rounds, cross-checks the SAS, and stores a pending pairing", async () => {
		const requester = makeDomain("bob", "bob-desktop");
		const receiver = makeDomain("home", "sakura-laptop");
		const peers = new CrossDomainPeers(tmp());
		const recvCoord = new CrossDomainHandshakeCoordinator({
			self: selfFor(receiver),
			peers: new CrossDomainPeers(tmp()),
		});
		const token = recvCoord.listen().listeningToken;

		const sendCommit = vi.fn(async (gw: string, req: XDomainCommitWire) => {
			expect(gw).toBe("sakura-laptop"); // routed by the token prefix
			return recvCoord.handleIncomingCommit(req);
		});
		const sendReveal = vi.fn(async (_gw: string, req: Parameters<CrossDomainRouter["sendReveal"]>[1]) =>
			recvCoord.handleIncomingReveal(req),
		);
		const coord = new CrossDomainHandshakeCoordinator({
			self: selfFor(requester),
			peers,
			route: { sendCommit, sendReveal },
		});

		const result = await coord.request({
			listeningToken: token,
			pin: PIN,
			requesterOwnerSignPub: requester.owner.sign.pub,
			requesterDomainId: requester.domainId,
			requesterGatewayId: requester.gatewayId,
		});
		expect(sendCommit).toHaveBeenCalledOnce();
		expect(sendReveal).toHaveBeenCalledOnce();
		expect(result.sas).toBe(expectedSas(receiver, requester, PIN));
		expect(result.receiverGatewaySignPub).toBe(receiver.gateway.sign.pub);
		expect(coord.openCount).toBe(1); // the pending pairing

		// And the requester can confirm: it stores the receiver as a peer.
		const mySide = signLinkSide(requester, receiver);
		const friendSide = signLinkSide(receiver, requester);
		const confirmResult = coord.confirm({ pin: PIN, mySignedLink: mySide, friendSignedLink: friendSide });
		expect(confirmResult.ok).toBe(true);
		expect(peers.resolveByGateway("home", "sakura-laptop")?.friendOwnerSignPub).toBe(receiver.owner.sign.pub);
	});

	it("refuses the request leg when no Router seam is wired", async () => {
		const requester = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({
			self: selfFor(requester),
			peers: new CrossDomainPeers(tmp()),
		});
		await expect(
			coord.request({
				listeningToken: "sakura-laptop.tok",
				pin: PIN,
				requesterOwnerSignPub: requester.owner.sign.pub,
				requesterDomainId: requester.domainId,
				requesterGatewayId: requester.gatewayId,
			}),
		).rejects.toThrow(/routing is not available/);
	});

	it("rejects a token that names our own Gateway", async () => {
		const requester = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({
			self: selfFor(requester),
			peers: new CrossDomainPeers(tmp()),
			route: { sendCommit: vi.fn(), sendReveal: vi.fn() },
		});
		await expect(
			coord.request({
				listeningToken: "bob-desktop.tok", // our own gateway id
				pin: PIN,
				requesterOwnerSignPub: requester.owner.sign.pub,
				requesterDomainId: requester.domainId,
				requesterGatewayId: requester.gatewayId,
			}),
		).rejects.toThrow(/must name a different Gateway/);
	});

	it("rejects a malformed token (no gateway-id prefix)", async () => {
		const requester = makeDomain("bob", "bob-desktop");
		const coord = new CrossDomainHandshakeCoordinator({
			self: selfFor(requester),
			peers: new CrossDomainPeers(tmp()),
			route: { sendCommit: vi.fn(), sendReveal: vi.fn() },
		});
		await expect(
			coord.request({
				listeningToken: "no-separator",
				pin: PIN,
				requesterOwnerSignPub: requester.owner.sign.pub,
				requesterDomainId: requester.domainId,
				requesterGatewayId: requester.gatewayId,
			}),
		).rejects.toThrow(/malformed listening token/);
	});

	it("aborts when the receiver's reveal does not match its committed hash", async () => {
		const requester = makeDomain("bob", "bob-desktop");
		const receiver = makeDomain("home", "sakura-laptop");
		// The Router returns an HONEST commitment in round 1 but a DIFFERENT party at reveal.
		const honestSalt = "cmVjdi1zYWx0";
		const sendCommit = vi.fn(async () => ({ receiverCommitment: commitmentOf(partyOf(receiver), honestSalt) }));
		const evil = makeDomain("home", "sakura-laptop"); // different keys, same ids
		const sendReveal = vi.fn(async () => ({
			receiverParty: partyOf(evil),
			receiverSalt: honestSalt,
			sas: expectedSas(requester, evil, PIN),
		}));
		const coord = new CrossDomainHandshakeCoordinator({
			self: selfFor(requester),
			peers: new CrossDomainPeers(tmp()),
			route: { sendCommit, sendReveal },
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
		expect(coord.openCount).toBe(0); // no pairing stored on a mismatch
	});

	it("aborts on a SAS mismatch (a key substituted while still matching its commitment)", async () => {
		const requester = makeDomain("bob", "bob-desktop");
		const receiver = makeDomain("home", "sakura-laptop");
		const salt = "cmVjdi1zYWx0";
		// The reveal matches its commitment (so the commitment check passes), but the receiver
		// LIES about the SAS - the requester recomputes and rejects.
		const sendCommit = vi.fn(async () => ({ receiverCommitment: commitmentOf(partyOf(receiver), salt) }));
		const sendReveal = vi.fn(async () => ({
			receiverParty: partyOf(receiver),
			receiverSalt: salt,
			sas: "000000000000", // a forged / wrong code
		}));
		const coord = new CrossDomainHandshakeCoordinator({
			self: selfFor(requester),
			peers: new CrossDomainPeers(tmp()),
			route: { sendCommit, sendReveal },
		});
		await expect(
			coord.request({
				listeningToken: "sakura-laptop.tok",
				pin: PIN,
				requesterOwnerSignPub: requester.owner.sign.pub,
				requesterDomainId: requester.domainId,
				requesterGatewayId: requester.gatewayId,
			}),
		).rejects.toThrow(/safety code mismatch/);
		expect(coord.openCount).toBe(0);
	});
});

////////////////////////////////
//  End-to-end: two coordinators (one per Domain) pair through a shared Router

describe("CrossDomainHandshakeCoordinator - two-Gateway end to end", () => {
	it("listen on A, request from B, both confirm, both peer sets populated", async () => {
		const a = makeDomain("home", "sakura-laptop"); // receiver / listener
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

		// The humans matched; each phone signs both link sides and confirms.
		coordA.confirm({ pin: PIN, mySignedLink: signLinkSide(a, b), friendSignedLink: signLinkSide(b, a) });
		coordB.confirm({ pin: PIN, mySignedLink: signLinkSide(b, a), friendSignedLink: signLinkSide(a, b) });

		// A now trusts B; B now trusts A. The disjoint peer sets are the handshake's only writes.
		expect(peersA.resolveByGateway("bob", "bob-desktop")?.friendOwnerSignPub).toBe(b.owner.sign.pub);
		expect(peersB.resolveByGateway("home", "sakura-laptop")?.friendOwnerSignPub).toBe(a.owner.sign.pub);
		expect(coordA.openCount).toBe(0);
		expect(coordB.openCount).toBe(0);
	});
});

////////////////////////////////
//  Cancel

describe("CrossDomainHandshakeCoordinator - cancel", () => {
	it("cancels an open listening window by token", () => {
		const recv = makeDomain("home", "sakura-laptop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		const token = coord.listen().listeningToken;
		expect(coord.cancel({ listeningToken: token })).toBe(true);
		expect(coord.openCount).toBe(0);
		// A commit against the cancelled token is now refused.
		expect(() =>
			coord.handleIncomingCommit({
				listeningToken: token,
				pin: PIN,
				requesterCommitment: commitmentOf(partyOf(recv), "s"),
			}),
		).toThrow(/no open listening window/);
	});

	it("cancels a requester pending pairing by pin", async () => {
		const requester = makeDomain("bob", "bob-desktop");
		const receiver = makeDomain("home", "sakura-laptop");
		const recvCoord = new CrossDomainHandshakeCoordinator({
			self: selfFor(receiver),
			peers: new CrossDomainPeers(tmp()),
		});
		const token = recvCoord.listen().listeningToken;
		const coord = new CrossDomainHandshakeCoordinator({
			self: selfFor(requester),
			peers: new CrossDomainPeers(tmp()),
			route: directRoute(recvCoord),
		});
		await coord.request({
			listeningToken: token,
			pin: PIN,
			requesterOwnerSignPub: requester.owner.sign.pub,
			requesterDomainId: requester.domainId,
			requesterGatewayId: requester.gatewayId,
		});
		expect(coord.openCount).toBe(1);
		expect(coord.cancel({ pin: PIN })).toBe(true);
		expect(coord.openCount).toBe(0);
	});

	it("returns false when nothing matches", () => {
		const recv = makeDomain("home", "sakura-laptop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		expect(coord.cancel({ listeningToken: "nope", pin: "nope" })).toBe(false);
	});
});

////////////////////////////////
//  Local helpers (recompute commitments the way the coordinator does)

function commitmentOf(party: CrossDomainParty, salt: string): string {
	return crossDomainCommitment(party, salt);
}

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
