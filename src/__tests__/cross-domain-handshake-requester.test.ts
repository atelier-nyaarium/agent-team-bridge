import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CrossDomainHandshakeCoordinator,
	type CrossDomainRouter,
	type XDomainCommitWire,
} from "../gateway/federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import {
	cleanupTmpDirs,
	commitmentOf,
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
//  Requester role: request (via the Router seam) -> confirm

describe("CrossDomainHandshakeCoordinator - requester role", () => {
	it("drives both rounds, cross-checks the SAS, and stores a pending pairing", async () => {
		const requester = makeDomain("bob", "bob-desktop");
		const receiver = makeDomain("alice", "sakura-laptop");
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

		// And the requester can confirm independently with only its own link side.
		const mySide = signLinkSide(requester, receiver);
		const confirmResult = coord.confirm({ pin: PIN, mySignedLink: mySide });
		expect(confirmResult.ok).toBe(true);
		expect(peers.resolveByGateway("alice", "sakura-laptop")?.friendOwnerSignPub).toBe(receiver.owner.sign.pub);
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
		const receiver = makeDomain("alice", "sakura-laptop");
		// The Router returns an HONEST commitment in round 1 but a DIFFERENT party at reveal.
		const honestSalt = "cmVjdi1zYWx0";
		const sendCommit = vi.fn(async () => ({ receiverCommitment: commitmentOf(partyOf(receiver), honestSalt) }));
		const evil = makeDomain("alice", "sakura-laptop"); // different keys, same ids
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
		const receiver = makeDomain("alice", "sakura-laptop");
		const salt = "cmVjdi1zYWx0";
		// The reveal matches its commitment (so the commitment check passes), but the receiver
		// LIES about the SAS - the requester recomputes and rejects.
		const sendCommit = vi.fn(async () => ({ receiverCommitment: commitmentOf(partyOf(receiver), salt) }));
		const sendReveal = vi.fn(async () => ({
			receiverParty: partyOf(receiver),
			receiverSalt: salt,
			sas: "000000", // a forged / wrong code
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
