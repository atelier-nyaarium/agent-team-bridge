import type { Clock } from "../../shared/ambient.js";
import { type Identity, type SealedEnvelope, seal, unseal } from "../../shared/crypto.js";
import type { Allowlist } from "./allowlist.js";
import type { CrossDomainPeers } from "./crossDomainPeers.js";
import type { ReplayGuard } from "./replayGuard.js";

export type SealTarget = string | { domainId: string; gatewayId: string };

export interface OpenedFrame {
	body: unknown;
	srcDomainId: string | null;
}

export interface Sealer {
	seal(dst: SealTarget, obj: unknown): SealedEnvelope;
	open(srcGateway: string, env: SealedEnvelope, srcDomain?: string): unknown;
	// Use courier acceptance time for queued frames.
	openWithSource(
		srcGateway: string,
		env: SealedEnvelope,
		srcDomain?: string,
		opts?: { sealedAt?: number },
	): OpenedFrame;
}

// Envelope age must exceed the Router relay hold.
const SEAL_MAX_AGE_MS = 120_000;

function resolveCrossByGateway(crossDomainPeers: CrossDomainPeers, gatewayId: string, srcDomain?: string) {
	if (srcDomain) return crossDomainPeers.resolveByGateway(srcDomain, gatewayId);
	const matches = crossDomainPeers.all().filter((p) => p.friendGatewayId === gatewayId);
	return matches.length === 1 ? matches[0] : null;
}

interface SealedBodyV1 {
	v: 1;
	src: string;
	dst: string;
	at: number;
	body: unknown;
}

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
	replayGuard: ReplayGuard,
	ambient: Clock,
): Sealer {
	function openWithSource(
		srcGateway: string,
		env: SealedEnvelope,
		srcDomain?: string,
		opts?: { sealedAt?: number },
	): OpenedFrame {
		const localPeer = allowlist.resolveGateway(srcGateway);
		const crossPeer = localPeer ? null : resolveCrossByGateway(crossDomainPeers, srcGateway, srcDomain);
		const verifyKey = localPeer ? localPeer.signPub : crossPeer?.friendSignPub;
		if (!verifyKey) throw new Error(`Gateway "${srcGateway}" is not admitted to the Domain`);
		// Authenticate before recording the nonce.
		const plain = unseal(env, identity.box.priv, verifyKey);
		if (!replayGuard.check(srcGateway, env.nonce)) {
			throw new Error(`seal: replayed envelope from "${srcGateway}"`);
		}
		const wrapped = JSON.parse(plain.toString("utf8")) as SealedBody;
		// Bind the cleartext route to the signed source.
		if (wrapped?.src !== srcGateway) throw new Error(`seal: source mismatch (claimed "${srcGateway}")`);
		if (wrapped.dst !== localGatewayId) throw new Error(`seal: not addressed to this Gateway`);
		if (Math.abs((opts?.sealedAt ?? ambient.now()) - (wrapped.at ?? 0)) > SEAL_MAX_AGE_MS)
			throw new Error(`seal: stale envelope`);
		if (wrapped.v === 1) {
			// Local frames use v1. Cross-Domain bindings require v2.
			if (crossPeer) throw new Error(`seal: v1 frame from a cross-Domain Gateway`);
			return { body: wrapped.body, srcDomainId: null };
		}
		if (wrapped.v === 2) {
			// Cross-Domain frames bind both Domain and Gateway identities.
			if (!crossPeer) throw new Error(`seal: v2 frame from a non-cross-Domain Gateway`);
			if (wrapped.srcDomain !== crossPeer.friendDomainId) {
				throw new Error(`seal: srcDomain mismatch (claimed "${wrapped.srcDomain}")`);
			}
			if (wrapped.dstDomain !== localDomainId) throw new Error(`seal: not addressed to this Domain`);
			return { body: wrapped.body, srcDomainId: crossPeer.friendDomainId };
		}
		throw new Error(`seal: unknown sealed body version`);
	}

	return {
		seal(dst, obj) {
			// Bare local targets use v1. Explicit cross-Domain targets use v2.
			const bareGateway = typeof dst === "string" ? dst : dst.gatewayId;
			if (typeof dst === "string") {
				const localPeer = allowlist.resolveGateway(dst);
				if (localPeer) {
					const wrapped: SealedBodyV1 = { v: 1, src: localGatewayId, dst, at: ambient.now(), body: obj };
					return seal(Buffer.from(JSON.stringify(wrapped)), localPeer.boxPub, identity.sign.priv);
				}
			}
			if (typeof dst !== "string") {
				const peer = crossDomainPeers.resolveByGateway(dst.domainId, dst.gatewayId);
				if (peer) {
					const wrapped: SealedBodyV2 = {
						v: 2,
						src: localGatewayId,
						dst: dst.gatewayId,
						srcDomain: localDomainId,
						dstDomain: peer.friendDomainId,
						at: ambient.now(),
						body: obj,
					};
					return seal(Buffer.from(JSON.stringify(wrapped)), peer.friendBoxPub, identity.sign.priv);
				}
			}
			throw new Error(`Gateway "${bareGateway}" is not admitted to the Domain`);
		},
		open(srcGateway, env, srcDomain) {
			return openWithSource(srcGateway, env, srcDomain).body;
		},
		openWithSource,
	};
}
