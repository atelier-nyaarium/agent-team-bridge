import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	CrossDomainHandshakeCoordinator,
	type CrossDomainRouter,
	type CrossDomainSelf,
	createCrossDomainHandshakePump,
} from "../gateway/federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { processAmbient } from "../shared/ambient.js";
import { type CrossDomainParty, crossDomainCommitment } from "../shared/cross-domain-sas.js";
import { generateIdentity, type Identity } from "../shared/crypto.js";
import { signXDomainLink } from "../shared/federation-protocol.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";
import { type DomainPeer, type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

const dirs: string[] = [];
const PIN = "cGluLXJlbmRlenZvdXM";

interface Domain {
	owner: Identity;
	gateway: Identity;
	domainId: string;
	gatewayId: string;
}

function domain(domainId: string, gatewayId: string): Domain {
	return { owner: generateIdentity(), gateway: generateIdentity(), domainId, gatewayId };
}

function party(value: Domain): CrossDomainParty {
	return {
		ownerSignPub: value.owner.sign.pub,
		gatewaySignPub: value.gateway.sign.pub,
		gatewayBoxPub: value.gateway.box.pub,
		domainId: value.domainId,
		gatewayId: value.gatewayId,
	};
}

function self(value: Domain): CrossDomainSelf {
	return {
		ownerSignPub: () => value.owner.sign.pub,
		gatewaySignPub: value.gateway.sign.pub,
		gatewayBoxPub: value.gateway.box.pub,
		domainId: value.domainId,
		gatewayId: value.gatewayId,
	};
}

function peersPath(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "cross-domain-test-"));
	dirs.push(dir);
	return dir;
}

function linkSide(mine: Domain, friend: Domain) {
	return signXDomainLink(
		{
			myOwnerSignPub: mine.owner.sign.pub,
			peerOwnerSignPub: friend.owner.sign.pub,
			peerDomainId: friend.domainId,
			peerGatewayId: friend.gatewayId,
			peerSignPub: friend.gateway.sign.pub,
			peerBoxPub: friend.gateway.box.pub,
			issuedAt: 1,
			nonce: randomBytes(12).toString("base64"),
		},
		mine.owner.sign.priv,
		mine.owner.sign.pub,
	);
}

