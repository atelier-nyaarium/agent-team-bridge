import { type SignedAdmission, verifyAdmission } from "../../shared/admission.js";
import { type Identity, unseal } from "../../shared/crypto.js";
import {
	type SwitchBootstrapBundle,
	SwitchBootstrapBundleSchema,
	SwitchBootstrapFrameSchema,
} from "../../shared/schemas.js";

////////////////////////////////
//  Functions & Helpers
//
//  A creds-less Switch receives its enrollment as a sealed SwitchBootstrapFrame over the
//  LAN (or pasted). The trust chain, in order, before anything is installed:
//   1. The seal opens with THIS Switch's box key (wrong-recipient or tampered -> fails).
//      Only a party that scanned this Switch's QR (which carried its box pub) could seal
//      to it, so opening proves proximity + write-once via the nonce.
//   2. The nonce equals the one this Switch's listener showed (anti-replay across windows).
//   3. The enclosed admission is owner-signed under the bundle's own Domain root AND binds
//      THIS Switch's exact keys + id + a switch kind. The owner key is pinned trust-on-
//      first-use here, gated by the SAS the human confirmed and LAN proximity - the same
//      posture as FEDERATION_OWNER_SIGN_PUB unset.

/** Open + fully validate a received bootstrap frame. Returns the trusted bundle, or
 * throws with a short reason (the caller keeps the listener open on a soft failure). */
export function openBootstrapBundle(
	frame: unknown,
	switchIdentity: Identity,
	expectedNonce: string,
	switchId: string,
): SwitchBootstrapBundle {
	const parsed = SwitchBootstrapFrameSchema.parse(frame);
	// Unseal verifies the sender's signature (against the carried console signing key) and
	// decrypts with this Switch's box key; throws on tamper / wrong sender / wrong recipient.
	const plain = unseal(parsed.sealed, switchIdentity.box.priv, parsed.signerSignPub);
	const bundle = SwitchBootstrapBundleSchema.parse(JSON.parse(plain.toString("utf8")));

	if (bundle.nonce !== expectedNonce) throw new Error("bootstrap: nonce does not match this enrollment window");

	const owner = bundle.domain.ownerSignPub;
	const admission: SignedAdmission = bundle.admission;
	if (!verifyAdmission(admission, owner)) throw new Error("bootstrap: admission is not signed by the Domain owner");
	const a = admission.admission;
	if (
		a.kind !== "switch" ||
		a.switchId !== switchId ||
		a.signPub !== switchIdentity.sign.pub ||
		a.boxPub !== switchIdentity.box.pub
	) {
		throw new Error("bootstrap: admission does not bind this Switch's id + keys");
	}
	return bundle;
}
