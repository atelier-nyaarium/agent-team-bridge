import {
	type SignedAdmission,
	SignedAdmissionSchema,
	type SignedRevocation,
	verifyRegistration,
} from "../shared/admission.js";
import type { GatewayRegisterParams } from "../shared/router-protocol.js";

////////////////////////////////
//  Interfaces & Types

export interface FederationTrust {
	ownerSignPub: string;
	revocations?: SignedRevocation[];
}

////////////////////////////////
//  Functions & Helpers

export function verifyRegistrationClaim(
	params: GatewayRegisterParams,
	trust: FederationTrust,
	nowMs: number = Date.now(),
): string | null {
	const { gatewayId, signPub, boxPub, admission, proof, proofAt, proofNonce } = params;
	if (!signPub || !boxPub || !admission || !proof || proofAt === undefined || !proofNonce) {
		return "admitted-identity proof required";
	}
	let signed: SignedAdmission;
	try {
		const decoded = SignedAdmissionSchema.safeParse(JSON.parse(admission));
		if (!decoded.success) return "malformed admission";
		signed = decoded.data;
	} catch {
		return "malformed admission";
	}
	return verifyRegistration(
		{ gatewayId, signPub, boxPub, admission: signed, proof, proofAt, nonce: proofNonce },
		{ ownerSignPub: trust.ownerSignPub, revocations: trust.revocations, nowMs },
	);
}