function rounds(receiver: CrossDomainHandshakeCoordinator, requester: Domain) {
	const token = receiver.listen().listeningToken;
	const salt = "cmVxLXNhbHQ";
	receiver.handleIncomingCommit({
		listeningToken: token,
		pin: PIN,
		requesterCommitment: crossDomainCommitment(party(requester), salt),
	});
	return { token, salt };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cross-Domain handshake coordinator", () => {
	it("expires windows, enforces single-flight attempts, and rejects invalid tokens", () => {
		const receiver = domain("alice", "alice-gw");
		const requester = domain("bob", "bob-gw");
		let now = 1000;
		const coordinator = new CrossDomainHandshakeCoordinator({
			self: self(receiver),
			peers: new CrossDomainPeers(peersPath()),
			ttlMs: 100,
			maxAttempts: 2,
			ambient: fakeAmbient({ now: () => now }),
		});
		const token = coordinator.listen().listeningToken;
		const commit = (pin: string) => ({
			listeningToken: token,
			pin,
			requesterCommitment: crossDomainCommitment(party(requester), pin),
		});

		coordinator.handleIncomingCommit(commit("one"));
		expect(() => coordinator.handleIncomingCommit(commit("two"))).toThrow();
		expect(() => coordinator.handleIncomingCommit(commit("three"))).toThrow();
		expect(() => coordinator.handleIncomingCommit(commit("four"))).toThrow();
		expect(coordinator.listenState(token)).toMatchObject({ pairingArrived: false, expired: true });

		const fresh = coordinator.listen().listeningToken;
		now += 101;
		expect(() =>
			coordinator.handleIncomingCommit({
				listeningToken: fresh,
				pin: PIN,
				requesterCommitment: crossDomainCommitment(party(requester), "salt"),
			}),
		).toThrow();
		expect(() => coordinator.handleIncomingCommit({ ...commit(PIN), listeningToken: "bad-token" })).toThrow();
	});

	it("cancellation removes receiver and requester pending state", async () => {
		const receiver = domain("alice", "alice-gw");
		const requester = domain("bob", "bob-gw");
		const receiverCoordinator = new CrossDomainHandshakeCoordinator({
			self: self(receiver),
			peers: new CrossDomainPeers(peersPath()),
			ambient: processAmbient(),
		});
		const token = receiverCoordinator.listen().listeningToken;
		expect(receiverCoordinator.cancel({ listeningToken: token })).toBe(true);
		expect(() =>
			receiverCoordinator.handleIncomingCommit({
				listeningToken: token,
				pin: PIN,
				requesterCommitment: crossDomainCommitment(party(requester), "salt"),
			}),
		).toThrow();

		const requesterCoordinator = new CrossDomainHandshakeCoordinator({
			self: self(requester),
			peers: new CrossDomainPeers(peersPath()),
			ambient: processAmbient(),
			route: {
				sendCommit: async (_, request) => receiverCoordinator.handleIncomingCommit(request),
				sendReveal: async (_, request) => receiverCoordinator.handleIncomingReveal(request),
			},
		});
		const nextToken = receiverCoordinator.listen().listeningToken;
		await requesterCoordinator.request({
			listeningToken: nextToken,
			pin: PIN,
			requesterOwnerSignPub: requester.owner.sign.pub,
			requesterDomainId: requester.domainId,
			requesterGatewayId: requester.gatewayId,
		});
		expect(requesterCoordinator.cancel({ pin: PIN })).toBe(true);
		expect(() => requesterCoordinator.confirm({ pin: PIN, mySignedLink: linkSide(requester, receiver) })).toThrow();
	});

	it("rejects malformed, self-gateway, and second pending requests", async () => {
		const value = domain("alice", "alice-gw");
		const coordinator = new CrossDomainHandshakeCoordinator({
			self: self(value),
			peers: new CrossDomainPeers(peersPath()),
			ambient: processAmbient(),
			route: {
				sendCommit: async () => ({ receiverCommitment: "x" }),
				sendReveal: async () => {
					throw new Error("unused");
				},
			},
		});
		const args = {
			pin: PIN,
			requesterOwnerSignPub: value.owner.sign.pub,
			requesterDomainId: value.domainId,
			requesterGatewayId: value.gatewayId,
		};
		await expect(coordinator.request({ ...args, listeningToken: "bad" })).rejects.toThrow();
		await expect(coordinator.request({ ...args, listeningToken: "alice-gw.token" })).rejects.toThrow();
		const receiver = domain("bob", "bob-gw");
		const receiverCoordinator = new CrossDomainHandshakeCoordinator({
			self: self(receiver),
			peers: new CrossDomainPeers(peersPath()),
			ambient: processAmbient(),
		});
		const token = receiverCoordinator.listen().listeningToken;
		const route: CrossDomainRouter = {
			sendCommit: async (_, request) => receiverCoordinator.handleIncomingCommit(request),
			sendReveal: async (_, request) => receiverCoordinator.handleIncomingReveal(request),
		};
		const pending = new CrossDomainHandshakeCoordinator({
			self: self(value),
			peers: new CrossDomainPeers(peersPath()),
			ambient: processAmbient(),
			route,
		});
		const first = pending.request({ ...args, listeningToken: token });
		await expect(pending.request({ ...args, listeningToken: token, pin: "second" })).rejects.toThrow();
		await first;
	});

	it("refuses a tampered reveal before producing a SAS", () => {
		const receiver = domain("alice", "alice-gw");
		const requester = domain("bob", "bob-gw");
		const attacker = domain("bob", "bob-gw");
		const coordinator = new CrossDomainHandshakeCoordinator({
			self: self(receiver),
			peers: new CrossDomainPeers(peersPath()),
			ambient: processAmbient(),
		});
		const { token, salt } = rounds(coordinator, requester);
		expect(() =>
			coordinator.handleIncomingReveal({
				listeningToken: token,
				pin: PIN,
				requesterParty: { ...party(requester), gatewayBoxPub: attacker.gateway.box.pub },
				requesterSalt: salt,
			}),
		).toThrow();
		expect(coordinator.listenState(token)).toMatchObject({ pairingArrived: false });
	});

	it("refuses a mismatched SAS and propagates Router failures", async () => {
		const receiver = domain("alice", "alice-gw");
		const requester = domain("bob", "bob-gw");
		const receiverCoordinator = new CrossDomainHandshakeCoordinator({
			self: self(receiver),
			peers: new CrossDomainPeers(peersPath()),
			ambient: processAmbient(),
		});
		const token = receiverCoordinator.listen().listeningToken;
		const salt = "cmVjdmVyLXNhbHQ";
		const route: CrossDomainRouter = {
			sendCommit: async () => ({ receiverCommitment: crossDomainCommitment(party(receiver), salt) }),
			sendReveal: async () => ({
				receiverParty: party(receiver),
				receiverSalt: salt,
				sas: "000000",
			}),
		};
		const coordinator = new CrossDomainHandshakeCoordinator({
			self: self(requester),
			peers: new CrossDomainPeers(peersPath()),
			ambient: processAmbient(),
			route,
		});
		await expect(
			coordinator.request({
				listeningToken: token,
				pin: PIN,
				requesterOwnerSignPub: requester.owner.sign.pub,
				requesterDomainId: requester.domainId,
				requesterGatewayId: requester.gatewayId,
			}),
		).rejects.toThrow();

		const failing = new CrossDomainHandshakeCoordinator({
			self: self(requester),
			peers: new CrossDomainPeers(peersPath()),
			ambient: processAmbient(),
			route: {
				sendCommit: async () => {
					throw new Error("router refused");
				},
				sendReveal: async () => {
					throw new Error("transport failed");
				},
			},
		});
		await expect(
			failing.request({
				listeningToken: token,
				pin: PIN,
				requesterOwnerSignPub: requester.owner.sign.pub,
				requesterDomainId: requester.domainId,
				requesterGatewayId: requester.gatewayId,
			}),
		).rejects.toThrow();

		const transportFailure = new CrossDomainHandshakeCoordinator({
			self: self(requester),
			peers: new CrossDomainPeers(peersPath()),
			ambient: processAmbient(),
			route: {
				sendCommit: async () => ({ receiverCommitment: crossDomainCommitment(party(receiver), salt) }),
				sendReveal: async () => {
					throw new Error("transport failed");
				},
			},
		});
		await expect(
			transportFailure.request({
				listeningToken: token,
				pin: PIN,
				requesterOwnerSignPub: requester.owner.sign.pub,
				requesterDomainId: requester.domainId,
				requesterGatewayId: requester.gatewayId,
			}),
		).rejects.toThrow();
	});

	it("binds confirm to the owner and the SAS-verified peer keys", () => {
		const receiver = domain("alice", "alice-gw");
		const requester = domain("bob", "bob-gw");
		const peers = new CrossDomainPeers(peersPath());
		const coordinator = new CrossDomainHandshakeCoordinator({
			self: self(receiver),
			peers,
			ambient: processAmbient(),
		});
		const { token, salt } = rounds(coordinator, requester);
		coordinator.handleIncomingReveal({
			listeningToken: token,
			pin: PIN,
			requesterParty: party(requester),
			requesterSalt: salt,
		});
		expect(() =>
			coordinator.confirm({ pin: PIN, mySignedLink: linkSide(domain("alice", "alice-gw"), requester) }),
		).toThrow();

		const secondPeers = new CrossDomainPeers(peersPath());
		const second = new CrossDomainHandshakeCoordinator({
			self: self(receiver),
			peers: secondPeers,
			ambient: processAmbient(),
		});
		const secondRound = rounds(second, requester);
		second.handleIncomingReveal({
			listeningToken: secondRound.token,
			pin: PIN,
			requesterParty: party(requester),
			requesterSalt: secondRound.salt,
		});
		expect(() =>
			coordinator.confirm({ pin: PIN, mySignedLink: linkSide(receiver, domain("bob", "bob-gw")) }),
		).toThrow();
		expect(second.confirm({ pin: PIN, mySignedLink: linkSide(receiver, requester) })).toEqual({ ok: true });
		expect(secondPeers.resolveByGateway(requester.domainId, requester.gatewayId)).not.toBeNull();
	});
});

