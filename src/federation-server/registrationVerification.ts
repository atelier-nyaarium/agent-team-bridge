import {
	type SignedAdmission,
	SignedAdmissionSchema,
	type SignedRevocation,
	verifyRegistration,
} from "../shared/admission.js";
import type { GatewayRegisterParams } from "../shared/router-protocol.js";

export interface FederationTrust {
	ownerSignPub: string;
	revocations?: SignedRevocation[];
}

export type RegistrationVerdict = { denied: string; admission?: never } | { denied: null; admission: SignedAdmission };

/** The presented admission comes back verified, for the per-frame revocation recheck. */
export function verifyRegistrationClaim(
	params: GatewayRegisterParams,
	trust: FederationTrust,
	nowMs: number,
): RegistrationVerdict {
	const { gatewayId, signPub, boxPub, admission, proof, proofAt, proofNonce } = params;
	if (!signPub || !boxPub || !admission || !proof || proofAt === undefined || !proofNonce) {
		return { denied: "admitted-identity proof required" };
	}
	let signed: SignedAdmission;
	try {
		const decoded = SignedAdmissionSchema.safeParse(JSON.parse(admission));
		if (!decoded.success) return { denied: "malformed admission" };
		signed = decoded.data;
	} catch {
		return { denied: "malformed admission" };
	}
	const denied = verifyRegistration(
		{ gatewayId, signPub, boxPub, admission: signed, proof, proofAt, nonce: proofNonce },
		{ ownerSignPub: trust.ownerSignPub, revocations: trust.revocations, nowMs },
	);
	return denied ? { denied } : { denied: null, admission: signed };
}
