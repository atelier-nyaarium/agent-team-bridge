package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.SignedXDomainLink
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLinkEdge
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLinkRevocation
import com.atelier_nyaarium.switchboard.proto.SignedXDomainUntrust
import com.atelier_nyaarium.switchboard.proto.XDomainLink
import com.atelier_nyaarium.switchboard.proto.XDomainLinkEdge
import com.atelier_nyaarium.switchboard.proto.XDomainLinkRevocation
import com.atelier_nyaarium.switchboard.proto.XDomainUntrust
import com.atelier_nyaarium.switchboard.proto.Protocol

object XDomainLinkCrypto {
	// Signing bytes mirror federation-lifecycle.ts exactly; edge and revocation tags differ.
	fun edgeSigningBytes(edge: XDomainLinkEdge, ownerSignPub: String): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_XDOMAIN_RELAY_GATE,
			ownerSignPub,
			edge.srcDomainId,
			edge.dstDomainId,
			edge.issuedAt.toString(),
			edge.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun revocationSigningBytes(rev: XDomainLinkRevocation, ownerSignPub: String): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_XDOMAIN_REVOKE,
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

	// Link signing bytes mirror federation-protocol.ts exactly for phone and Gateway verification.
	fun linkSigningBytes(link: XDomainLink): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_XDOMAIN_LINK,
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

	// revokedAt floors links issued at or before it while allowing later re-trust.
	fun untrustSigningBytes(u: XDomainUntrust): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_XDOMAIN_UNTRUST,
			u.myOwnerSignPub,
			u.peerOwnerSignPub,
			u.revokedAt.toString(),
			u.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signUntrust(u: XDomainUntrust, ownerSignPriv: String, ownerSignPub: String): SignedXDomainUntrust =
		SignedXDomainUntrust(
			untrust = u,
			ownerSignPub = ownerSignPub,
			signature = Crypto.sign(untrustSigningBytes(u), ownerSignPriv),
		)

	fun verifyUntrust(s: SignedXDomainUntrust, expectedOwnerSignPub: String): Boolean =
		s.ownerSignPub == expectedOwnerSignPub &&
			Crypto.verify(untrustSigningBytes(s.untrust), s.signature, expectedOwnerSignPub)
}
