import { afterEach, describe, expect, it } from "vitest";
import { CrossDomainHandshakeCoordinator } from "../gateway/federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import {
	cleanupTmpDirs,
	commitmentOf,
	directRoute,
	makeDomain,
	PIN,
	partyOf,
	selfFor,
	tmp,
} from "./helpers/cross-domain-handshake.js";

afterEach(cleanupTmpDirs);

////////////////////////////////
//  Cancel

describe("CrossDomainHandshakeCoordinator - cancel", () => {
	it("cancels an open listening window by token", () => {
		const recv = makeDomain("alice", "sakura-laptop");
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
		const receiver = makeDomain("alice", "sakura-laptop");
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
		const recv = makeDomain("alice", "sakura-laptop");
		const coord = new CrossDomainHandshakeCoordinator({ self: selfFor(recv), peers: new CrossDomainPeers(tmp()) });
		expect(coord.cancel({ listeningToken: "nope", pin: "nope" })).toBe(false);
	});
});
