import { z } from "zod";
import { b64Field, displayField, sign, verify } from "./crypto.js";

////////////////////////////////
//  Proof-of-possession query surfaces (roster / trust-pending / transport)
//
//  Three signed point-in-time queries to the Router, one pattern: the caller signs a versioned,
//  newline-joined challenge over its own signing key + a fresh timestamp + nonce. The Router
//  verifies the signature against the key, that the timestamp is fresh, and (statefully) that the
//  nonce is unseen in the window; what the key must then prove differs per surface (see each
//  schema's own doc). So a captured request cannot be replayed. Distinct version tags keep the
//  three proofs non-interchangeable.

////////////////////////////////
//  Cross-tenant roster (the "Users" surface: everyone on this Router, name + presence)
//
//  The Router is the source of truth (per-Domain display names + owners in its store; presence is
//  its live gateway-connection table). The visibility model is a full roster: every member on this
//  Router is visible to every other member, non-transitive (the roster never reaches a member's
//  linked peers). So the request only AUTHENTICATES the caller as some member of this Router (a
//  console admitted in one of its Domains); there is no per-row visibility predicate. A row carries
//  the owner identity + display name + presence ONLY: NO gatewayId and NO box key, so a row is
//  never a seal/probe handle (the trust ceremony resolves a target's gateway server-side). The
//  Router OPAQUE-REJECTS a caller it cannot place in a Domain.

/** A console's signed request for the roster. The console signs ROSTER_V1 over its own signing key
 * + a fresh timestamp + nonce (proof of possession); the Router verifies the signature, freshness,
 * and non-replay, then resolves the signer to an admitted console in one of its Domains. */
export const RosterRequestSchema = z
	.object({
		// The console's raw Ed25519 signing key (the subject of an owner-signed kind:console admission).
		signerSignPub: b64Field(),
		// Proof timestamp (epoch ms), freshness-checked against the Router's clock.
		proofAt: z.number().int().nonnegative(),
		// Single-use random (base64); the Router rejects a replayed nonce within the freshness window.
		nonce: b64Field(),
		// The console's Ed25519 signature over rosterRequestSigningBytes (base64).
		proof: b64Field(),
	})
	.meta({ id: "RosterRequest" });

/** One member row in the roster: the owner identity (the trust anchor; the phone derives the
 * fingerprint from it), the display name, and a presence boolean. Deliberately NO gatewayId
 * / box key / domainId - a row is an identity, never a routing or seal handle, and topology is
 * stripped. */
export const RosterMemberSchema = z
	.object({
		ownerSignPub: b64Field(),
		displayName: displayField(128),
		// True iff this member's Domain has a live gateway connection at the Router right now.
		online: z.boolean(),
	})
	.meta({ id: "RosterMember" });

/** The Router's roster reply. `ok:false` + `error` is an OPAQUE reject (the caller could not be
 * placed in a Domain on this Router, or the proof failed) - it never enumerates Domain state. */
export const RosterResultSchema = z
	.object({
		ok: z.boolean(),
		error: z.string().optional(),
		// Present only on success; absent on an opaque reject.
		members: z.array(RosterMemberSchema).optional(),
	})
	.meta({ id: "RosterResult" });

/** A target's signed "who armed trust toward me?" query (the highlight). The target signs
 * TRUST_PENDING_V1 over its OWN owner signing key + a fresh timestamp + nonce (proof of possession);
 * the Router verifies the signature, freshness, and non-replay, then returns the arms indexed under
 * that owner key. Only the owner-key holder can enumerate the arms aimed at it. */
export const TrustPendingRequestSchema = z
	.object({
		signerSignPub: b64Field(),
		proofAt: z.number().int().nonnegative(),
		nonce: b64Field(),
		proof: b64Field(),
	})
	.meta({ id: "TrustPendingRequest" });

/** One armed trust intent toward the querying owner: who armed it + the rendezvous to join. */
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
		// Present only on success; absent on an opaque reject.
		pending: z.array(TrustPendingEntrySchema).optional(),
	})
	.meta({ id: "TrustPendingResult" });

////////////////////////////////
//  Transport request (an owner pulling its network's gateway-bridge transport)
//
//  An owner phone asks the Router for the gateway-bridge transport blob (the cluster SA token + CA)
//  by proving it owns a rooted network. It signs TRANSPORT_REQUEST_V1 over its OWN owner signing
//  key + a fresh timestamp + nonce (proof of possession), mirroring the roster / trust-pending
//  proofs. The Router verifies the signature, freshness, and non-replay, then resolves the signer
//  to a rooted owner and returns the transport.

/** An owner's signed request for its network's gateway-bridge transport. */
export const TransportRequestSchema = z
	.object({
		signerSignPub: b64Field(),
		proofAt: z.number().int().nonnegative(),
		nonce: b64Field(),
		proof: b64Field(),
	})
	.meta({ id: "TransportRequest" });

