import { z } from "zod";
import { sign, verify } from "./crypto.js";

////////////////////////////////
//  Domain admission + allowlist (the trust model)
//
//  Membership is an allowlist of owner-signed admissions: the owner device attests a
//  subject's keys (a Gateway or console) into the Domain. evie and each Gateway hold
//  the allowlist, so a revocation bites even while evie is unreachable. The owner is
//  the single root of trust; an admission or revocation is honored only if it verifies
//  under the expected owner key.
//
//  The signing bytes are a versioned, newline-joined, fixed-order encoding. Every field
//  is base64, a slug, or a decimal int, so none can contain a newline and the encoding
//  reproduces byte-for-byte on switchboard, evie, and Android. Do NOT sign raw JSON: key
//  order is not canonical.

////////////////////////////////
//  Schemas

export const AdmissionKindSchema = z.enum(["gateway", "console"]);

export const AdmissionSchema = z
	.object({
		kind: AdmissionKindSchema,
		// Raw Ed25519 signing public key of the subject (base64).
		signPub: z.string().min(1),
		// Raw X25519 box public key of the subject (base64).
		boxPub: z.string().min(1),
		// The Gateway id this admission grants (gateway admissions only).
		gatewayId: z.string().optional(),
		// Issue time (epoch ms); a later revocation with issuedAt >= this wins.
		issuedAt: z.number().int().nonnegative(),
		// Single-use random (base64), so a re-issued admission is a distinct bytestring.
		nonce: z.string().min(1),
	})
	.meta({ id: "Admission" });

export const SignedAdmissionSchema = z
	.object({
		admission: AdmissionSchema,
		// Informational; the verifier checks it against the Domain's expected owner
		// key and never trusts this field alone.
		ownerSignPub: z.string().min(1),
		// Owner's Ed25519 signature over admissionSigningBytes (base64).
		signature: z.string().min(1),
	})
	.meta({ id: "SignedAdmission" });

export const RevocationSchema = z
	.object({
		// The revoked subject's raw Ed25519 signing public key (base64).
		signPub: z.string().min(1),
		issuedAt: z.number().int().nonnegative(),
		nonce: z.string().min(1),
	})
	.meta({ id: "Revocation" });

export const SignedRevocationSchema = z
	.object({
		revocation: RevocationSchema,
		ownerSignPub: z.string().min(1),
		signature: z.string().min(1),
	})
	.meta({ id: "SignedRevocation" });

/** The mirrored Domain state evie pushes to each Gateway (owner root plus the
 * owner-signed allowlist) so a revocation bites even while evie is unreachable.
 * Present only once the Domain is rooted. */
export const DomainSnapshotSchema = z
	.object({
		ownerSignPub: z.string().min(1),
		admissions: z.array(SignedAdmissionSchema),
		revocations: z.array(SignedRevocationSchema),
		// The display name (one per owner/Domain), propagated so Peers see the owner's
		// self-set label instead of a local alias. Nullable for decode tolerance: an
		// older snapshot omits it and consumers fall back to a local label.
		displayName: z.string().nullish(),
	})
	.meta({ id: "DomainSnapshot" });

////////////////////////////////
//  Types

export type AdmissionKind = z.infer<typeof AdmissionKindSchema>;
export type Admission = z.infer<typeof AdmissionSchema>;
export type SignedAdmission = z.infer<typeof SignedAdmissionSchema>;
export type Revocation = z.infer<typeof RevocationSchema>;
export type SignedRevocation = z.infer<typeof SignedRevocationSchema>;
export type DomainSnapshot = z.infer<typeof DomainSnapshotSchema>;

////////////////////////////////
//  Functions & Helpers

export function admissionSigningBytes(a: Admission): Buffer {
	return Buffer.from(
		["ADMISSION_V1", a.kind, a.signPub, a.boxPub, a.gatewayId ?? "", String(a.issuedAt), a.nonce].join("\n"),
		"utf8",
	);
}

export function revocationSigningBytes(r: Revocation): Buffer {
	return Buffer.from(["REVOCATION_V1", r.signPub, String(r.issuedAt), r.nonce].join("\n"), "utf8");
}

