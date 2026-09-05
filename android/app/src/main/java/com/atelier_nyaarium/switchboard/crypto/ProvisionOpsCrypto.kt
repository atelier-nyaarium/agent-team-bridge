package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.DeleteDomain
import com.atelier_nyaarium.switchboard.proto.FirstRoot
import com.atelier_nyaarium.switchboard.proto.ProvisionTenant
import com.atelier_nyaarium.switchboard.proto.RemoveTenant
import com.atelier_nyaarium.switchboard.proto.SetDisplayName
import com.atelier_nyaarium.switchboard.proto.SignedDeleteDomain
import com.atelier_nyaarium.switchboard.proto.SignedFirstRoot
import com.atelier_nyaarium.switchboard.proto.SignedProvisionTenant
import com.atelier_nyaarium.switchboard.proto.SignedRemoveTenant
import com.atelier_nyaarium.switchboard.proto.SignedSetDisplayName
import com.atelier_nyaarium.switchboard.proto.Protocol

object ProvisionOpsCrypto {
	// Signing bytes mirror federation-lifecycle.ts exactly; never sign raw JSON.
	fun provisionSigningBytes(p: ProvisionTenant, adminSignPub: String): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_PROVISION_TENANT,
			Crypto.fingerprint(adminSignPub),
			p.domainId,
			p.displayName,
			p.issuedAt.toString(),
			p.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signProvision(p: ProvisionTenant, adminSignPriv: String, adminSignPub: String): SignedProvisionTenant =
		SignedProvisionTenant(
			provision = p,
			adminSignPub = adminSignPub,
			signature = Crypto.sign(provisionSigningBytes(p, adminSignPub), adminSignPriv),
		)

	fun verifyProvision(s: SignedProvisionTenant, expectedAdminSignPub: String): Boolean =
		s.adminSignPub == expectedAdminSignPub &&
			Crypto.verify(provisionSigningBytes(s.provision, expectedAdminSignPub), s.signature, expectedAdminSignPub)

	fun removeSigningBytes(r: RemoveTenant, adminSignPub: String): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_REMOVE_TENANT,
			Crypto.fingerprint(adminSignPub),
			r.domainId,
			r.issuedAt.toString(),
			r.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signRemove(r: RemoveTenant, adminSignPriv: String, adminSignPub: String): SignedRemoveTenant =
		SignedRemoveTenant(
			removal = r,
			adminSignPub = adminSignPub,
			signature = Crypto.sign(removeSigningBytes(r, adminSignPub), adminSignPriv),
		)

	fun verifyRemove(s: SignedRemoveTenant, expectedAdminSignPub: String): Boolean =
		s.adminSignPub == expectedAdminSignPub &&
			Crypto.verify(removeSigningBytes(s.removal, expectedAdminSignPub), s.signature, expectedAdminSignPub)

	// first_root is self-signed; the nonce authorizes and the signature proves owner-key possession.
	fun firstRootSigningBytes(f: FirstRoot): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_FIRST_ROOT,
			f.domainId,
			f.ownerSignPub,
			f.ownerBoxPub,
			f.nonce,
			f.issuedAt.toString(),
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signFirstRoot(f: FirstRoot, ownerSignPriv: String): SignedFirstRoot =
		SignedFirstRoot(firstRoot = f, signature = Crypto.sign(firstRootSigningBytes(f), ownerSignPriv))

	fun verifyFirstRoot(s: SignedFirstRoot): Boolean =
		Crypto.verify(firstRootSigningBytes(s.firstRoot), s.signature, s.firstRoot.ownerSignPub)

	fun setDisplayNameSigningBytes(r: SetDisplayName, ownerSignPub: String): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_SET_DISPLAY_NAME,
			Crypto.fingerprint(ownerSignPub),
			r.domainId,
			r.displayName,
			r.issuedAt.toString(),
			r.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signSetDisplayName(r: SetDisplayName, ownerSignPriv: String, ownerSignPub: String): SignedSetDisplayName =
		SignedSetDisplayName(
			rename = r,
			ownerSignPub = ownerSignPub,
			signature = Crypto.sign(setDisplayNameSigningBytes(r, ownerSignPub), ownerSignPriv),
		)

	fun verifySetDisplayName(s: SignedSetDisplayName, expectedOwnerSignPub: String): Boolean =
		s.ownerSignPub == expectedOwnerSignPub &&
			Crypto.verify(setDisplayNameSigningBytes(s.rename, expectedOwnerSignPub), s.signature, expectedOwnerSignPub)

	// Delete-domain uses an owner fingerprint and a distinct tag from rename.
	fun deleteDomainSigningBytes(d: DeleteDomain, ownerSignPub: String): ByteArray =
		listOf(
			Protocol.Wire.SIGNING_TAG_DELETE_DOMAIN,
			Crypto.fingerprint(ownerSignPub),
			d.domainId,
			d.issuedAt.toString(),
			d.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signDeleteDomain(d: DeleteDomain, ownerSignPriv: String, ownerSignPub: String): SignedDeleteDomain =
		SignedDeleteDomain(
			deletion = d,
			ownerSignPub = ownerSignPub,
			signature = Crypto.sign(deleteDomainSigningBytes(d, ownerSignPub), ownerSignPriv),
		)

	fun verifyDeleteDomain(s: SignedDeleteDomain, expectedOwnerSignPub: String): Boolean =
		s.ownerSignPub == expectedOwnerSignPub &&
			Crypto.verify(deleteDomainSigningBytes(s.deletion, expectedOwnerSignPub), s.signature, expectedOwnerSignPub)

	// Roster proof binds the raw signer key, timestamp, nonce, and its own tag.
	fun rosterRequestSigningBytes(signerSignPub: String, proofAt: Long, nonce: String): ByteArray =
		listOf(Protocol.Wire.SIGNING_TAG_ROSTER, signerSignPub, proofAt.toString(), nonce).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signRosterRequest(signerSignPub: String, proofAt: Long, nonce: String, signPriv: String): String =
		Crypto.sign(rosterRequestSigningBytes(signerSignPub, proofAt, nonce), signPriv)

	// Trust-pending proof is owner-key possession with a tag distinct from roster.
	fun trustPendingSigningBytes(signerSignPub: String, proofAt: Long, nonce: String): ByteArray =
		listOf(Protocol.Wire.SIGNING_TAG_TRUST_PENDING, signerSignPub, proofAt.toString(), nonce).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signTrustPendingRequest(signerSignPub: String, proofAt: Long, nonce: String, signPriv: String): String =
		Crypto.sign(trustPendingSigningBytes(signerSignPub, proofAt, nonce), signPriv)

	// Transport proof is owner-key possession with a tag distinct from other proofs.
	fun transportRequestSigningBytes(signerSignPub: String, proofAt: Long, nonce: String): ByteArray =
		listOf(Protocol.Wire.SIGNING_TAG_TRANSPORT_REQUEST, signerSignPub, proofAt.toString(), nonce).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signTransportRequest(signerSignPub: String, proofAt: Long, nonce: String, signPriv: String): String =
		Crypto.sign(transportRequestSigningBytes(signerSignPub, proofAt, nonce), signPriv)
}
