import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verify } from "../shared/crypto.js";
import {
	signRosterRequest,
	signTransportRequest,
	TransportRequestSchema,
	transportRequestSigningBytes,
	verifyTransportRequest,
} from "../shared/enrollment.js";
import { assertCanonicalBytes } from "./_canonical-bytes.js";

////////////////////////////////
//  Transport request signing-bytes vectors
//
//  vectors.json is read by BOTH this suite and TransportRequestTest.kt (Kotlin), so the
//  hand-authored Kotlin twin (ProvisionOpsCrypto.transportRequestSigningBytes) cannot drift
//  from this TS source: the canonical bytes / signature either runtime derives differently
//  fails one of the two suites. The request is owner-signed proof of possession; evie resolves
//  the signer to a rooted owner and returns the gateway-bridge transport.

interface SignedVec<T> {
	value: T;
	signingBytes: string;
	signingBytesHex: string;
	signingBytesBase64: string;
	signature: string;
}

const vectors = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/transport-request/vectors.json"), "utf8"),
) as {
	ownerSignPub: string;
	ownerSignPriv: string;
	transport: SignedVec<{ signerSignPub: string; proofAt: number; nonce: string }>;
};

describe("transport request proof vectors (owner-signed)", () => {
	const { ownerSignPriv } = vectors;

	it("reproduces the canonical TRANSPORT_REQUEST_V1 bytes + signature (cross-runtime pin)", () => {
		const { signerSignPub, proofAt, nonce } = vectors.transport.value;
		const bytes = transportRequestSigningBytes(signerSignPub, proofAt, nonce);
		assertCanonicalBytes(bytes, vectors.transport);
		// Deterministic Ed25519: re-signing with the fixed key reproduces the pinned signature.
		const signed = signTransportRequest(signerSignPub, proofAt, nonce, ownerSignPriv);
		expect(signed.proof).toBe(vectors.transport.signature);
		expect(verifyTransportRequest(signed)).toBe(true);
		expect(verify(bytes, vectors.transport.signature, signerSignPub)).toBe(true);
	});

	it("parses as a TransportRequest and rejects a tampered proof under the wrong signer", () => {
		const { signerSignPub, proofAt, nonce } = vectors.transport.value;
		const signed = signTransportRequest(signerSignPub, proofAt, nonce, ownerSignPriv);
		expect(TransportRequestSchema.safeParse(signed).success).toBe(true);
		// A captured proof re-pointed at a different claimed signer no longer verifies.
		const forged = { ...signed, signerSignPub: "AAAA" };
		expect(verifyTransportRequest(forged)).toBe(false);
	});

	it("the distinct version tag stops a roster proof from verifying as a transport request", () => {
		// Same key + proofAt + nonce, but ROSTER_V1 vs TRANSPORT_REQUEST_V1, so neither proof crosses over.
		const { signerSignPub, proofAt, nonce } = vectors.transport.value;
		const rosterSig = signRosterRequest(signerSignPub, proofAt, nonce, ownerSignPriv);
		expect(verify(transportRequestSigningBytes(signerSignPub, proofAt, nonce), rosterSig, signerSignPub)).toBe(
			false,
		);
	});
});
