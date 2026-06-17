import type { ConsoleOpEnvelope, ConsoleReplyBody } from "../../shared/console-protocol.js";
import { type Identity, type SealedEnvelope, seal, unseal } from "../../shared/crypto.js";
import { ConsoleOpEnvelopeSchema } from "../../shared/schemas.js";
import type { Allowlist } from "../federation/allowlist.js";
import { ReplayGuard } from "../federation/replayGuard.js";

////////////////////////////////
//  Interfaces & Types

/** Opens an inbound sealed console frame and seals a reply back to the console. The
 * console-channel twin of the cross-Switch Sealer: confidentiality + authenticity are
 * E2E (console <-> this arbiter), so evie relays an opaque blob it cannot read or
 * forge. The console's keys resolve through the owner-signed allowlist (an admitted
 * kind:console subject - the owner's own device self-admits as one), so a frame is
 * trusted because it is signed by an admitted console, never because it arrived on
 * the evie socket. */
export interface ConsoleSealer {
	/** Verify the signer is an admitted console, verify its signature + decrypt with
	 * this arbiter's box key, replay-check, freshness-check; return the inner op
	 * envelope. Throws (never dispatches) on any failure. */
	open(signerSignPub: string, sealed: SealedEnvelope): ConsoleOpEnvelope;
	/** Seal a reply body to the console's box key (resolved from its admission),
	 * signed by this arbiter. Throws if the signer is not an admitted console. */
	seal(signerSignPub: string, body: ConsoleReplyBody): SealedEnvelope;
}

////////////////////////////////
//  Functions & Helpers

// A sealed console frame older than this is rejected. Generous over the
// console->evie->arbiter relay path; the per-message nonce + the durable replay
// guard bound an actual replay, and the freshness window caps how long a captured
// frame could be replayed before the guard alone would (after a long outage).
const CONSOLE_SEAL_MAX_AGE_MS = 120_000;

export function createConsoleSealer(
	identity: Identity,
	allowlist: Allowlist,
	replayGuard: ReplayGuard = new ReplayGuard(),
	now: () => number = Date.now,
): ConsoleSealer {
	function resolveConsoleBoxPub(signerSignPub: string): string {
		const admission = allowlist.resolveBySignPub(signerSignPub);
		if (admission?.kind !== "console") {
			throw new Error("console is not admitted to the Domain");
		}
		return admission.boxPub;
	}

	return {
		open(signerSignPub, sealed) {
			// Authorize the signer (cheap map lookup) before spending a decrypt on it.
			resolveConsoleBoxPub(signerSignPub);
			// Verify the console's signature against its admitted signing key, then
			// decrypt with this arbiter's box private key.
			const plain = unseal(sealed, identity.box.priv, signerSignPub);
			// Replay-check AFTER authenticity verifies, so a forged nonce can never
			// poison the seen-set. Scoped per console signing key.
			if (!replayGuard.check(`console:${signerSignPub}`, sealed.nonce)) {
				throw new Error("replayed console frame");
			}
			const env = ConsoleOpEnvelopeSchema.parse(JSON.parse(plain.toString("utf8")));
			if (Math.abs(now() - env.at) > CONSOLE_SEAL_MAX_AGE_MS) throw new Error("stale console frame");
			return env;
		},
		seal(signerSignPub, body) {
			const boxPub = resolveConsoleBoxPub(signerSignPub);
			return seal(Buffer.from(JSON.stringify(body)), boxPub, identity.sign.priv);
		},
	};
}
