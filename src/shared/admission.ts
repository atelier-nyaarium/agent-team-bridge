// SYNC-HASH: 68a289ace733450ddcdb59a519565af4
// SYNCED MODULE - source of truth: switchboard/src/shared/admission.ts
// Copied verbatim into: evie-bot/app/features/bridge/admission.ts
// MUST re-copy on change: cp src/shared/admission.ts ../evie-bot/app/features/bridge/admission.ts
import { z } from "zod";
import { sign, verify } from "./crypto.js";

////////////////////////////////
//  Domain admission + allowlist (the trust model)
//
//  Membership in the Domain is an allowlist of OWNER-SIGNED admissions: the owner
//  device attests a subject's keys (a Switch or a console) into the Domain. evie AND
//  each Switch hold the allowlist, so a revocation bites even while evie is
//  unreachable (audit R3). The owner is the single root of trust; an admission /
//  revocation is only honored if it verifies under the expected owner key.
//
//  The SIGNING BYTES are a versioned, newline-joined, fixed-order encoding. Every
//  field is base64 (keys, nonce), a slug (switchId), or a decimal int (issuedAt) -
//  none can contain a newline - so the encoding is unambiguous and reproduces
//  byte-for-byte on switchboard, evie, and Android. Do NOT sign raw JSON (key
//  order is not canonical).

////////////////////////////////
//  Schemas

export const AdmissionKindSchema = z.enum(["switch", "console"]);

export const AdmissionSchema = z
	.object({
		kind: AdmissionKindSchema,
		// Raw Ed25519 signing public key of the subject (base64).
		signPub: z.string().min(1),
		// Raw X25519 box public key of the subject (base64).
		boxPub: z.string().min(1),
		// The Switch id this admission grants (switch admissions only).
		switchId: z.string().optional(),
		// Issue time (epoch ms); a later revocation with issuedAt >= this wins.
		issuedAt: z.number().int().nonnegative(),
		// Single-use random (base64), so a re-issued admission is a distinct bytestring.
		nonce: z.string().min(1),
	})
	.meta({ id: "Admission" });

export const SignedAdmissionSchema = z
	.object({
		admission: AdmissionSchema,
		// The owner key that signed (informational; the verifier checks it against
		// the Domain's expected owner key, never trusts this field alone).
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

/** The mirrored Domain state evie pushes to each Switch so a revocation bites even
 * while evie is unreachable (audit R3): the owner root plus the owner-signed
 * allowlist. Only present once the Domain is rooted. */
export const DomainSnapshotSchema = z
	.object({
		ownerSignPub: z.string().min(1),
		admissions: z.array(SignedAdmissionSchema),
		revocations: z.array(SignedRevocationSchema),
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
		["ADMISSION_V1", a.kind, a.signPub, a.boxPub, a.switchId ?? "", String(a.issuedAt), a.nonce].join("\n"),
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

/** Resolve a subject's admission from the allowlist: the newest owner-verified
 * admission for `subjectSignPub` that is not overridden by a later owner-verified
 * revocation. Returns the admitted Admission (carrying its boxPub / switchId) or
 * null when not admitted or revoked. */
export function resolveAdmitted(
	allowlist: SignedAdmission[],
	revocations: SignedRevocation[],
	expectedOwnerSignPubB64: string,
	subjectSignPubB64: string,
): Admission | null {
	let best: Admission | null = null;
	for (const s of allowlist) {
		if (s.admission.signPub !== subjectSignPubB64) continue;
		if (!verifyAdmission(s, expectedOwnerSignPubB64)) continue;
		if (!best || s.admission.issuedAt > best.issuedAt) best = s.admission;
	}
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
//  An admission is owner-signed but not secret: it rides every registration, so
//  an observer could replay one to impersonate the admitted Switch. The registering
//  Switch therefore PROVES it holds the admitted signing key by signing a
//  self-timestamped challenge carrying a fresh random NONCE; the verifier checks
//  the signature against the admission's signPub, that the timestamp is fresh, AND
//  (statefully, on evie) that the nonce has not been seen within the window - so a
//  captured proof cannot be replayed even inside the skew window. The bytes are the
//  same versioned newline encoding as admissions.

/** Default proof freshness window (epoch ms). A proof older / newer than this
 * from the verifier's clock is rejected as stale (and the seen-nonce cache only
 * needs to remember this long). */
export const REGISTER_MAX_SKEW_MS = 120_000;

export function registerSigningBytes(switchId: string, proofAt: number, nonce: string): Buffer {
	return Buffer.from(["REGISTER_V1", switchId, String(proofAt), nonce].join("\n"), "utf8");
}

/** Sign a fresh registration proof with the Switch's raw Ed25519 private key. */
export function signRegister(switchId: string, proofAt: number, nonce: string, signPrivB64: string): string {
	return sign(registerSigningBytes(switchId, proofAt, nonce), signPrivB64);
}

export function verifyRegister(
	switchId: string,
	proofAt: number,
	nonce: string,
	sigB64: string,
	signPubB64: string,
): boolean {
	return verify(registerSigningBytes(switchId, proofAt, nonce), sigB64, signPubB64);
}

export interface RegistrationClaim {
	switchId: string;
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

/** Verify an admitted Switch's registration end to end: the admission is
 * owner-signed and not revoked, binds this Switch id + both keys + a `switch` kind,
 * and the proof shows the connection holds the admitted signing key freshly. Returns
 * null on success, or a short rejection reason. The caller (evie) ALSO rejects a
 * replayed `nonce` within the window - this pure check cannot dedup statefully. */
export function verifyRegistration(claim: RegistrationClaim, trust: RegistrationTrust): string | null {
	const admitted = resolveAdmitted([claim.admission], trust.revocations ?? [], trust.ownerSignPub, claim.signPub);
	if (!admitted) return "admission not owner-signed or revoked";
	if (admitted.kind !== "switch") return "admission is not a switch admission";
	if (admitted.switchId !== claim.switchId) return "admission switchId does not match";
	// Bind the box key too: the admission attests both keys, so a registration may
	// not present a different boxPub than the owner signed.
	if (admitted.boxPub !== claim.boxPub) return "admission boxPub does not match";
	const skew = Math.abs(trust.nowMs - claim.proofAt);
	if (skew > (trust.maxSkewMs ?? REGISTER_MAX_SKEW_MS)) return "registration proof is stale";
	if (!verifyRegister(claim.switchId, claim.proofAt, claim.nonce, claim.proof, claim.signPub)) {
		return "registration proof invalid";
	}
	return null;
}
