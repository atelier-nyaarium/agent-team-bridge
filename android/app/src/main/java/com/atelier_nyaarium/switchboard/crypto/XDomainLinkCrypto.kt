package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.SignedXDomainLink
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLinkEdge
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLinkRevocation
import com.atelier_nyaarium.switchboard.proto.XDomainLink
import com.atelier_nyaarium.switchboard.proto.XDomainLinkEdge
import com.atelier_nyaarium.switchboard.proto.XDomainLinkRevocation

/**
 * Owner-signed cross-Domain link edge / revocation, the byte-exact Kotlin counterpart
 * of switchboard's `src/shared/enrollment.ts`. The owner device (this console) signs the
 * edge that opens a cross-Domain relay affinity and the revocation that withdraws it, and
 * evie verifies both against the rooted owner key, so the canonical signing bytes - a
 * versioned, newline-joined, fixed-order encoding - must reproduce exactly. The
 * cross-platform vector in XDomainLinkTest pins it. The edge and the revocation use
 * DISTINCT version prefixes so a captured edge signature can never be replayed as a
 * revocation (or the reverse). Never sign raw JSON.
 */
object XDomainLinkCrypto {
	fun edgeSigningBytes(edge: XDomainLinkEdge, ownerSignPub: String): ByteArray =
		listOf(
			"XDOMAIN_RELAY_GATE_V1",
			ownerSignPub,
			edge.srcDomainId,
			edge.dstDomainId,
			edge.issuedAt.toString(),
			edge.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun revocationSigningBytes(rev: XDomainLinkRevocation, ownerSignPub: String): ByteArray =
		listOf(
			"XDOMAIN_REVOKE_V1",
			ownerSignPub,
			rev.srcDomainId,
			rev.dstDomainId,
			rev.revokedAt.toString(),
			rev.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signEdge(edge: XDomainLinkEdge, ownerSignPriv: String, ownerSignPub: String): SignedXDomainLinkEdge =
		SignedXDomainLinkEdge(
			edge = edge,
			ownerSignPub = ownerSignPub,
			signature = Crypto.sign(edgeSigningBytes(edge, ownerSignPub), ownerSignPriv),
		)

	fun signRevocation(rev: XDomainLinkRevocation, ownerSignPriv: String, ownerSignPub: String): SignedXDomainLinkRevocation =
		SignedXDomainLinkRevocation(
			revocation = rev,
			ownerSignPub = ownerSignPub,
			signature = Crypto.sign(revocationSigningBytes(rev, ownerSignPub), ownerSignPriv),
		)

	fun verifyEdge(s: SignedXDomainLinkEdge, expectedOwnerSignPub: String): Boolean =
		s.ownerSignPub == expectedOwnerSignPub &&
			Crypto.verify(edgeSigningBytes(s.edge, expectedOwnerSignPub), s.signature, expectedOwnerSignPub)

	fun verifyRevocation(s: SignedXDomainLinkRevocation, expectedOwnerSignPub: String): Boolean =
		s.ownerSignPub == expectedOwnerSignPub &&
			Crypto.verify(revocationSigningBytes(s.revocation, expectedOwnerSignPub), s.signature, expectedOwnerSignPub)

	/**
	 * The full cross-Domain link side (the trust artifact the handshake confirm binds): an
	 * owner's attestation that names the FRIEND gateway's keys + ids it will seal to. Distinct
	 * from the relay-affinity edge above (which evie reads): the link is gateway-to-gateway
	 * vocabulary the Router never sees. Its signing bytes mirror federation-protocol.ts's
	 * xDomainLinkSigningBytes byte-for-byte, so a phone-signed side verifies on the gateway.
	 */
	fun linkSigningBytes(link: XDomainLink): ByteArray =
		listOf(
			"XDOMAIN_LINK_V1",
			link.myOwnerSignPub,
			link.peerOwnerSignPub,
			link.peerDomainId,
			link.peerGatewayId,
			link.peerSignPub,
			link.peerBoxPub,
			link.issuedAt.toString(),
			link.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signLink(link: XDomainLink, ownerSignPriv: String, ownerSignPub: String): SignedXDomainLink =
		SignedXDomainLink(
			link = link,
			ownerSignPub = ownerSignPub,
			signature = Crypto.sign(linkSigningBytes(link), ownerSignPriv),
		)

	fun verifyLink(s: SignedXDomainLink, expectedOwnerSignPub: String): Boolean =
		s.ownerSignPub == expectedOwnerSignPub &&
			Crypto.verify(linkSigningBytes(s.link), s.signature, expectedOwnerSignPub)
}
