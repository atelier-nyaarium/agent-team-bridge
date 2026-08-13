import type { CrossDomainPeers } from "./crossDomainPeers.js";
import type { SealTarget } from "./sealer.js";

////////////////////////////////
//  Interfaces & Types

/** Both deps are federation-activation-dependent (resolvesLocalGateway is built from the console
 * allowlist, which is why buildRoutes re-runs on activation), so they arrive PER CALL: a field
 * would go stale at the moment of activation. */
export interface SealTargetDeps {
	resolvesLocalGateway?: ((gatewayId: string) => boolean) | null;
	crossDomainPeers?: CrossDomainPeers | null;
}

////////////////////////////////
//  Functions & Helpers

/** Resolve a target Gateway id to a SealTarget, LOCAL-FIRST (mirroring the sealer's own
 * resolution order). A gateway id the local single-owner allowlist resolves is the
 * bare-string shorthand and seals v1 - checked BEFORE the cross-Domain scan, so a send to
 * your OWN local Gateway whose id collides with a friend's gateway id is never hijacked to
 * the friend. Only a gateway id NOT in the local Domain is matched against the disjoint
 * cross-Domain peer set: a single peer resolves to an explicit `(domainId, gatewayId)`
 * SealTarget (v2, the Addressing decision's separate domainId field, never folded into the
 * id string); a gateway id ambiguous across two friend Domains throws rather than guess. */
export function sealTargetFor(deps: SealTargetDeps, targetGateway: string, targetDomain?: string): SealTarget {
	const { resolvesLocalGateway, crossDomainPeers } = deps;
	// Local first: a gateway the local allowlist admits is the bare-string v1 shorthand, so a
	// local/friend gateway-id collision can never route a local send to the friend. A caller
	// that named an explicit cross-Domain target still falls to the cross-Domain resolution
	// below (a friend gateway is never in the local allowlist), so the local check is safe.
	if (resolvesLocalGateway?.(targetGateway)) return targetGateway;
	// An explicit (domainId, gatewayId) from the caller resolves the peer unambiguously,
	// closing the same-id-two-Domains case the bare scan refuses: two linked friends running
	// an identically-named gateway are told apart by the Domain the console selected.
	if (targetDomain) {
		const peer = crossDomainPeers?.resolveByGateway(targetDomain, targetGateway);
		if (peer) return { domainId: targetDomain, gatewayId: targetGateway };
		// The named Domain is not a linked peer for this gateway id: fall through to the bare
		// resolution so the error surfaces as "not admitted" rather than silently misrouting.
	}
	const peers = crossDomainPeers?.all().filter((p) => p.friendGatewayId === targetGateway) ?? [];
	if (peers.length === 1) return { domainId: peers[0].friendDomainId, gatewayId: targetGateway };
	if (peers.length > 1) {
		throw new Error(`Gateway "${targetGateway}" is ambiguous across linked Domains; cannot route`);
	}
	// Neither a known local gateway nor a cross-Domain peer: fall back to the bare string,
	// which the sealer resolves against the local allowlist (and emits v1) or rejects as
	// "not admitted". This preserves the prior behavior when no local predicate is wired.
	return targetGateway;
}
