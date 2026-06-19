import { type Identity, type SealedEnvelope, seal, unseal } from "../../shared/crypto.js";
import type { Allowlist } from "./allowlist.js";
import { ReplayGuard } from "./replayGuard.js";

////////////////////////////////
//  Interfaces & Types

/** Seals an object to a peer Gateway and opens a peer Gateway's sealed object, resolving
 * the peer's keys through the allowlist. The seal is E2E (gateway to gateway); evie
 * never holds either Gateway's private keys. */
export interface Sealer {
	seal(dstGateway: string, obj: unknown): SealedEnvelope;
	open(srcGateway: string, env: SealedEnvelope): unknown;
}

////////////////////////////////
//  Functions & Helpers

// A sealed envelope older than this is rejected, so a captured authentic frame
// cannot be re-executed after the in-memory replay-guard window has rolled.
// Above evie's gateway_relay hold (70s) plus relay latency.
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
	localGatewayId: string,
	replayGuard: ReplayGuard = new ReplayGuard(),
	now: () => number = Date.now,
): Sealer {
	return {
		seal(dstGateway, obj) {
			const peer = allowlist.resolveGateway(dstGateway);
			if (!peer) throw new Error(`Gateway "${dstGateway}" is not admitted to the Domain`);
			const wrapped: SealedBody = { v: 1, src: localGatewayId, dst: dstGateway, at: now(), body: obj };
			return seal(Buffer.from(JSON.stringify(wrapped)), peer.boxPub, identity.sign.priv);
		},
		open(srcGateway, env) {
			const peer = allowlist.resolveGateway(srcGateway);
			if (!peer) throw new Error(`Gateway "${srcGateway}" is not admitted to the Domain`);
			// Verify authenticity first; only then guard against a replay of an
			// authentic frame (so a forged nonce can never poison the seen-set).
			const plain = unseal(env, identity.box.priv, peer.signPub);
			if (!replayGuard.check(srcGateway, env.nonce)) {
				throw new Error(`seal: replayed envelope from "${srcGateway}"`);
			}
			const wrapped = JSON.parse(plain.toString("utf8")) as SealedBody;
			// The cleartext srcGateway selected the verify key; cross-check it against the
			// signed-in src so an evie relabel cannot misattribute an authentic frame.
			if (wrapped?.src !== srcGateway) throw new Error(`seal: source mismatch (claimed "${srcGateway}")`);
			if (wrapped.dst !== localGatewayId) throw new Error(`seal: not addressed to this Gateway`);
			if (Math.abs(now() - (wrapped.at ?? 0)) > SEAL_MAX_AGE_MS) throw new Error(`seal: stale envelope`);
			return wrapped.body;
		},
	};
}
