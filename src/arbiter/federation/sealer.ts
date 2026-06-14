import { type Identity, type SealedEnvelope, seal, unseal } from "../../shared/crypto.js";
import type { Allowlist } from "./allowlist.js";

////////////////////////////////
//  Interfaces & Types

/** Seals an object to a peer Host and opens a peer Host's sealed object, resolving
 * the peer's keys through the allowlist. The seal is E2E (arbiter to arbiter); evie
 * never holds either Host's private keys. */
export interface Sealer {
	seal(dstHost: string, obj: unknown): SealedEnvelope;
	open(srcHost: string, env: SealedEnvelope): unknown;
}

////////////////////////////////
//  Functions & Helpers

export function createSealer(identity: Identity, allowlist: Allowlist): Sealer {
	return {
		seal(dstHost, obj) {
			const peer = allowlist.resolveHost(dstHost);
			if (!peer) throw new Error(`Host "${dstHost}" is not admitted to the Domain`);
			return seal(Buffer.from(JSON.stringify(obj)), peer.boxPub, identity.sign.priv);
		},
		open(srcHost, env) {
			const peer = allowlist.resolveHost(srcHost);
			if (!peer) throw new Error(`Host "${srcHost}" is not admitted to the Domain`);
			return JSON.parse(unseal(env, identity.box.priv, peer.signPub).toString("utf8"));
		},
	};
}
