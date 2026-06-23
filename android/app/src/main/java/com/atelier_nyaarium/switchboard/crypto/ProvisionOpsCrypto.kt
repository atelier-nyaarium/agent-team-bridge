package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.FirstRoot
import com.atelier_nyaarium.switchboard.proto.ProvisionTenant
import com.atelier_nyaarium.switchboard.proto.RemoveTenant
import com.atelier_nyaarium.switchboard.proto.SetOperatorName
import com.atelier_nyaarium.switchboard.proto.SignedFirstRoot
import com.atelier_nyaarium.switchboard.proto.SignedProvisionTenant
import com.atelier_nyaarium.switchboard.proto.SignedRemoveTenant
import com.atelier_nyaarium.switchboard.proto.SignedSetOperatorName

/**
 * Friend cross-Domain onboarding signing, the byte-exact Kotlin counterpart of
 * switchboard's `src/shared/enrollment.ts`. The operator pre-stages a friend's pending
 * tenant (provision_tenant) or drops it (remove_tenant), the friend's app roots the Domain
 * on first connect (first_root, SELF-signed by its silently-generated owner key), and the
 * rooted owner renames the network (set_operator_name). evie verifies each against the
 * matching key, so the canonical signing bytes - a versioned, newline-joined, fixed-order
 * encoding binding fingerprint(signerSignPub) - must reproduce exactly. The cross-platform
 * vector in ProvisionOpsTest pins it. Distinct version prefixes keep the four artifacts
 * non-interchangeable. Never sign raw JSON.
 */
object ProvisionOpsCrypto {
	fun provisionSigningBytes(p: ProvisionTenant, operatorSignPub: String): ByteArray =
		listOf(
			"PROVISION_TENANT_V1",
			Crypto.fingerprint(operatorSignPub),
			p.domainId,
			p.operatorName,
			p.issuedAt.toString(),
			p.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signProvision(p: ProvisionTenant, operatorSignPriv: String, operatorSignPub: String): SignedProvisionTenant =
		SignedProvisionTenant(
			provision = p,
			operatorSignPub = operatorSignPub,
			signature = Crypto.sign(provisionSigningBytes(p, operatorSignPub), operatorSignPriv),
		)

	fun verifyProvision(s: SignedProvisionTenant, expectedOperatorSignPub: String): Boolean =
		s.operatorSignPub == expectedOperatorSignPub &&
			Crypto.verify(provisionSigningBytes(s.provision, expectedOperatorSignPub), s.signature, expectedOperatorSignPub)

	fun removeSigningBytes(r: RemoveTenant, operatorSignPub: String): ByteArray =
		listOf(
			"REMOVE_TENANT_V1",
			Crypto.fingerprint(operatorSignPub),
			r.domainId,
			r.issuedAt.toString(),
			r.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signRemove(r: RemoveTenant, operatorSignPriv: String, operatorSignPub: String): SignedRemoveTenant =
		SignedRemoveTenant(
			removal = r,
			operatorSignPub = operatorSignPub,
			signature = Crypto.sign(removeSigningBytes(r, operatorSignPub), operatorSignPriv),
		)

	fun verifyRemove(s: SignedRemoveTenant, expectedOperatorSignPub: String): Boolean =
		s.operatorSignPub == expectedOperatorSignPub &&
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

	fun setOperatorNameSigningBytes(r: SetOperatorName, ownerSignPub: String): ByteArray =
		listOf(
			"SET_OPERATOR_NAME_V1",
			Crypto.fingerprint(ownerSignPub),
			r.domainId,
			r.operatorName,
			r.issuedAt.toString(),
			r.nonce,
		).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signSetOperatorName(r: SetOperatorName, ownerSignPriv: String, ownerSignPub: String): SignedSetOperatorName =
		SignedSetOperatorName(
			rename = r,
			ownerSignPub = ownerSignPub,
			signature = Crypto.sign(setOperatorNameSigningBytes(r, ownerSignPub), ownerSignPriv),
		)

	fun verifySetOperatorName(s: SignedSetOperatorName, expectedOwnerSignPub: String): Boolean =
		s.ownerSignPub == expectedOwnerSignPub &&
			Crypto.verify(setOperatorNameSigningBytes(s.rename, expectedOwnerSignPub), s.signature, expectedOwnerSignPub)
}
