import type { CrossDomainPeer } from "../../gateway/federation/crossDomainPeers.js";

/** A linked friend's peer record. */
export function linkedPeer(domainId: string, gatewayId: string, sign = `${domainId}-sign`): CrossDomainPeer {
	return {
		friendOwnerSignPub: `${domainId}-owner`,
		friendDomainId: domainId,
		friendGatewayId: gatewayId,
		friendSignPub: sign,
		friendBoxPub: `${domainId}-box`,
		link: {
			link: {
				myOwnerSignPub: "local-owner",
				peerOwnerSignPub: `${domainId}-owner`,
				peerDomainId: domainId,
				peerGatewayId: gatewayId,
				peerSignPub: sign,
				peerBoxPub: `${domainId}-box`,
				issuedAt: 1,
				nonce: "nonce",
			},
			ownerSignPub: "local-owner",
			signature: "signature",
		},
	};
}
