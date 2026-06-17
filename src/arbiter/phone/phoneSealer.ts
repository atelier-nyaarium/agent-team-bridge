import { type Identity, type SealedEnvelope, seal, unseal } from "../../shared/crypto.js";
import type { PhoneOpEnvelope, PhoneReplyBody } from "../../shared/phone-protocol.js";
import { PhoneOpEnvelopeSchema } from "../../shared/schemas.js";
import type { Allowlist } from "../federation/allowlist.js";
import { ReplayGuard } from "../federation/replayGuard.js";

////////////////////////////////
//  Interfaces & Types

/** Opens an inbound sealed phone frame and seals a reply back to the phone. The
 * phone-channel twin of the cross-Host Sealer: confidentiality + authenticity are
 * E2E (phone <-> this arbiter), so evie relays an opaque blob it cannot read or
 * forge. The phone's keys resolve through the owner-signed allowlist (an admitted
 * kind:phone subject - the owner's own device self-admits as one), so a frame is
 * trusted because it is signed by an admitted phone, never because it arrived on
 * the evie socket. */
export interface PhoneSealer {
	/** Verify the signer is an admitted phone, verify its signature + decrypt with
	 * this arbiter's box key, replay-check, freshness-check; return the inner op
	 * envelope. Throws (never dispatches) on any failure. */
	open(signerSignPub: string, sealed: SealedEnvelope): PhoneOpEnvelope;
	/** Seal a reply body to the phone's box key (resolved from its admission),
	 * signed by this arbiter. Throws if the signer is not an admitted phone. */
	seal(signerSignPub: string, body: PhoneReplyBody): SealedEnvelope;
}

////////////////////////////////
//  Functions & Helpers

// A sealed phone frame older than this is rejected. Generous over the
// phone->evie->arbiter relay path; the per-message nonce + the durable replay
// guard bound an actual replay, and the freshness window caps how long a captured
// frame could be replayed before the guard alone would (after a long outage).
const PHONE_SEAL_MAX_AGE_MS = 120_000;

export function createPhoneSealer(
	identity: Identity,
	allowlist: Allowlist,
	replayGuard: ReplayGuard = new ReplayGuard(),
	now: () => number = Date.now,
): PhoneSealer {
	function resolvePhoneBoxPub(signerSignPub: string): string {
		const admission = allowlist.resolveBySignPub(signerSignPub);
		if (admission?.kind !== "phone") {
			throw new Error("phone is not admitted to the Domain");
		}
		return admission.boxPub;
	}

	return {
		open(signerSignPub, sealed) {
			// Authorize the signer (cheap map lookup) before spending a decrypt on it.
			resolvePhoneBoxPub(signerSignPub);
			// Verify the phone's signature against its admitted signing key, then
			// decrypt with this arbiter's box private key.
			const plain = unseal(sealed, identity.box.priv, signerSignPub);
			// Replay-check AFTER authenticity verifies, so a forged nonce can never
			// poison the seen-set. Scoped per phone signing key.
			if (!replayGuard.check(`phone:${signerSignPub}`, sealed.nonce)) {
				throw new Error("replayed phone frame");
			}
			const env = PhoneOpEnvelopeSchema.parse(JSON.parse(plain.toString("utf8")));
			if (Math.abs(now() - env.at) > PHONE_SEAL_MAX_AGE_MS) throw new Error("stale phone frame");
			return env;
		},
		seal(signerSignPub, body) {
			const boxPub = resolvePhoneBoxPub(signerSignPub);
			return seal(Buffer.from(JSON.stringify(body)), boxPub, identity.sign.priv);
		},
	};
}
