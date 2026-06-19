// Domain rooting for the owner setup flow.
//
// Phone-anchored trust: the OWNER root keypair is generated on the admin Console and never leaves
// it. This roots evie's Domain at the Console's owner PUBLIC keys (read by the operator from the
// app) - it mints nothing and signs nothing, so no private key is created or held host-side. The
// Console admits every Gateway and Console itself afterward, so this runs once to seat the root.
//
// Preserves evie's own identity verbatim (rooting must not change evie's SAS). Prior admissions /
// revocations are kept ONLY when re-rooting at the SAME owner key (a Console re-running setup from
// its backed-up owner key); a DIFFERENT owner key starts a fresh Domain (old admissions were signed
// by a key that no longer verifies).

import type { SignedAdmission, SignedRevocation } from "../src/shared/admission.js";
import type { Identity } from "../src/shared/crypto.js";

////////////////////////////////
//  Interfaces & Types

interface PriorEnrollment {
	ownerSignPub?: string;
	admissions?: SignedAdmission[];
	revocations?: SignedRevocation[];
}

interface EvieFederation {
	identity?: Identity;
	enrollment?: PriorEnrollment;
}

export interface BootstrapResult {
	ownerSignPub: string;
	federationJson: {
		identity: Identity;
		enrollment: {
			ownerSignPub: string;
			ownerBoxPub: string;
			admissions: SignedAdmission[];
			revocations: SignedRevocation[];
		};
	};
}

////////////////////////////////
//  Functions & Helpers

/** Validate a raw-32-byte key (base64). Rejects a typo/garbage owner key here, where the error is
 * actionable, instead of letting it root evie and then fail silently everywhere (a malformed key
 * filters out every admission downstream). */
function assertKey(label: string, value: string): string {
	if (Buffer.from(value, "base64").length !== 32) {
		throw new Error(`${label} is not a base64-encoded 32-byte key - re-copy it from the Console's Owner setup`);
	}
	return value;
}

/** Root evie's Domain at the Console owner's public keys, preserving evie's identity. `evieFedJson`
 * is the live evie federation.json text; the owner keys are base64 raw-32-byte public keys. */
export function bootstrapDomain(evieFedJson: string, ownerSignPub: string, ownerBoxPub: string): BootstrapResult {
	assertKey("owner signing key", ownerSignPub);
	assertKey("owner box key", ownerBoxPub);

	// evie's CURRENT identity, preserved verbatim so rooting never re-mints evie's keypair (which
	// would change its fingerprint). A malformed Secret gets an actionable message, not a raw
	// SyntaxError, the same way assertKey rejects a bad owner key.
	let evieFed: EvieFederation;
	try {
		evieFed = JSON.parse(evieFedJson) as EvieFederation;
	} catch {
		throw new Error(
			"evie federation Secret is not valid JSON - check `kubectl get secret evie-federation -o json`",
		);
	}
	const evieIdentity = evieFed.identity;
	if (!evieIdentity?.sign?.pub || !evieIdentity?.box?.pub) {
		throw new Error("evie federation Secret has no usable identity (.identity.sign/.box)");
	}

	// Keep the existing allowlist only when re-rooting at the same owner; a different owner key is a
	// fresh Domain (prior admissions would not verify under it).
	const sameOwner = evieFed.enrollment?.ownerSignPub === ownerSignPub;
	const admissions = sameOwner ? (evieFed.enrollment?.admissions ?? []) : [];
	const revocations = sameOwner ? (evieFed.enrollment?.revocations ?? []) : [];

	return {
		ownerSignPub,
		federationJson: {
			identity: evieIdentity,
			enrollment: { ownerSignPub, ownerBoxPub, admissions, revocations },
		},
	};
}
