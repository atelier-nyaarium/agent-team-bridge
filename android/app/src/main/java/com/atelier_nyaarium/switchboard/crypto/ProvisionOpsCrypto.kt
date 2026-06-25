package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.FirstRoot
import com.atelier_nyaarium.switchboard.proto.ProvisionTenant
import com.atelier_nyaarium.switchboard.proto.RemoveTenant
import com.atelier_nyaarium.switchboard.proto.SetProfileName
import com.atelier_nyaarium.switchboard.proto.SignedFirstRoot
import com.atelier_nyaarium.switchboard.proto.SignedProvisionTenant
import com.atelier_nyaarium.switchboard.proto.SignedRemoveTenant
import com.atelier_nyaarium.switchboard.proto.SignedSetProfileName

/**
 * Friend cross-Domain onboarding signing, the byte-exact Kotlin counterpart of
 * switchboard's `src/shared/enrollment.ts`. The operator pre-stages a friend's pending
 * tenant (provision_tenant) or drops it (remove_tenant), the friend's app roots the Domain
 * on first connect (first_root, SELF-signed by its silently-generated owner key), and the
 * rooted owner renames the network (set_profile_name). evie verifies each against the
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
			p.profileName,
			p.issuedAt.toString(),
			p.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signProvision(p: ProvisionTenant, adminSignPriv: String, adminSignPub: String): SignedProvisionTenant =
		SignedProvisionTenant(
			provision = p,
			adminSignPub = adminSignPub,
			signature = Crypto.sign(provisionSigningBytes(p, adminSignPub), adminSignPriv),
		)

	fun verifyProvision(s: SignedProvisionTenant, expectedOperatorSignPub: String): Boolean =
		s.adminSignPub == expectedOperatorSignPub &&
			Crypto.verify(provisionSigningBytes(s.provision, expectedOperatorSignPub), s.signature, expectedOperatorSignPub)

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

	fun verifyRemove(s: SignedRemoveTenant, expectedOperatorSignPub: String): Boolean =
		s.adminSignPub == expectedOperatorSignPub &&
			Crypto.verify(removeSigningBytes(s.removal, expectedOperatorSignPub), s.signature, expectedOperatorSignPub)

	/**
	 * first_root is SELF-signed by the fresh owner key (no admission exists yet): the owner key
	 * the Domain roots at lives INSIDE the artifact, and the verifier checks the signature
	 * against firstRoot.ownerSignPub. The one-time QR nonce (checked unspent at evie) is the
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

	fun setProfileNameSigningBytes(r: SetProfileName, ownerSignPub: String): ByteArray =
		listOf(
			"SET_PROFILE_NAME_V1",
			Crypto.fingerprint(ownerSignPub),
			r.domainId,
			r.profileName,
			r.issuedAt.toString(),
			r.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signSetProfileName(r: SetProfileName, ownerSignPriv: String, ownerSignPub: String): SignedSetProfileName =
		SignedSetProfileName(
			rename = r,
			ownerSignPub = ownerSignPub,
			signature = Crypto.sign(setProfileNameSigningBytes(r, ownerSignPub), ownerSignPriv),
		)

	fun verifySetProfileName(s: SignedSetProfileName, expectedOwnerSignPub: String): Boolean =
		s.ownerSignPub == expectedOwnerSignPub &&
			Crypto.verify(setProfileNameSigningBytes(s.rename, expectedOwnerSignPub), s.signature, expectedOwnerSignPub)

	/**
	 * The cross-tenant roster request proof: the console proves it holds an admitted signing key by
	 * signing ROSTER_V1 over its OWN key + a fresh timestamp + nonce (proof of possession, mirroring
	 * the registration proof). evie verifies the signature, freshness, and non-replay, then resolves
	 * the key to an admitted console. The preimage binds the RAW signer key (not a fingerprint), so
	 * it reproduces byte-for-byte against rosterRequestSigningBytes in enrollment.ts.
	 */
	fun rosterRequestSigningBytes(signerSignPub: String, proofAt: Long, nonce: String): ByteArray =
		listOf("ROSTER_V1", signerSignPub, proofAt.toString(), nonce).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signRosterRequest(signerSignPub: String, proofAt: Long, nonce: String, signPriv: String): String =
		Crypto.sign(rosterRequestSigningBytes(signerSignPub, proofAt, nonce), signPriv)

	/**
	 * The FLOW-2 trust-pending query proof: the target owner proves possession of its owner key by
	 * signing TRUST_PENDING_V1 over its OWN key + a fresh timestamp + nonce, so only the owner can
	 * enumerate the arms aimed at it. A distinct version tag from ROSTER_V1, so neither proof crosses
	 * over. Reproduces byte-for-byte against trustPendingSigningBytes in enrollment.ts.
	 */
	fun trustPendingSigningBytes(signerSignPub: String, proofAt: Long, nonce: String): ByteArray =
		listOf("TRUST_PENDING_V1", signerSignPub, proofAt.toString(), nonce).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signTrustPendingRequest(signerSignPub: String, proofAt: Long, nonce: String, signPriv: String): String =
		Crypto.sign(trustPendingSigningBytes(signerSignPub, proofAt, nonce), signPriv)
}
