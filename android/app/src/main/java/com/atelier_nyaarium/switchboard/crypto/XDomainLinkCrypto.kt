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

/**
 * Owner-signed cross-Domain link edge / revocation, the byte-exact Kotlin counterpart
 * of switchboard's `src/shared/federation-lifecycle.ts`. The owner device (this console) signs the
 * edge that opens a cross-Domain relay affinity and the revocation that withdraws it, and
 * the Router verifies both against the rooted owner key, so the canonical signing bytes - a
 * versioned, newline-joined, fixed-order encoding - must reproduce exactly. The
 * cross-platform vector in XDomainLinkTest pins it. The edge and the revocation use
 * DISTINCT version prefixes so a captured edge signature can never be replayed as a
 * revocation (or the reverse). Never sign raw JSON.
 */
object XDomainLinkCrypto {
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

	/**
	 * The full cross-Domain link side (the trust artifact the handshake confirm binds): an
	 * owner's attestation that names the FRIEND gateway's keys + ids it will seal to. Distinct
	 * from the relay-affinity edge above (which the Router reads): the link is gateway-to-gateway
	 * vocabulary the Router never sees. Its signing bytes mirror federation-protocol.ts's
	 * xDomainLinkSigningBytes byte-for-byte, so a phone-signed side verifies on the gateway.
	 */
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

	/**
	 * The owner-keyed untrust tombstone: withdraws trust in a friend OWNER (every gateway under
	 * that root), signed by MY owner key. Mirrors federation-protocol.ts xDomainUntrustSigningBytes
	 * byte-for-byte. A distinct version prefix from the link so neither signature replays as the
	 * other. `revokedAt` floors out any trust link issued at or before it (a replayed stale link
	 * stays dead); a genuine re-trust issued AFTER it is honored.
	 */
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
