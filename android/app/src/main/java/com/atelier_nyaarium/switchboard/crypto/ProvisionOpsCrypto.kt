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

/**
 * Friend cross-Domain onboarding signing, the byte-exact Kotlin counterpart of
 * switchboard's `src/shared/federation-lifecycle.ts`. The admin pre-stages a friend's pending
 * tenant (provision_tenant) or drops it (remove_tenant), the friend's app roots the Domain
 * on first connect (first_root, SELF-signed by its silently-generated owner key), and the
 * rooted owner renames the network (set_display_name). The Router verifies each against the
 * matching key, so the canonical signing bytes - a versioned, newline-joined, fixed-order
 * encoding binding fingerprint(signerSignPub) - must reproduce exactly. The cross-platform
 * vector in ProvisionOpsTest pins it. Distinct version prefixes keep the four artifacts
 * non-interchangeable. Never sign raw JSON.
 */
object ProvisionOpsCrypto {
	fun provisionSigningBytes(p: ProvisionTenant, adminSignPub: String): ByteArray =
		listOf(
			"PROVISION_TENANT_V1",
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
			"REMOVE_TENANT_V1",
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

	/**
	 * first_root is SELF-signed by the fresh owner key (no admission exists yet): the owner key
	 * the Domain roots at lives INSIDE the artifact, and the verifier checks the signature
	 * against firstRoot.ownerSignPub. The one-time QR nonce (checked unspent at the Router) is the
	 * authorization; the self-signature only proves possession of the submitted owner key.
	 */
	fun firstRootSigningBytes(f: FirstRoot): ByteArray =
		listOf(
			"FIRST_ROOT_V1",
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
			"SET_DISPLAY_NAME_V1",
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

	/**
	 * delete_domain is the app-only "Revoke and Delete Domain": the rooted owner proves possession of
	 * the rooted key to purge its whole Domain slice from the Router. Owner-signed like set_display_name, so
	 * the bytes bind fingerprint(ownerSignPub); the distinct version prefix keeps a rename signature
	 * from replaying as a deletion over the same fields.
	 */
	fun deleteDomainSigningBytes(d: DeleteDomain, ownerSignPub: String): ByteArray =
		listOf(
			"DELETE_DOMAIN_V1",
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

	/**
	 * The cross-tenant roster request proof: the console proves it holds an admitted signing key by
	 * signing ROSTER_V1 over its OWN key + a fresh timestamp + nonce (proof of possession, mirroring
	 * the registration proof). The Router verifies the signature, freshness, and non-replay, then resolves
	 * the key to an admitted console. The preimage binds the RAW signer key (not a fingerprint), so
	 * it reproduces byte-for-byte against rosterRequestSigningBytes in federation-lifecycle.ts.
	 */
	fun rosterRequestSigningBytes(signerSignPub: String, proofAt: Long, nonce: String): ByteArray =
		listOf("ROSTER_V1", signerSignPub, proofAt.toString(), nonce).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signRosterRequest(signerSignPub: String, proofAt: Long, nonce: String, signPriv: String): String =
		Crypto.sign(rosterRequestSigningBytes(signerSignPub, proofAt, nonce), signPriv)

	/**
	 * The FLOW-2 trust-pending query proof: the target owner proves possession of its owner key by
	 * signing TRUST_PENDING_V1 over its OWN key + a fresh timestamp + nonce, so only the owner can
	 * enumerate the arms aimed at it. A distinct version tag from ROSTER_V1, so neither proof crosses
	 * over. Reproduces byte-for-byte against trustPendingSigningBytes in federation-lifecycle.ts.
	 */
	fun trustPendingSigningBytes(signerSignPub: String, proofAt: Long, nonce: String): ByteArray =
		listOf("TRUST_PENDING_V1", signerSignPub, proofAt.toString(), nonce).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signTrustPendingRequest(signerSignPub: String, proofAt: Long, nonce: String, signPriv: String): String =
		Crypto.sign(trustPendingSigningBytes(signerSignPub, proofAt, nonce), signPriv)

	/**
	 * The transport request proof: an owner proves it holds a rooted owner key by signing
	 * TRANSPORT_REQUEST_V1 over its OWN key + a fresh timestamp + nonce, so the Router can resolve the
	 * signer to a rooted owner and return the gateway-bridge transport. A distinct version tag from
	 * ROSTER_V1 / TRUST_PENDING_V1, so no proof crosses over. Reproduces byte-for-byte against
	 * transportRequestSigningBytes in federation-lifecycle.ts.
	 */
	fun transportRequestSigningBytes(signerSignPub: String, proofAt: Long, nonce: String): ByteArray =
		listOf("TRANSPORT_REQUEST_V1", signerSignPub, proofAt.toString(), nonce).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signTransportRequest(signerSignPub: String, proofAt: Long, nonce: String, signPriv: String): String =
		Crypto.sign(transportRequestSigningBytes(signerSignPub, proofAt, nonce), signPriv)
}
