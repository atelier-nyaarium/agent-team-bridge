import { type Identity, type SealedEnvelope, seal, unseal } from "../../shared/crypto.js";
import type { Allowlist } from "./allowlist.js";
import { ReplayGuard } from "./replayGuard.js";

////////////////////////////////
//  Interfaces & Types

/** Seals an object to a peer Switch and opens a peer Switch's sealed object, resolving
 * the peer's keys through the allowlist. The seal is E2E (arbiter to arbiter); evie
 * never holds either Switch's private keys. */
export interface Sealer {
	seal(dstSwitch: string, obj: unknown): SealedEnvelope;
	open(srcSwitch: string, env: SealedEnvelope): unknown;
}

////////////////////////////////
//  Functions & Helpers

// A sealed envelope older than this is rejected, so a captured authentic frame
// cannot be re-executed after the in-memory replay-guard window has rolled.
// Above evie's switch_relay hold (70s) plus relay latency.
const SEAL_MAX_AGE_MS = 120_000;

/** The signed-and-encrypted inner frame. Carrying `src`/`dst`/`at` INSIDE the
 * seal binds them cryptographically (the seal signature covers the ciphertext),
 * so evie - which controls the cleartext routing fields - cannot relabel the
 * origin/destination or replay a stale frame past the freshness window. */
interface SealedBody {
	v: 1;
	src: string;
	dst: string;
	at: number;
	body: unknown;
}

export function createSealer(
	identity: Identity,
	allowlist: Allowlist,
	localSwitchId: string,
	replayGuard: ReplayGuard = new ReplayGuard(),
	now: () => number = Date.now,
): Sealer {
	return {
		seal(dstSwitch, obj) {
			const peer = allowlist.resolveSwitch(dstSwitch);
			if (!peer) throw new Error(`Switch "${dstSwitch}" is not admitted to the Domain`);
			const wrapped: SealedBody = { v: 1, src: localSwitchId, dst: dstSwitch, at: now(), body: obj };
			return seal(Buffer.from(JSON.stringify(wrapped)), peer.boxPub, identity.sign.priv);
		},
		open(srcSwitch, env) {
			const peer = allowlist.resolveSwitch(srcSwitch);
			if (!peer) throw new Error(`Switch "${srcSwitch}" is not admitted to the Domain`);
			// Verify authenticity first; only then guard against a replay of an
			// authentic frame (so a forged nonce can never poison the seen-set).
			const plain = unseal(env, identity.box.priv, peer.signPub);
			if (!replayGuard.check(srcSwitch, env.nonce)) {
				throw new Error(`seal: replayed envelope from "${srcSwitch}"`);
			}
			const wrapped = JSON.parse(plain.toString("utf8")) as SealedBody;
			// The cleartext srcSwitch selected the verify key; cross-check it against the
			// signed-in src so an evie relabel cannot misattribute an authentic frame.
			if (wrapped?.src !== srcSwitch) throw new Error(`seal: source mismatch (claimed "${srcSwitch}")`);
			if (wrapped.dst !== localSwitchId) throw new Error(`seal: not addressed to this Switch`);
			if (Math.abs(now() - (wrapped.at ?? 0)) > SEAL_MAX_AGE_MS) throw new Error(`seal: stale envelope`);
			return wrapped.body;
		},
	};
}
