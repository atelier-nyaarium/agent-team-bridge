import { type Identity, type SealedEnvelope, seal, unseal } from "../../shared/crypto.js";
import type { Allowlist } from "./allowlist.js";
import type { CrossDomainPeers } from "./crossDomainPeers.js";
import { ReplayGuard } from "./replayGuard.js";

////////////////////////////////
//  Interfaces & Types

/** A seal destination: a bare string is the existing local shorthand (a local
 * gatewayId resolved through the allowlist), an object is an explicit cross-Domain
 * target keyed by `(domainId, gatewayId)` (a gateway id is not globally unique). */
export type SealTarget = string | { domainId: string; gatewayId: string };

/** The opened body plus its verified source classification. `srcDomainId` is the
 * resolved cross-Domain peer's Domain (non-null ONLY for a cross-Domain peer, after the
 * signed-in srcDomain was cross-checked against that peer); null for a local / intra-Domain
 * peer. The relay handler gates a cross-Domain op on this trustworthy value, never on the
 * cleartext frame field. */
export interface OpenedFrame {
	body: unknown;
	srcDomainId: string | null;
}

/** Seals an object to a peer Gateway and opens a peer Gateway's sealed object, resolving
 * the peer's keys local-first (the single-owner allowlist) then the disjoint
 * cross-Domain peer set. The seal is E2E (gateway to gateway); evie never holds either
 * Gateway's private keys. `open`/`openWithSource` take the source Gateway's Domain (the
 * Router stamps it on the relay frame) so a cross-Domain peer resolves by the full
 * `(domainId, gatewayId)` pair; absent (a pre-multi-tenant Router) it falls back to a
 * bare-gatewayId scan. `openWithSource` additionally reports whether the verified sender
 * was a cross-Domain peer, so the relay handler can scope a cross-Domain op. */
export interface Sealer {
	seal(dst: SealTarget, obj: unknown): SealedEnvelope;
	open(srcGateway: string, env: SealedEnvelope, srcDomain?: string): unknown;
	openWithSource(srcGateway: string, env: SealedEnvelope, srcDomain?: string): OpenedFrame;
}

////////////////////////////////
//  Functions & Helpers

// A sealed envelope older than this is rejected, so a captured authentic frame
// cannot be re-executed after the in-memory replay-guard window has rolled.
// Above evie's gateway_relay hold (70s) plus relay latency.
const SEAL_MAX_AGE_MS = 120_000;

/** Resolve a cross-Domain peer from the cleartext relay frame. When the frame carries a
 * `srcDomain` (the Router stamped it), resolve by the full `(domainId, gatewayId)` pair,
 * so two friend Domains sharing a gateway id both open. Without it (a pre-multi-tenant
 * Router), fall back to the bare-gatewayId scan: a single match resolves, an id ambiguous
 * across two friend Domains returns null (refuse rather than guess, so a frame is never
 * attributed to the wrong peer). */
function resolveCrossByGateway(crossDomainPeers: CrossDomainPeers, gatewayId: string, srcDomain?: string) {
	if (srcDomain) return crossDomainPeers.resolveByGateway(srcDomain, gatewayId);
	const matches = crossDomainPeers.all().filter((p) => p.friendGatewayId === gatewayId);
	return matches.length === 1 ? matches[0] : null;
}

/** The LOCAL (single-owner, intra-Domain) signed-and-encrypted inner frame. Carrying
 * `src`/`dst`/`at` INSIDE the seal binds them cryptographically (the seal signature
 * covers the ciphertext), so evie - which controls the cleartext routing fields -
 * cannot relabel the origin/destination or replay a stale frame past the freshness
 * window. UNCHANGED: a local peer still produces this exact v1 body byte-for-byte. */
interface SealedBodyV1 {
	v: 1;
	src: string;
	dst: string;
	at: number;
	body: unknown;
}

/** The CROSS-DOMAIN signed-and-encrypted inner frame. Adds the source + destination
 * Domain ids alongside the gateway ids, because a gateway id is not globally unique
 * across Domains: open() cross-checks the full `(domain, gateway)` pair on both ends,
 * so an evie relabel across Domains cannot misattribute an authentic frame. */
interface SealedBodyV2 {
	v: 2;
	src: string;
	dst: string;
	srcDomain: string;
	dstDomain: string;
	at: number;
	body: unknown;
}

type SealedBody = SealedBodyV1 | SealedBodyV2;

