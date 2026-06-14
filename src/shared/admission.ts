import { z } from "zod";
import { sign, verify } from "./crypto.js";

////////////////////////////////
//  Domain admission + allowlist (the trust model)
//
//  Membership in the Domain is an allowlist of OWNER-SIGNED admissions: the owner
//  device attests a subject's keys (a Host or a phone) into the Domain. evie AND
//  each Host hold the allowlist, so a revocation bites even while evie is
//  unreachable (audit R3). The owner is the single root of trust; an admission /
//  revocation is only honored if it verifies under the expected owner key.
//
//  The SIGNING BYTES are a versioned, newline-joined, fixed-order encoding. Every
//  field is base64 (keys, nonce), a slug (hostId), or a decimal int (issuedAt) -
//  none can contain a newline - so the encoding is unambiguous and reproduces
//  byte-for-byte on switchboard, evie, and Android. Do NOT sign raw JSON (key
//  order is not canonical).

////////////////////////////////
//  Schemas

export const AdmissionKindSchema = z.enum(["host", "phone"]);

export const AdmissionSchema = z
	.object({
		kind: AdmissionKindSchema,
		// Raw Ed25519 signing public key of the subject (base64).
		signPub: z.string().min(1),
		// Raw X25519 box public key of the subject (base64).
		boxPub: z.string().min(1),
		// The Host id this admission grants (host admissions only).
		hostId: z.string().optional(),
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

////////////////////////////////
//  Types

export type AdmissionKind = z.infer<typeof AdmissionKindSchema>;
export type Admission = z.infer<typeof AdmissionSchema>;
export type SignedAdmission = z.infer<typeof SignedAdmissionSchema>;
export type Revocation = z.infer<typeof RevocationSchema>;
export type SignedRevocation = z.infer<typeof SignedRevocationSchema>;

////////////////////////////////
//  Functions & Helpers

export function admissionSigningBytes(a: Admission): Buffer {
	return Buffer.from(
		["ADMISSION_V1", a.kind, a.signPub, a.boxPub, a.hostId ?? "", String(a.issuedAt), a.nonce].join("\n"),
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
 * revocation. Returns the admitted Admission (carrying its boxPub / hostId) or
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
