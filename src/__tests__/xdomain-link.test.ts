import { describe, expect, it } from "vitest";
import { generateIdentity } from "../shared/crypto.js";
import {
	signXDomainLink,
	signXDomainUntrust,
	verifyXDomainLink,
	verifyXDomainUntrust,
	type XDomainLink,
	XDomainLinkSchema,
	type XDomainUntrust,
} from "../shared/federation-protocol.js";

// Two owners (two Domains) and a friend gateway whose keys the link binds.
const myOwner = generateIdentity();
const friendOwner = generateIdentity();
const friendGateway = generateIdentity();

function link(over: Partial<XDomainLink> = {}): XDomainLink {
	return {
		myOwnerSignPub: myOwner.sign.pub,
		peerOwnerSignPub: friendOwner.sign.pub,
		peerDomainId: "carol",
		peerGatewayId: "carol-laptop",
		peerSignPub: friendGateway.sign.pub,
		peerBoxPub: friendGateway.box.pub,
		issuedAt: 1000,
		nonce: "bm9uY2Ux",
		...over,
	};
}

describe("cross-Domain link artifact", () => {
	it("owner-signs and verifies a link side under the signing owner key", () => {
		// myOwner signs its own side; the side is verified under myOwner's key.
		const s = signXDomainLink(link(), myOwner.sign.priv, myOwner.sign.pub);
		expect(verifyXDomainLink(s, myOwner.sign.pub)).toBe(true);
	});

	it("rejects a link verified against the wrong (non-signing) owner key", () => {
		// Signed by myOwner, but verified under the friend owner key: mismatch.
		const s = signXDomainLink(link(), myOwner.sign.priv, myOwner.sign.pub);
		expect(verifyXDomainLink(s, friendOwner.sign.pub)).toBe(false);
	});

	it("rejects a link whose claimed ownerSignPub was substituted", () => {
		const attacker = generateIdentity();
		const s = signXDomainLink(link(), myOwner.sign.priv, myOwner.sign.pub);
		// Attacker swaps the ownerSignPub to their own; verifier expects myOwner.
		const forged = { ...s, ownerSignPub: attacker.sign.pub };
		expect(verifyXDomainLink(forged, myOwner.sign.pub)).toBe(false);
	});

	it("rejects a tampered link field (swapped peerGatewayId)", () => {
		const s = signXDomainLink(link(), myOwner.sign.priv, myOwner.sign.pub);
		const tampered = { ...s, link: { ...s.link, peerGatewayId: "evil" } };
		expect(verifyXDomainLink(tampered, myOwner.sign.pub)).toBe(false);
	});

	it("rejects a tampered peer box key (the key the seal would use)", () => {
		const stranger = generateIdentity();
		const s = signXDomainLink(link(), myOwner.sign.priv, myOwner.sign.pub);
		const tampered = { ...s, link: { ...s.link, peerBoxPub: stranger.box.pub } };
		expect(verifyXDomainLink(tampered, myOwner.sign.pub)).toBe(false);
	});

	it("rejects a forged signature (signed by a non-owner)", () => {
		const attacker = generateIdentity();
		// Attacker signs but claims to be myOwner; the signature fails under myOwner.
		const s = signXDomainLink(link(), attacker.sign.priv, myOwner.sign.pub);
		expect(verifyXDomainLink(s, myOwner.sign.pub)).toBe(false);
	});

	it("rejects a newline in the slug id fields (signing-bytes ambiguity guard)", () => {
		// peerDomainId + peerGatewayId are adjacent in the newline-joined signing bytes, so an
		// embedded newline would let two different (domain, gateway) tuples collide to identical
		// bytes (one owner signature authenticating both). The schema constrains them to the slug
		// grammar so a newline can never enter the preimage.
		expect(XDomainLinkSchema.safeParse(link({ peerDomainId: "carol\ncarol-laptop" })).success).toBe(false);
		expect(XDomainLinkSchema.safeParse(link({ peerGatewayId: "carol-laptop\nx" })).success).toBe(false);
		// A legitimate sanitizer-output slug still parses.
		expect(
			XDomainLinkSchema.safeParse(link({ peerDomainId: "carol", peerGatewayId: "carol-laptop" })).success,
		).toBe(true);
	});

	it("verifies the friend's own side under the friend owner key (the real ceremony shape)", () => {
		// Each owner signs its own side. The friend signs a side describing THIS gateway
		// from their perspective; we verify it under the friend owner key.
		const myGateway = generateIdentity();
		const friendSide = signXDomainLink(
			link({
				myOwnerSignPub: friendOwner.sign.pub,
				peerOwnerSignPub: myOwner.sign.pub,
				peerDomainId: "home",
				peerGatewayId: "my-laptop",
				peerSignPub: myGateway.sign.pub,
				peerBoxPub: myGateway.box.pub,
			}),
			friendOwner.sign.priv,
			friendOwner.sign.pub,
		);
		expect(verifyXDomainLink(friendSide, friendOwner.sign.pub)).toBe(true);
		// And it does NOT verify under my own owner key.
		expect(verifyXDomainLink(friendSide, myOwner.sign.pub)).toBe(false);
	});
});

describe("cross-Domain untrust tombstone", () => {
	function untrust(over: Partial<XDomainUntrust> = {}): XDomainUntrust {
		return {
			myOwnerSignPub: myOwner.sign.pub,
			peerOwnerSignPub: friendOwner.sign.pub,
			revokedAt: 2000,
			nonce: "dW50cnVzdA==",
			...over,
		};
	}

	it("owner-signs and verifies an untrust under the signing owner key", () => {
		const s = signXDomainUntrust(untrust(), myOwner.sign.priv, myOwner.sign.pub);
		expect(verifyXDomainUntrust(s, myOwner.sign.pub)).toBe(true);
	});

	it("only the local owner can withdraw its own trust (rejects another key)", () => {
		const s = signXDomainUntrust(untrust(), myOwner.sign.priv, myOwner.sign.pub);
		// The friend owner cannot be the verifier - this is MY withdrawal, signed by MY key.
		expect(verifyXDomainUntrust(s, friendOwner.sign.pub)).toBe(false);
	});

	it("rejects a forged signature (signed by a non-owner claiming to be me)", () => {
		const attacker = generateIdentity();
		const s = signXDomainUntrust(untrust(), attacker.sign.priv, myOwner.sign.pub);
		expect(verifyXDomainUntrust(s, myOwner.sign.pub)).toBe(false);
	});

	it("rejects a tampered peerOwnerSignPub (would silently untrust a different person)", () => {
		const stranger = generateIdentity();
		const s = signXDomainUntrust(untrust(), myOwner.sign.priv, myOwner.sign.pub);
		const tampered = { ...s, untrust: { ...s.untrust, peerOwnerSignPub: stranger.sign.pub } };
		expect(verifyXDomainUntrust(tampered, myOwner.sign.pub)).toBe(false);
	});
});
