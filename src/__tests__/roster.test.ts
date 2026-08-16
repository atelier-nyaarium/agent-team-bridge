import { describe, expect, it } from "vitest";
import { generateIdentity } from "../shared/crypto.js";
import {
	RosterMemberSchema,
	RosterRequestSchema,
	RosterResultSchema,
	rosterRequestSigningBytes,
	signRosterRequest,
	verifyRosterRequest,
} from "../shared/federation-lifecycle.js";

// A console proves it holds an admitted signing key by signing ROSTER_V1 over its own key + a
// fresh timestamp + nonce. The Router verifies the proof, then resolves the key to an admitted console.
const console1 = generateIdentity();

function request(over: Partial<{ proofAt: number; nonce: string }> = {}) {
	const proofAt = over.proofAt ?? 1717171717171;
	const nonce = over.nonce ?? "cm9zdGVyLW5vbmNl";
	return {
		signerSignPub: console1.sign.pub,
		proofAt,
		nonce,
		proof: signRosterRequest(console1.sign.pub, proofAt, nonce, console1.sign.priv),
	};
}

describe("roster request proof", () => {
	it("signs and verifies a fresh roster proof", () => {
		expect(verifyRosterRequest(request())).toBe(true);
	});

	it("the canonical preimage is the versioned newline encoding", () => {
		const bytes = rosterRequestSigningBytes(console1.sign.pub, 1000, "bg==");
		expect(bytes.toString("utf8")).toBe(`ROSTER_V1\n${console1.sign.pub}\n1000\nbg==`);
	});

	it("rejects a proof whose signer key was substituted", () => {
		const attacker = generateIdentity();
		// The attacker swaps the claimed signer to their own; the signature was over console1's key.
		expect(verifyRosterRequest({ ...request(), signerSignPub: attacker.sign.pub })).toBe(false);
	});

	it("rejects a forged signature (signed by a non-holder)", () => {
		const attacker = generateIdentity();
		const proofAt = 1717171717171;
		const nonce = "cm9zdGVyLW5vbmNl";
		// The attacker signs but claims console1's key.
		const forged = {
			signerSignPub: console1.sign.pub,
			proofAt,
			nonce,
			proof: signRosterRequest(console1.sign.pub, proofAt, nonce, attacker.sign.priv),
		};
		expect(verifyRosterRequest(forged)).toBe(false);
	});

	it("rejects a tampered timestamp or nonce (the proof no longer matches)", () => {
		expect(verifyRosterRequest({ ...request(), proofAt: 9999 })).toBe(false);
		expect(verifyRosterRequest({ ...request(), nonce: "dGFtcGVy" })).toBe(false);
	});
});

describe("roster schemas", () => {
	it("accepts a well-formed request, member, and result", () => {
		expect(RosterRequestSchema.safeParse(request()).success).toBe(true);
		expect(
			RosterMemberSchema.safeParse({ ownerSignPub: "a2V5", displayName: "Kashia", online: true }).success,
		).toBe(true);
		expect(
			RosterResultSchema.safeParse({
				ok: true,
				members: [{ ownerSignPub: "a2V5", displayName: "Kashia", online: false }],
			}).success,
		).toBe(true);
	});

	it("a member row carries NO gatewayId / box key / domainId (identity only, no seal handle)", () => {
		// Extra routing/seal fields are stripped by the schema, so a row can never leak a handle.
		const parsed = RosterMemberSchema.parse({
			ownerSignPub: "a2V5",
			displayName: "Kashia",
			online: true,
			gatewayId: "should-be-dropped",
			boxPub: "c2hvdWxkLWRyb3A=",
		} as never);
		expect(parsed).toEqual({ ownerSignPub: "a2V5", displayName: "Kashia", online: true });
		expect("gatewayId" in parsed).toBe(false);
		expect("boxPub" in parsed).toBe(false);
	});

	it("rejects a newline in displayName (signing-byte safety for the name surface)", () => {
		expect(
			RosterMemberSchema.safeParse({ ownerSignPub: "a2V5", displayName: "Kashia\nevil", online: true }).success,
		).toBe(false);
	});
});
