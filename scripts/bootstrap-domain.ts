// Domain rooting for the owner setup script (provision-owner.sh --setup).
//
// Phone-anchored trust: the OWNER root keypair is generated on the admin Console and
// never leaves it. This helper roots evie's Domain at the Console's owner PUBLIC keys
// (read by the operator from the app) - it mints nothing and signs nothing, so no
// private key is created or held host-side. The Console admits every Switch and Console
// itself afterward (owner-signed submit_admission), so this runs once to seat the root.
//
// Preserves evie's own identity verbatim (rooting must not change evie's SAS). Prior
// admissions/revocations are kept ONLY when re-rooting at the SAME owner key (a Console
// re-running setup from its backed-up owner key); a DIFFERENT owner key starts a fresh
// Domain (old admissions were signed by a key that no longer verifies).
//
// I/O is bun-only. Inputs arrive as RAW strings on the ENVIRONMENT (never argv, which is
// world-readable in `ps`):
//   env in:  SB_EVIE_FED         the live evie federation.json text (.identity preserved,
//                                .enrollment kept iff the owner key is unchanged)
//            SB_OWNER_SIGN_PUB    the Console owner's Ed25519 signing public key (base64)
//            SB_OWNER_BOX_PUB     the Console owner's X25519 box public key (base64)
//   stdout:  { ownerSignPub, federationJson }

import type { SignedAdmission, SignedRevocation } from "../src/shared/admission.js";
import type { Identity } from "../src/shared/crypto.js";

////////////////////////////////
//  Interfaces & Types

interface PriorEnrollment {
	ownerSignPub?: string;
	admissions?: SignedAdmission[];
	revocations?: SignedRevocation[];
}

////////////////////////////////
//  Functions & Helpers

function reqEnv(name: string): string {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
	return v;
}

/** A required raw-32-byte key (base64). Rejects a typo/garbage owner key here, where the
 * error is actionable, instead of letting it root evie and then fail silently everywhere
 * (verify() swallows a malformed key and filters out every admission). */
function reqKey(name: string): string {
	const v = reqEnv(name);
	if (Buffer.from(v, "base64").length !== 32) {
		throw new Error(`${name} is not a base64-encoded 32-byte key - re-copy it from the Console's Owner setup`);
	}
	return v;
}

function main(): void {
	// evie's CURRENT identity - preserved verbatim so rooting never re-mints evie's
	// keypair (which would change its fingerprint).
	const evieFed = JSON.parse(reqEnv("SB_EVIE_FED")) as { identity?: Identity; enrollment?: PriorEnrollment };
	const evieIdentity = evieFed.identity;
	if (!evieIdentity?.sign?.pub || !evieIdentity?.box?.pub) {
		throw new Error("evie federation Secret has no usable identity (.identity.sign/.box)");
	}

	const ownerSignPub = reqKey("SB_OWNER_SIGN_PUB");
	const ownerBoxPub = reqKey("SB_OWNER_BOX_PUB");

	// Keep the existing allowlist only when re-rooting at the same owner; a different
	// owner key is a fresh Domain (prior admissions would not verify under it).
	const sameOwner = evieFed.enrollment?.ownerSignPub === ownerSignPub;
	const admissions = sameOwner ? (evieFed.enrollment?.admissions ?? []) : [];
	const revocations = sameOwner ? (evieFed.enrollment?.revocations ?? []) : [];

	const federationJson = {
		identity: evieIdentity,
		enrollment: { ownerSignPub, ownerBoxPub, admissions, revocations },
	};

	process.stdout.write(JSON.stringify({ ownerSignPub, federationJson }));
}

main();
