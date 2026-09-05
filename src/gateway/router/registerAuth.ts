import { type SignedAdmission, signRegister } from "../../shared/admission.js";
import type { Ambient } from "../../shared/ambient.js";
import type { Identity } from "../../shared/crypto.js";
import { FEDERATION_PROTOCOL_VERSION } from "../../shared/router-protocol.js";
import { WIRE_NONCE_BYTES } from "../../shared/wire-vocabulary.js";

export interface RegisterAuthDeps {
	gatewayId: string;
	identity: Identity;
	selfAdmission: () => SignedAdmission | null;
	ambient: Pick<Ambient, "now" | "randomBytes">;
}

/** The gateway_register frame as the Router parses it. */
export function registerFrame(
	target: { gatewayId: string; domainId: string },
	auth: Record<string, unknown> | null,
): Record<string, unknown> {
	return {
		gatewayId: target.gatewayId,
		domainId: target.domainId,
		protocolVersion: FEDERATION_PROTOCOL_VERSION,
		...(auth ?? {}),
	};
}

export function buildRegisterAuth(deps: RegisterAuthDeps): Record<string, string | number> | null {
	const self = deps.selfAdmission();
	if (!self) return null;
	const proofAt = deps.ambient.now();
	const proofNonce = deps.ambient.randomBytes(WIRE_NONCE_BYTES).toString("base64");
	return {
		signPub: deps.identity.sign.pub,
		boxPub: deps.identity.box.pub,
		admission: JSON.stringify(self),
		proof: signRegister(deps.gatewayId, proofAt, proofNonce, deps.identity.sign.priv),
		proofAt,
		proofNonce,
	};
}