/** The Router's transport reply. `ok:false` + `error` is an OPAQUE reject (the proof failed or the
 * signer is not a rooted owner). On success it carries the gateway-bridge transport creds. */
export const TransportResultSchema = z
	.object({
		ok: z.boolean(),
		// Absent reads as "k8s", so an older Router's reply still installs.
		transport: z.enum(["k8s", "direct"]).optional(),
		saToken: z.string().optional(),
		caPem: z.string().optional(),
		// The direct branch: what a Gateway needs to dial the Router and pin it.
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

////////////////////////////////
//  Functions & Helpers

/** Default roster-proof freshness window (epoch ms), same posture as the registration proof. */
export const ROSTER_MAX_SKEW_MS = 120_000;

/** Transport-proof freshness window. Its own constant rather than a shared one: this reply carries
 * the gateway-plane bearer, so its window is a security parameter that must be tunable without
 * widening the roster's. Same value today, for unrelated reasons. */
export const TRANSPORT_MAX_SKEW_MS = 120_000;

export function rosterRequestSigningBytes(signerSignPubB64: string, proofAt: number, nonce: string): Buffer {
	return Buffer.from(["ROSTER_V1", signerSignPubB64, String(proofAt), nonce].join("\n"), "utf8");
}

/** Sign a fresh roster request with the console's raw Ed25519 private key. */
export function signRosterRequest(
	signerSignPubB64: string,
	proofAt: number,
	nonce: string,
	signPrivB64: string,
): string {
	return sign(rosterRequestSigningBytes(signerSignPubB64, proofAt, nonce), signPrivB64);
}

/** True if the roster request's proof verifies under its claimed signer key. The caller (the Router)
 * additionally checks freshness, non-replay, and that the signer is an admitted console. */
export function verifyRosterRequest(req: RosterRequest): boolean {
	return verify(rosterRequestSigningBytes(req.signerSignPub, req.proofAt, req.nonce), req.proof, req.signerSignPub);
}

/** Default trust-pending-proof freshness window (epoch ms), same posture as the roster proof. */
export const TRUST_PENDING_MAX_SKEW_MS = 120_000;

/** Canonical TRUST_PENDING_V1 proof-of-possession bytes: the querying OWNER's signing key + a fresh
 * timestamp + nonce. A distinct version tag from ROSTER_V1 so a roster proof can never be replayed as
 * a trust-pending query and vice versa. */
export function trustPendingSigningBytes(signerSignPubB64: string, proofAt: number, nonce: string): Buffer {
	return Buffer.from(["TRUST_PENDING_V1", signerSignPubB64, String(proofAt), nonce].join("\n"), "utf8");
}

/** Sign a fresh trust-pending query with the querying owner's raw Ed25519 private key. */
export function signTrustPendingRequest(
	signerSignPubB64: string,
	proofAt: number,
	nonce: string,
	signPrivB64: string,
): string {
	return sign(trustPendingSigningBytes(signerSignPubB64, proofAt, nonce), signPrivB64);
}

/** True if the trust-pending query's proof verifies under its claimed owner key. The caller (the
 * Router) additionally checks freshness + non-replay before returning the arms indexed under that
 * owner. */
export function verifyTrustPendingRequest(req: TrustPendingRequest): boolean {
	return verify(trustPendingSigningBytes(req.signerSignPub, req.proofAt, req.nonce), req.proof, req.signerSignPub);
}

/** Default transport-proof freshness window (epoch ms), same posture as the roster proof. */
export const TRANSPORT_REQUEST_MAX_SKEW_MS = 120_000;

/** Canonical TRANSPORT_REQUEST_V1 proof-of-possession bytes: the requesting OWNER's signing key + a
 * fresh timestamp + nonce. A distinct version tag from ROSTER_V1 / TRUST_PENDING_V1 so neither proof
 * can be replayed as a transport request and vice versa. */
export function transportRequestSigningBytes(signerSignPubB64: string, proofAt: number, nonce: string): Buffer {
	return Buffer.from(["TRANSPORT_REQUEST_V1", signerSignPubB64, String(proofAt), nonce].join("\n"), "utf8");
}

/** Sign a fresh transport request with the requesting owner's raw Ed25519 private key (private key
 * last, matching signRosterRequest / signTrustPendingRequest and the Kotlin twin). */
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

/** True if the transport request's proof verifies under its claimed owner key. The caller (the
 * Router) additionally checks freshness, non-replay, and that the signer is a rooted owner before
 * returning the transport. */
export function verifyTransportRequest(req: TransportRequest): boolean {
	return verify(
		transportRequestSigningBytes(req.signerSignPub, req.proofAt, req.nonce),
		req.proof,
		req.signerSignPub,
	);
}
