import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verify } from "../shared/crypto.js";
import {
	signXDomainLinkEdge,
	signXDomainLinkRevocation,
	verifyXDomainLinkEdge,
	verifyXDomainLinkRevocation,
	type XDomainLinkEdge,
	type XDomainLinkRevocation,
	xDomainLinkEdgeSigningBytes,
	xDomainLinkRevocationSigningBytes,
} from "../shared/enrollment.js";
import {
	signXDomainLink,
	verifyXDomainLink,
	type XDomainLink,
	xDomainLinkSigningBytes,
} from "../shared/federation-protocol.js";

////////////////////////////////
//  Cross-Domain link-edge + revocation vectors
//
//  vectors.json is read by BOTH this suite and XDomainLinkTest.kt (Kotlin), so the
//  hand-authored Kotlin twin (XDomainLinkCrypto.kt) cannot drift from this TS source:
//  the canonical bytes / signature either runtime derives differently fails one of the
//  two suites. This suite also guards the fixture against a hand-edit (the recorded bytes
//  + signature must reproduce from the live TS reference). The edge/revocation here is the
//  content-blind relay-affinity edge submitted to evie, distinct from the gateway-key
//  XDomainLink artifact pinned in xdomain-link.test.ts.

interface SignedVec<T> {
	value: T;
	signingBytes: string;
	signingBytesHex: string;
	signingBytesBase64: string;
	signature: string;
}

const vectors = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/xdomain-link/vectors.json"), "utf8"),
) as {
	ownerSignPub: string;
	ownerSignPriv: string;
	edge: SignedVec<XDomainLinkEdge>;
	revocation: SignedVec<XDomainLinkRevocation>;
	link: SignedVec<XDomainLink>;
};

describe("cross-Domain link-edge vectors", () => {
	const { ownerSignPub, ownerSignPriv } = vectors;

	it("reproduces the canonical XDOMAIN_RELAY_GATE_V1 signing bytes", () => {
		const bytes = xDomainLinkEdgeSigningBytes(vectors.edge.value, ownerSignPub);
		expect(bytes.toString("utf8")).toBe(vectors.edge.signingBytes);
		expect(bytes.toString("hex")).toBe(vectors.edge.signingBytesHex);
		expect(bytes.toString("base64")).toBe(vectors.edge.signingBytesBase64);
	});

	it("reproduces the recorded edge signature and verifies it", () => {
		// Ed25519 is deterministic (RFC 8032), so re-signing with the fixed key reproduces
		// the pinned signature byte-for-byte.
		const signed = signXDomainLinkEdge(vectors.edge.value, ownerSignPriv, ownerSignPub);
		expect(signed.signature).toBe(vectors.edge.signature);
		expect(verifyXDomainLinkEdge(signed, ownerSignPub)).toBe(true);
		expect(
			verify(xDomainLinkEdgeSigningBytes(vectors.edge.value, ownerSignPub), vectors.edge.signature, ownerSignPub),
		).toBe(true);
	});

	it("rejects the edge under a different owner key", () => {
		const forged = {
			...signXDomainLinkEdge(vectors.edge.value, ownerSignPriv, ownerSignPub),
			ownerSignPub: "AAAA",
		};
		expect(verifyXDomainLinkEdge(forged, ownerSignPub)).toBe(false);
	});
});

describe("cross-Domain link-revocation vectors", () => {
	const { ownerSignPub, ownerSignPriv } = vectors;

	it("reproduces the canonical XDOMAIN_REVOKE_V1 signing bytes", () => {
		const bytes = xDomainLinkRevocationSigningBytes(vectors.revocation.value, ownerSignPub);
		expect(bytes.toString("utf8")).toBe(vectors.revocation.signingBytes);
		expect(bytes.toString("hex")).toBe(vectors.revocation.signingBytesHex);
		expect(bytes.toString("base64")).toBe(vectors.revocation.signingBytesBase64);
	});

	it("reproduces the recorded revocation signature and verifies it", () => {
		const signed = signXDomainLinkRevocation(vectors.revocation.value, ownerSignPriv, ownerSignPub);
		expect(signed.signature).toBe(vectors.revocation.signature);
		expect(verifyXDomainLinkRevocation(signed, ownerSignPub)).toBe(true);
	});

	it("the revocation prefix is distinct so an edge signature never replays as a revocation", () => {
		// Same field values across edge and revocation, but the version prefix differs, so
		// the edge's signature must not verify over the revocation bytes.
		const e = vectors.edge.value;
		const asRevocation: XDomainLinkRevocation = {
			srcDomainId: e.srcDomainId,
			dstDomainId: e.dstDomainId,
			revokedAt: e.issuedAt,
			nonce: e.nonce,
		};
		expect(
			verify(xDomainLinkRevocationSigningBytes(asRevocation, ownerSignPub), vectors.edge.signature, ownerSignPub),
		).toBe(false);
	});
});

describe("cross-Domain link (gateway-key XDomainLink artifact) vectors", () => {
	const { ownerSignPub, ownerSignPriv } = vectors;

	it("reproduces the canonical XDOMAIN_LINK_V1 signing bytes", () => {
		const bytes = xDomainLinkSigningBytes(vectors.link.value);
		expect(bytes.toString("utf8")).toBe(vectors.link.signingBytes);
		expect(bytes.toString("hex")).toBe(vectors.link.signingBytesHex);
		expect(bytes.toString("base64")).toBe(vectors.link.signingBytesBase64);
	});

	it("reproduces the recorded link signature and verifies it under the owner key", () => {
		const signed = signXDomainLink(vectors.link.value, ownerSignPriv, ownerSignPub);
		expect(signed.signature).toBe(vectors.link.signature);
		expect(verifyXDomainLink(signed, ownerSignPub)).toBe(true);
	});

	it("rejects the link under a different owner key", () => {
		const forged = { ...signXDomainLink(vectors.link.value, ownerSignPriv, ownerSignPub), ownerSignPub: "AAAA" };
		expect(verifyXDomainLink(forged, ownerSignPub)).toBe(false);
	});
});