/** Owner-sign an admission (the owner device holds the signing key). */
export function signAdmission(
	admission: Admission,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedAdmission {
	return {
		admission,
		ownerSignPub: ownerSignPubB64,
		signature: sign(admissionSigningBytes(admission), ownerSignPrivB64),
	};
}

/** Owner-sign a revocation. */
export function signRevocation(
	revocation: Revocation,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedRevocation {
	return {
		revocation,
		ownerSignPub: ownerSignPubB64,
		signature: sign(revocationSigningBytes(revocation), ownerSignPrivB64),
	};
}

/** True if the admission verifies under the Domain's expected owner key. The
 * claimed ownerSignPub must equal the expected key AND the signature must check. */
export function verifyAdmission(s: SignedAdmission, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(admissionSigningBytes(s.admission), s.signature, expectedOwnerSignPubB64);
}

export function verifyRevocation(s: SignedRevocation, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(revocationSigningBytes(s.revocation), s.signature, expectedOwnerSignPubB64);
}

/** The newest owner-verified admission matching `match`, before revocations are applied.
 * Shared by `resolveAdmitted` (match by signing key) and the gateway's `resolveGateway`
 * (match by gateway id), so the iterate, verify-owner, and newest-wins rule lives in one
 * place (the Kotlin `Keyring` factors it the same way). Callers apply revocations. */
export function findAdmission(
	allowlist: SignedAdmission[],
	expectedOwnerSignPubB64: string,
	match: (admission: Admission) => boolean,
): Admission | null {
	let best: Admission | null = null;
	for (const s of allowlist) {
		if (!match(s.admission)) continue;
		if (!verifyAdmission(s, expectedOwnerSignPubB64)) continue;
		if (!best || s.admission.issuedAt > best.issuedAt) best = s.admission;
	}
	return best;
}

/** Resolve a subject's admission from the allowlist: the newest owner-verified
 * admission for `subjectSignPub` that is not overridden by a later owner-verified
 * revocation. Returns the admitted Admission (carrying its boxPub / gatewayId) or
 * null when not admitted or revoked. */
export function resolveAdmitted(
	allowlist: SignedAdmission[],
	revocations: SignedRevocation[],
	expectedOwnerSignPubB64: string,
	subjectSignPubB64: string,
): Admission | null {
	const best = findAdmission(allowlist, expectedOwnerSignPubB64, (a) => a.signPub === subjectSignPubB64);
	if (!best) return null;
	for (const r of revocations) {
		if (r.revocation.signPub !== subjectSignPubB64) continue;
		if (!verifyRevocation(r, expectedOwnerSignPubB64)) continue;
		// A revocation at or after the admission revokes it.
		if (r.revocation.issuedAt >= best.issuedAt) return null;
	}
	return best;
}

////////////////////////////////
//  Registration proof-of-possession
//
//  An admission is owner-signed but not secret: it rides every registration, so an
//  observer could replay one to impersonate the admitted Gateway. The registering
//  Gateway proves it holds the admitted signing key by signing a self-timestamped
//  challenge carrying a fresh random nonce. The verifier checks the signature against
//  the admission's signPub, that the timestamp is fresh, and (statefully, on evie) that
//  the nonce has not been seen within the window, so a captured proof cannot be replayed
//  even inside the skew window. The bytes use the same versioned newline encoding as
//  admissions.

/** Default proof freshness window (epoch ms). A proof further than this from the
 * verifier's clock is rejected as stale, and the seen-nonce cache only needs to
 * remember this long. */
export const REGISTER_MAX_SKEW_MS = 120_000;

export function registerSigningBytes(gatewayId: string, proofAt: number, nonce: string): Buffer {
	return Buffer.from(["REGISTER_V1", gatewayId, String(proofAt), nonce].join("\n"), "utf8");
}

/** Sign a fresh registration proof with the Gateway's raw Ed25519 private key. */
export function signRegister(gatewayId: string, proofAt: number, nonce: string, signPrivB64: string): string {
	return sign(registerSigningBytes(gatewayId, proofAt, nonce), signPrivB64);
}

export function verifyRegister(
	gatewayId: string,
	proofAt: number,
	nonce: string,
	sigB64: string,
	signPubB64: string,
): boolean {
	return verify(registerSigningBytes(gatewayId, proofAt, nonce), sigB64, signPubB64);
}

export interface RegistrationClaim {
	gatewayId: string;
	signPub: string;
	boxPub: string;
	admission: SignedAdmission;
	proof: string;
	proofAt: number;
	nonce: string;
}

export interface RegistrationTrust {
	ownerSignPub: string;
	revocations?: SignedRevocation[];
	nowMs: number;
	maxSkewMs?: number;
}

/** Verify an admitted Gateway's registration end to end: the admission is owner-signed
 * and not revoked, binds this Gateway id, both keys, and a `gateway` kind, and the proof
 * shows the connection holds the admitted signing key freshly. Returns null on success,
 * or a short rejection reason. The caller (evie) also rejects a replayed `nonce` within
 * the window; this pure check cannot dedup statefully. */
export function verifyRegistration(claim: RegistrationClaim, trust: RegistrationTrust): string | null {
	const admitted = resolveAdmitted([claim.admission], trust.revocations ?? [], trust.ownerSignPub, claim.signPub);
	if (!admitted) return "admission not owner-signed or revoked";
	if (admitted.kind !== "gateway") return "admission is not a gateway admission";
	if (admitted.gatewayId !== claim.gatewayId) return "admission gatewayId does not match";
	// The admission attests both keys, so a registration may not present a different
	// boxPub than the owner signed.
	if (admitted.boxPub !== claim.boxPub) return "admission boxPub does not match";
	const skew = Math.abs(trust.nowMs - claim.proofAt);
	if (skew > (trust.maxSkewMs ?? REGISTER_MAX_SKEW_MS)) return "registration proof is stale";
	if (!verifyRegister(claim.gatewayId, claim.proofAt, claim.nonce, claim.proof, claim.signPub)) {
		return "registration proof invalid";
	}
	return null;
}