export function createSealer(
	identity: Identity,
	allowlist: Allowlist,
	localGatewayId: string,
	crossDomainPeers: CrossDomainPeers,
	localDomainId: string,
	replayGuard: ReplayGuard = new ReplayGuard(),
	now: () => number = Date.now,
): Sealer {
	function openWithSource(srcGateway: string, env: SealedEnvelope, srcDomain?: string): OpenedFrame {
		// Resolve the verify key local-first (the single-owner allowlist), then the
		// disjoint cross-Domain set. A local peer keeps the exact existing path. The
		// cleartext relay frame's `srcDomain` (when the Router stamped it) resolves a
		// cross-Domain peer by the full `(domainId, gatewayId)` pair; otherwise the peer
		// is matched by gateway id alone. The signed-in srcDomain is still cross-checked
		// against the resolved peer AFTER unseal (below).
		const localPeer = allowlist.resolveGateway(srcGateway);
		const crossPeer = localPeer ? null : resolveCrossByGateway(crossDomainPeers, srcGateway, srcDomain);
		const verifyKey = localPeer ? localPeer.signPub : crossPeer?.friendSignPub;
		if (!verifyKey) throw new Error(`Gateway "${srcGateway}" is not admitted to the Domain`);
		// Verify authenticity first; only then guard against a replay of an
		// authentic frame (so a forged nonce can never poison the seen-set).
		const plain = unseal(env, identity.box.priv, verifyKey);
		if (!replayGuard.check(srcGateway, env.nonce)) {
			throw new Error(`seal: replayed envelope from "${srcGateway}"`);
		}
		const wrapped = JSON.parse(plain.toString("utf8")) as SealedBody;
		// The cleartext srcGateway selected the verify key; cross-check it against the
		// signed-in src so an evie relabel cannot misattribute an authentic frame.
		if (wrapped?.src !== srcGateway) throw new Error(`seal: source mismatch (claimed "${srcGateway}")`);
		if (wrapped.dst !== localGatewayId) throw new Error(`seal: not addressed to this Gateway`);
		if (Math.abs(now() - (wrapped.at ?? 0)) > SEAL_MAX_AGE_MS) throw new Error(`seal: stale envelope`);
		if (wrapped.v === 1) {
			// Local / legacy intra-Domain frame: src/dst/at already checked above. A v1 body
			// MUST come from a local peer (symmetric to the v2 guard below): a cross-Domain
			// peer that crafted a v1 body would otherwise strip the (srcDomain, dstDomain)
			// binding the v2 envelope exists to enforce.
			if (crossPeer) throw new Error(`seal: v1 frame from a cross-Domain Gateway`);
			return { body: wrapped.body, srcDomainId: null };
		}
		if (wrapped.v === 2) {
			// Cross-Domain frame: the verify key MUST be a cross-Domain peer (a local
			// peer never emits v2), and the full (domain, gateway) pair must match.
			if (!crossPeer) throw new Error(`seal: v2 frame from a non-cross-Domain Gateway`);
			if (wrapped.srcDomain !== crossPeer.friendDomainId) {
				throw new Error(`seal: srcDomain mismatch (claimed "${wrapped.srcDomain}")`);
			}
			if (wrapped.dstDomain !== localDomainId) throw new Error(`seal: not addressed to this Domain`);
			// The Domain is the resolved peer's, already cross-checked against the signed-in
			// value, so the relay handler can trust it to scope the op.
			return { body: wrapped.body, srcDomainId: crossPeer.friendDomainId };
		}
		throw new Error(`seal: unknown sealed body version`);
	}

	return {
		seal(dst, obj) {
			// A bare string is the local shorthand: resolve the local Domain FIRST and emit the
			// byte-identical v1 body. Only when the local Domain cannot resolve the target (or the
			// caller named an explicit cross-Domain target) do we fall through to the
			// disjoint cross-Domain set and emit v2.
			const bareGateway = typeof dst === "string" ? dst : dst.gatewayId;
			if (typeof dst === "string") {
				const localPeer = allowlist.resolveGateway(dst);
				if (localPeer) {
					const wrapped: SealedBodyV1 = { v: 1, src: localGatewayId, dst, at: now(), body: obj };
					return seal(Buffer.from(JSON.stringify(wrapped)), localPeer.boxPub, identity.sign.priv);
				}
			}
			// Cross-Domain: resolve the friend gateway's keys from the disjoint store.
			if (typeof dst !== "string") {
				const peer = crossDomainPeers.resolveByGateway(dst.domainId, dst.gatewayId);
				if (peer) {
					const wrapped: SealedBodyV2 = {
						v: 2,
						src: localGatewayId,
						dst: dst.gatewayId,
						srcDomain: localDomainId,
						dstDomain: peer.friendDomainId,
						at: now(),
						body: obj,
					};
					return seal(Buffer.from(JSON.stringify(wrapped)), peer.friendBoxPub, identity.sign.priv);
				}
			}
			throw new Error(`Gateway "${bareGateway}" is not admitted to the Domain`);
		},
		// open returns just the body (the existing callers); openWithSource adds the verified
		// source Domain for the relay handler's destination gate. Both share one resolver.
		open(srcGateway, env, srcDomain) {
			return openWithSource(srcGateway, env, srcDomain).body;
		},
		openWithSource,
	};
}
