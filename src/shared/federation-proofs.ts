import { z } from "zod";
import { b64Field, displayField, sign, verify } from "./crypto.js";
import { SIGNING_TAGS } from "./wire-vocabulary.js";

export const RosterRequestSchema = z
	.object({
		// The signer key is also the proof subject.
		signerSignPub: b64Field(),
		proofAt: z.number().int().nonnegative(),
		nonce: b64Field(),
		proof: b64Field(),
	})
	.meta({ id: "RosterRequest" });

export const RosterMemberSchema = z
	.object({
		ownerSignPub: b64Field(),
		displayName: displayField(128),
		online: z.boolean(),
	})
	.meta({ id: "RosterMember" });

export const RosterResultSchema = z
	.object({
		ok: z.boolean(),
		error: z.string().optional(),
		members: z.array(RosterMemberSchema).optional(),
	})
	.meta({ id: "RosterResult" });

export const TrustPendingRequestSchema = z
	.object({
		signerSignPub: b64Field(),
		proofAt: z.number().int().nonnegative(),
		nonce: b64Field(),
		proof: b64Field(),
	})
	.meta({ id: "TrustPendingRequest" });

export const TrustPendingEntrySchema = z
	.object({
		initiatorOwnerSignPub: b64Field(),
		rendezvousId: b64Field(),
	})
	.meta({ id: "TrustPendingEntry" });

export const TrustPendingResultSchema = z
	.object({
		ok: z.boolean(),
		error: z.string().optional(),
		pending: z.array(TrustPendingEntrySchema).optional(),
	})
	.meta({ id: "TrustPendingResult" });

export const TransportRequestSchema = z
	.object({
		signerSignPub: b64Field(),
		proofAt: z.number().int().nonnegative(),
		nonce: b64Field(),
		proof: b64Field(),
	})
	.meta({ id: "TransportRequest" });

export const TransportResultSchema = z
	.object({
		ok: z.boolean(),
		routerUrl: z.string().optional(),
		routerCertFp: z.string().optional(),
		bearer: z.string().optional(),
		error: z.string().optional(),
	})
	.meta({ id: "TransportResult" });

export type RosterRequest = z.infer<typeof RosterRequestSchema>;
export type RosterMember = z.infer<typeof RosterMemberSchema>;
export type RosterResult = z.infer<typeof RosterResultSchema>;
export type TrustPendingRequest = z.infer<typeof TrustPendingRequestSchema>;
export type TrustPendingEntry = z.infer<typeof TrustPendingEntrySchema>;
export type TrustPendingResult = z.infer<typeof TrustPendingResultSchema>;
export type TransportRequest = z.infer<typeof TransportRequestSchema>;
export type TransportResult = z.infer<typeof TransportResultSchema>;

export const ROSTER_MAX_SKEW_MS = 120_000;

export const TRANSPORT_MAX_SKEW_MS = 120_000;

export function rosterRequestSigningBytes(signerSignPubB64: string, proofAt: number, nonce: string): Buffer {
	// Signing bytes must match the Kotlin twin byte for byte.
	return Buffer.from([SIGNING_TAGS.roster, signerSignPubB64, String(proofAt), nonce].join("\n"), "utf8");
}

export function signRosterRequest(
	signerSignPubB64: string,
	proofAt: number,
	nonce: string,
	signPrivB64: string,
): string {
	return sign(rosterRequestSigningBytes(signerSignPubB64, proofAt, nonce), signPrivB64);
}

export function verifyRosterRequest(req: RosterRequest): boolean {
	return verify(rosterRequestSigningBytes(req.signerSignPub, req.proofAt, req.nonce), req.proof, req.signerSignPub);
}

export const TRUST_PENDING_MAX_SKEW_MS = 120_000;

export function trustPendingSigningBytes(signerSignPubB64: string, proofAt: number, nonce: string): Buffer {
	// Signing bytes must match the Kotlin twin byte for byte.
	return Buffer.from([SIGNING_TAGS.trustPending, signerSignPubB64, String(proofAt), nonce].join("\n"), "utf8");
}

export function signTrustPendingRequest(
	signerSignPubB64: string,
	proofAt: number,
	nonce: string,
	signPrivB64: string,
): string {
	return sign(trustPendingSigningBytes(signerSignPubB64, proofAt, nonce), signPrivB64);
}

export function verifyTrustPendingRequest(req: TrustPendingRequest): boolean {
	return verify(trustPendingSigningBytes(req.signerSignPub, req.proofAt, req.nonce), req.proof, req.signerSignPub);
}

export const TRANSPORT_REQUEST_MAX_SKEW_MS = 120_000;

export function transportRequestSigningBytes(signerSignPubB64: string, proofAt: number, nonce: string): Buffer {
	// Signing bytes must match the Kotlin twin byte for byte.
	return Buffer.from([SIGNING_TAGS.transportRequest, signerSignPubB64, String(proofAt), nonce].join("\n"), "utf8");
}

export function signTransportRequest(
	signerSignPubB64: string,
	proofAt: number,
	nonce: string,
	signerSignPrivB64: string,
): TransportRequest {
	return {
		signerSignPub: signerSignPubB64,
		proofAt,
		nonce,
		proof: sign(transportRequestSigningBytes(signerSignPubB64, proofAt, nonce), signerSignPrivB64),
	};
}

export function verifyTransportRequest(req: TransportRequest): boolean {
	return verify(
		transportRequestSigningBytes(req.signerSignPub, req.proofAt, req.nonce),
		req.proof,
		req.signerSignPub,
	);
}
