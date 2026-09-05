import { z } from "zod";
import { sign, verify } from "./crypto.js";
import { SIGNING_TAGS } from "./wire-vocabulary.js";

// Owner-signed admissions are the Domain root of trust.
export const AdmissionKindSchema = z.enum(["gateway", "console"]);

export const AdmissionSchema = z
	.object({
		kind: AdmissionKindSchema,
		signPub: z.string().min(1),
		boxPub: z.string().min(1),
		gatewayId: z.string().optional(),
		issuedAt: z.number().int().nonnegative(),
		nonce: z.string().min(1),
	})
	.meta({ id: "Admission" });

export const SignedAdmissionSchema = z
	.object({
		admission: AdmissionSchema,
		ownerSignPub: z.string().min(1),
		signature: z.string().min(1),
	})
	.meta({ id: "SignedAdmission" });

export const RevocationSchema = z
	.object({
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

export const DomainSnapshotSchema = z
	.object({
		ownerSignPub: z.string().min(1),
		admissions: z.array(SignedAdmissionSchema),
		// Revocations remain effective while the Router is unreachable.
		revocations: z.array(SignedRevocationSchema),
		displayName: z.string().nullish(),
	})
	.meta({ id: "DomainSnapshot" });

export type AdmissionKind = z.infer<typeof AdmissionKindSchema>;
export type Admission = z.infer<typeof AdmissionSchema>;
export type SignedAdmission = z.infer<typeof SignedAdmissionSchema>;
export type Revocation = z.infer<typeof RevocationSchema>;
export type SignedRevocation = z.infer<typeof SignedRevocationSchema>;
export type DomainSnapshot = z.infer<typeof DomainSnapshotSchema>;

export function admissionSigningBytes(a: Admission): Buffer {
	// Fixed-order newline encoding is shared byte-for-byte with Android.
	return Buffer.from(
		[SIGNING_TAGS.admission, a.kind, a.signPub, a.boxPub, a.gatewayId ?? "", String(a.issuedAt), a.nonce].join(
			"\n",
		),
		"utf8",
	);
}

export function revocationSigningBytes(r: Revocation): Buffer {
	return Buffer.from([SIGNING_TAGS.revocation, r.signPub, String(r.issuedAt), r.nonce].join("\n"), "utf8");
}

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

export function verifyAdmission(s: SignedAdmission, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(admissionSigningBytes(s.admission), s.signature, expectedOwnerSignPubB64);
}

export function verifyRevocation(s: SignedRevocation, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(revocationSigningBytes(s.revocation), s.signature, expectedOwnerSignPubB64);
}

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
		// Equal timestamps revoke the admission.
		if (r.revocation.issuedAt >= best.issuedAt) return null;
	}
	return best;
}

export function resolveAdmittedConsole(
	allowlist: SignedAdmission[],
	revocations: SignedRevocation[],
	expectedOwnerSignPubB64: string,
	subjectSignPubB64: string,
): Admission | null {
	const admission = resolveAdmitted(allowlist, revocations, expectedOwnerSignPubB64, subjectSignPubB64);
	return admission?.kind === "console" ? admission : null;
}

/** Default registration proof freshness window. */
export const REGISTER_MAX_SKEW_MS = 120_000;

export function registerSigningBytes(gatewayId: string, proofAt: number, nonce: string): Buffer {
	return Buffer.from([SIGNING_TAGS.register, gatewayId, String(proofAt), nonce].join("\n"), "utf8");
}

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

// Nonce replay checks remain stateful at the Router.
export function verifyRegistration(claim: RegistrationClaim, trust: RegistrationTrust): string | null {
	const admitted = resolveAdmitted([claim.admission], trust.revocations ?? [], trust.ownerSignPub, claim.signPub);
	if (!admitted) return "admission not owner-signed or revoked";
	if (admitted.kind !== "gateway") return "admission is not a gateway admission";
	if (admitted.gatewayId !== claim.gatewayId) return "admission gatewayId does not match";
	// The admission binds the box key.
	if (admitted.boxPub !== claim.boxPub) return "admission boxPub does not match";
	const skew = Math.abs(trust.nowMs - claim.proofAt);
	if (skew > (trust.maxSkewMs ?? REGISTER_MAX_SKEW_MS)) return "registration proof is stale";
	if (!verifyRegister(claim.gatewayId, claim.proofAt, claim.nonce, claim.proof, claim.signPub)) {
		return "registration proof invalid";
	}
	return null;
}