describe("cross-Domain handshake pump", () => {
	it("validates frames, correlates replies, and contains send failures", async () => {
		const replies: Array<Record<string, unknown>> = [];
		const pump = createCrossDomainHandshakePump({
			handleIncomingCommit: () => ({ receiverCommitment: "commit" }),
			handleIncomingReveal: () => ({
				receiverParty: party(domain("alice", "alice-gw")),
				receiverSalt: "salt",
				sas: "123456",
			}),
			sendCommitReply: async (reply) => {
				replies.push(reply as unknown as Record<string, unknown>);
				return {};
			},
			sendRevealReply: async () => {
				throw new Error("transport");
			},
		});
		pump({
			type: "cross_domain_handshake",
			handshakeId: "h1",
			srcDomain: "bob",
			srcGateway: "bob-gw",
			dstGateway: "alice-gw",
			payload: {},
		});
		pump({
			type: "cross_domain_handshake",
			handshakeId: "h2",
			srcDomain: "bob",
			srcGateway: "bob-gw",
			dstGateway: "alice-gw",
			payload: { listeningToken: "t", pin: "p", requesterCommitment: "c" },
		});
		pump({
			type: "cross_domain_handshake_reveal",
			handshakeId: "h3",
			srcDomain: "bob",
			srcGateway: "bob-gw",
			dstGateway: "alice-gw",
			payload: {},
		});
		pump({ type: "cross_domain_handshake", payload: {} });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(replies).toHaveLength(2);
		expect(replies[0]).toMatchObject({ handshakeId: "h1", ok: false });
		expect(replies[1]).toMatchObject({ handshakeId: "h2", ok: true });
	});
});

