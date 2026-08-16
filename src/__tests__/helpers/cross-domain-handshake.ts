import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	CrossDomainHandshakeCoordinator,
	CrossDomainRouter,
	CrossDomainSelf,
} from "../../gateway/federation/crossDomainHandshake.js";
import { type CrossDomainParty, crossDomainCommitment, crossDomainSas } from "../../shared/cross-domain-sas.js";
import { generateIdentity, type Identity } from "../../shared/crypto.js";
import { signXDomainLink, type XDomainLink } from "../../shared/federation-protocol.js";

////////////////////////////////
//  Interfaces & Types

/** One Domain's identity: the phone-held owner root key + the Gateway's keys + ids. */
export interface Domain {
	owner: Identity;
	gateway: Identity;
	domainId: string;
	gatewayId: string;
}

////////////////////////////////
//  Fixtures

const dirs: string[] = [];
export function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "xdomain-handshake-"));
	dirs.push(d);
	return d;
}
/** Register this in the importing test file's own `afterEach`, so cleanup runs in that
 * file's suite context rather than relying on this module's top-level hook registration. */
export function cleanupTmpDirs(): void {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

export const PIN = "cGluLXJlbmRlenZvdXM";

export function makeDomain(domainId: string, gatewayId: string): Domain {
	return { owner: generateIdentity(), gateway: generateIdentity(), domainId, gatewayId };
}

export function selfFor(d: Domain): CrossDomainSelf {
	return {
		ownerSignPub: () => d.owner.sign.pub,
		gatewaySignPub: d.gateway.sign.pub,
		gatewayBoxPub: d.gateway.box.pub,
		domainId: d.domainId,
		gatewayId: d.gatewayId,
	};
}

export function partyOf(d: Domain): CrossDomainParty {
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
export function signLinkSide(me: Domain, friend: Domain): ReturnType<typeof signXDomainLink> {
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
export function expectedSas(a: Domain, b: Domain, pin: string): string {
	return crossDomainSas(partyOf(a), partyOf(b), pin);
}

/** A Router seam that drives both commit-reveal rounds straight into a receiver
 * coordinator (the Router is a direct wire here). This is exactly how index.ts routes,
 * with the network hop to the Router skipped. */
export function directRoute(receiver: CrossDomainHandshakeCoordinator): CrossDomainRouter {
	return {
		sendCommit: async (_gw, req) => receiver.handleIncomingCommit(req),
		sendReveal: async (_gw, req) => receiver.handleIncomingReveal(req),
	};
}

////////////////////////////////
//  Local helpers (recompute commitments the way the coordinator does)

export function commitmentOf(party: CrossDomainParty, salt: string): string {
	return crossDomainCommitment(party, salt);
}
