import { describe, expect, it } from "vitest";
import {
	TrustHandshakeOpSchema,
	TrustPendingRequestSchema,
	TrustPendingResultSchema,
} from "../shared/federation-lifecycle.js";

////////////////////////////////
//  FLOW-2 trust rendezvous wire shapes
//
//  The roster-initiated user-to-user trust handshake (arm/join/reveal/cancel) + the target's
//  pending-query result. The PoP signing bytes are pinned cross-runtime in provision-ops.test.ts;
//  this suite guards the discriminated-union boundary (each step's required fields) and the
//  opaque-reject result shape.

const B64 = "YWJj"; // "abc"

describe("TrustHandshakeOpSchema (the rendezvous steps)", () => {
	it("accepts an INITIATOR arm with both owner keys + a commitment", () => {
		const op = {
			step: "arm",
			rendezvousId: B64,
			initiatorOwnerSignPub: B64,
			targetOwnerSignPub: B64,
			commitment: B64,
		};
		expect(TrustHandshakeOpSchema.safeParse(op).success).toBe(true);
		// An arm missing the target owner is rejected (no rendezvous index).
		const { targetOwnerSignPub, ...noTarget } = op;
		expect(TrustHandshakeOpSchema.safeParse(noTarget).success).toBe(false);
	});

	it("accepts a TARGET join with the joiner's own owner key", () => {
		expect(
			TrustHandshakeOpSchema.safeParse({
				step: "join",
				rendezvousId: B64,
				joinerOwnerSignPub: B64,
				commitment: B64,
			}).success,
		).toBe(true);
	});

	it("accepts a reveal carrying the side + the owner-key reveal", () => {
		expect(
			TrustHandshakeOpSchema.safeParse({
				step: "reveal",
				rendezvousId: B64,
				side: "TARGET",
				reveal: { ownerSignPub: B64, ownerBoxPub: B64, domainId: "alice", salt: B64 },
			}).success,
		).toBe(true);
		// An unknown side is rejected.
		expect(
			TrustHandshakeOpSchema.safeParse({
				step: "reveal",
				rendezvousId: B64,
				side: "BYSTANDER",
				reveal: { ownerSignPub: B64, ownerBoxPub: B64, domainId: "alice", salt: B64 },
			}).success,
		).toBe(false);
	});

	it("accepts a cancel and rejects an unknown step", () => {
		expect(TrustHandshakeOpSchema.safeParse({ step: "cancel", rendezvousId: B64 }).success).toBe(true);
		expect(TrustHandshakeOpSchema.safeParse({ step: "nope", rendezvousId: B64 }).success).toBe(false);
	});
});

describe("TrustPending request + result", () => {
	it("requires the PoP fields on the query", () => {
		expect(
			TrustPendingRequestSchema.safeParse({ signerSignPub: B64, proofAt: 1, nonce: B64, proof: B64 }).success,
		).toBe(true);
		expect(TrustPendingRequestSchema.safeParse({ signerSignPub: B64, proofAt: 1, nonce: B64 }).success).toBe(false);
	});

	it("the result omits pending on an opaque reject", () => {
		expect(TrustPendingResultSchema.safeParse({ ok: false, error: "no" }).success).toBe(true);
		expect(
			TrustPendingResultSchema.safeParse({
				ok: true,
				pending: [{ initiatorOwnerSignPub: B64, rendezvousId: B64 }],
			}).success,
		).toBe(true);
	});
});