describe("cross-Domain handshake harness", () => {
	let harness: FederationHarness;
	let friend: DomainPeer;

	beforeAll(async () => {
		harness = await startFederationHarness();
		friend = await harness.addDomain({ domainId: "bob", gatewayId: "bob-gw" });
	}, 60_000);
	afterAll(async () => {
		await harness.close();
	});

	it("cancels through the phone and refuses a later request", async () => {
		const listened = await harness.phone.value({ kind: "cross_domain_listen" });
		const token = (listened.result as { listeningToken: string }).listeningToken;
		expect(await harness.phone.value({ kind: "cross_domain_cancel", listeningToken: token })).toMatchObject({
			result: { cancelled: true },
		});
		const refused = await friend.phone.value({
			kind: "cross_domain_request",
			listeningToken: token,
			pin: PIN,
			requesterOwnerSignPub: friend.set.domain.owner.sign.pub,
			requesterDomainId: friend.set.domain.id,
			requesterGatewayId: friend.set.gateway.id,
		});
		expect(refused.result).toMatchObject({ kind: "refusal" });
	});

	it("shows one SAS and stores the owner-bound peers", async () => {
		const linked = await harness.link(harness, friend);
		expect(linked.sas).toMatch(/^\d{6}$/);
		expect(linked.receiver.sas).toBe(linked.requester.sas);
		expect((await harness.phone.value({ kind: "cross_domain_list_peers" })).result).toMatchObject({
			peers: [{ domainId: "bob" }],
		});
		expect((await friend.phone.value({ kind: "cross_domain_list_peers" })).result).toMatchObject({
			peers: [{ domainId: harness.set.domain.id }],
		});
	});
});
