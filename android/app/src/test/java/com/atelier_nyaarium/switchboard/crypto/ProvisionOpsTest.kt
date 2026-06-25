package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.FirstRoot
import com.atelier_nyaarium.switchboard.proto.ProvisionTenant
import com.atelier_nyaarium.switchboard.proto.RemoveTenant
import com.atelier_nyaarium.switchboard.proto.SetDisplayName
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the Kotlin friend-onboarding signing (provision_tenant / remove_tenant / first_root /
 * set_display_name) against switchboard's node:crypto, through the same vectors the vitest
 * suite reads (tests/fixtures/provision-ops/vectors.json). If the canonical encoding or the
 * signature scheme diverges, the node-signed artifacts below stop verifying here - which
 * would silently break friend cross-Domain onboarding. Mirrors XDomainLinkTest.
 */
class ProvisionOpsTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("provision-ops/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun provision(o: JsonObject) =
		ProvisionTenant(
			domainId = o["domainId"]!!.jsonPrimitive.content,
			displayName = o["displayName"]!!.jsonPrimitive.content,
			issuedAt = o["issuedAt"]!!.jsonPrimitive.content.toLong(),
			nonce = o["nonce"]!!.jsonPrimitive.content,
		)

	private fun removal(o: JsonObject) =
		RemoveTenant(
			domainId = o["domainId"]!!.jsonPrimitive.content,
			issuedAt = o["issuedAt"]!!.jsonPrimitive.content.toLong(),
			nonce = o["nonce"]!!.jsonPrimitive.content,
		)

	private fun firstRoot(o: JsonObject) =
		FirstRoot(
			domainId = o["domainId"]!!.jsonPrimitive.content,
			ownerSignPub = o["ownerSignPub"]!!.jsonPrimitive.content,
			ownerBoxPub = o["ownerBoxPub"]!!.jsonPrimitive.content,
			nonce = o["nonce"]!!.jsonPrimitive.content,
			issuedAt = o["issuedAt"]!!.jsonPrimitive.content.toLong(),
		)

	private fun rename(o: JsonObject) =
		SetDisplayName(
			domainId = o["domainId"]!!.jsonPrimitive.content,
			displayName = o["displayName"]!!.jsonPrimitive.content,
			issuedAt = o["issuedAt"]!!.jsonPrimitive.content.toLong(),
			nonce = o["nonce"]!!.jsonPrimitive.content,
		)

	@Test
	fun provisionCanonicalBytesMatchNode() {
		val v = vectors()
		val adminSignPub = v["adminSignPub"]!!.jsonPrimitive.content
		val vec = v["provision"]!!.jsonObject
		val bytes = ProvisionOpsCrypto.provisionSigningBytes(provision(vec["value"]!!.jsonObject), adminSignPub)
		CanonicalBytes.assertCanonicalBytes(bytes, vec)
	}

	@Test
	fun removeCanonicalBytesMatchNode() {
		val v = vectors()
		val adminSignPub = v["adminSignPub"]!!.jsonPrimitive.content
		val vec = v["removal"]!!.jsonObject
		val bytes = ProvisionOpsCrypto.removeSigningBytes(removal(vec["value"]!!.jsonObject), adminSignPub)
		CanonicalBytes.assertCanonicalBytes(bytes, vec)
	}

	@Test
	fun firstRootCanonicalBytesMatchNode() {
		val v = vectors()
		val vec = v["firstRoot"]!!.jsonObject
		val bytes = ProvisionOpsCrypto.firstRootSigningBytes(firstRoot(vec["value"]!!.jsonObject))
		CanonicalBytes.assertCanonicalBytes(bytes, vec)
	}

	@Test
	fun renameCanonicalBytesMatchNode() {
		val v = vectors()
		val ownerSignPub = v["friendOwnerSignPub"]!!.jsonPrimitive.content
		val vec = v["rename"]!!.jsonObject
		val bytes = ProvisionOpsCrypto.setDisplayNameSigningBytes(rename(vec["value"]!!.jsonObject), ownerSignPub)
		CanonicalBytes.assertCanonicalBytes(bytes, vec)
	}

	@Test
	fun rosterRequestCanonicalBytesMatchNode() {
		val v = vectors()
		val vec = v["roster"]!!.jsonObject
		val value = vec["value"]!!.jsonObject
		val signer = value["signerSignPub"]!!.jsonPrimitive.content
		val bytes = ProvisionOpsCrypto.rosterRequestSigningBytes(
			signer,
			value["proofAt"]!!.jsonPrimitive.content.toLong(),
			value["nonce"]!!.jsonPrimitive.content,
		)
		CanonicalBytes.assertCanonicalBytes(bytes, vec)
		// The node-signed proof verifies under the signer key (the twin reproduces it).
		assertTrue(Crypto.verify(bytes, vec["signature"]!!.jsonPrimitive.content, signer))
	}

	@Test
	fun trustPendingCanonicalBytesMatchNode() {
		val v = vectors()
		val vec = v["trustPending"]!!.jsonObject
		val value = vec["value"]!!.jsonObject
		val signer = value["signerSignPub"]!!.jsonPrimitive.content
		val bytes = ProvisionOpsCrypto.trustPendingSigningBytes(
			signer,
			value["proofAt"]!!.jsonPrimitive.content.toLong(),
			value["nonce"]!!.jsonPrimitive.content,
		)
		CanonicalBytes.assertCanonicalBytes(bytes, vec)
		assertTrue(Crypto.verify(bytes, vec["signature"]!!.jsonPrimitive.content, signer))
		// The distinct version tag means the ROSTER_V1 proof never verifies as a trust-pending query.
		val rosterSig = ProvisionOpsCrypto.signRosterRequest(
			signer,
			value["proofAt"]!!.jsonPrimitive.content.toLong(),
			value["nonce"]!!.jsonPrimitive.content,
			v["friendOwnerSignPriv"]!!.jsonPrimitive.content,
		)
		assertFalse(Crypto.verify(bytes, rosterSig, signer))
	}

	@Test
	fun verifiesNodeSignedAdminOps() {
		val v = vectors()
		val adminSignPub = v["adminSignPub"]!!.jsonPrimitive.content

		val pVec = v["provision"]!!.jsonObject
		val pBytes = ProvisionOpsCrypto.provisionSigningBytes(provision(pVec["value"]!!.jsonObject), adminSignPub)
		assertTrue(Crypto.verify(pBytes, pVec["signature"]!!.jsonPrimitive.content, adminSignPub))

		val rVec = v["removal"]!!.jsonObject
		val rBytes = ProvisionOpsCrypto.removeSigningBytes(removal(rVec["value"]!!.jsonObject), adminSignPub)
		assertTrue(Crypto.verify(rBytes, rVec["signature"]!!.jsonPrimitive.content, adminSignPub))

		// A different admin key must not verify either signature.
		val other = Crypto.generateIdentity()
		assertFalse(Crypto.verify(pBytes, pVec["signature"]!!.jsonPrimitive.content, other.sign.pub))
		assertFalse(Crypto.verify(rBytes, rVec["signature"]!!.jsonPrimitive.content, other.sign.pub))
	}

	@Test
	fun verifiesNodeSignedFirstRoot() {
		val v = vectors()
		val ownerSignPub = v["friendOwnerSignPub"]!!.jsonPrimitive.content
		val vec = v["firstRoot"]!!.jsonObject
		val bytes = ProvisionOpsCrypto.firstRootSigningBytes(firstRoot(vec["value"]!!.jsonObject))
		// The self-signature verifies against the owner key the Domain roots at.
		assertTrue(Crypto.verify(bytes, vec["signature"]!!.jsonPrimitive.content, ownerSignPub))
		// Any other key must not verify the node-signed first-root.
		assertFalse(Crypto.verify(bytes, vec["signature"]!!.jsonPrimitive.content, Crypto.generateIdentity().sign.pub))
	}

	@Test
	fun verifiesNodeSignedRename() {
		val v = vectors()
		val ownerSignPub = v["friendOwnerSignPub"]!!.jsonPrimitive.content
		val vec = v["rename"]!!.jsonObject
		val bytes = ProvisionOpsCrypto.setDisplayNameSigningBytes(rename(vec["value"]!!.jsonObject), ownerSignPub)
		assertTrue(Crypto.verify(bytes, vec["signature"]!!.jsonPrimitive.content, ownerSignPub))
		assertFalse(Crypto.verify(bytes, vec["signature"]!!.jsonPrimitive.content, Crypto.generateIdentity().sign.pub))
	}

	@Test
	fun signsAndVerifiesLocally() {
		val adminOwner = Crypto.generateIdentity()
		val attacker = Crypto.generateIdentity()

		val p = ProvisionTenant("home", "Home Lab", 5000L, "cA==")
		val signedP = ProvisionOpsCrypto.signProvision(p, adminOwner.sign.priv, adminOwner.sign.pub)
		assertTrue(ProvisionOpsCrypto.verifyProvision(signedP, adminOwner.sign.pub))
		assertFalse(ProvisionOpsCrypto.verifyProvision(signedP, attacker.sign.pub))
		// A tampered displayName must not verify.
		assertFalse(ProvisionOpsCrypto.verifyProvision(signedP.copy(provision = p.copy(displayName = "Evil")), adminOwner.sign.pub))

		val r = RemoveTenant("home", 6000L, "cg==")
		val signedR = ProvisionOpsCrypto.signRemove(r, adminOwner.sign.priv, adminOwner.sign.pub)
		assertTrue(ProvisionOpsCrypto.verifyRemove(signedR, adminOwner.sign.pub))
		assertFalse(ProvisionOpsCrypto.verifyRemove(signedR, attacker.sign.pub))

		// The distinct prefixes mean a provision signature does not verify as a removal over the
		// same fields (and the reverse), so neither can be replayed as the other.
		val crossRemoval = RemoveTenant(p.domainId, p.issuedAt, p.nonce)
		assertFalse(Crypto.verify(ProvisionOpsCrypto.removeSigningBytes(crossRemoval, adminOwner.sign.pub), signedP.signature, adminOwner.sign.pub))
	}

	@Test
	fun firstRootSignsAndVerifiesLocally() {
		val owner = Crypto.generateIdentity()
		val attacker = Crypto.generateIdentity()
		val f = FirstRoot("home", owner.sign.pub, owner.box.pub, "bm9uY2U=", 7000L)
		val signed = ProvisionOpsCrypto.signFirstRoot(f, owner.sign.priv)
		assertTrue(ProvisionOpsCrypto.verifyFirstRoot(signed))
		// Re-pointing the rooted ownerSignPub breaks the self-signature.
		assertFalse(ProvisionOpsCrypto.verifyFirstRoot(signed.copy(firstRoot = f.copy(ownerSignPub = attacker.sign.pub))))
		// A tampered nonce (the one-time QR token) breaks the self-signature.
		assertFalse(ProvisionOpsCrypto.verifyFirstRoot(signed.copy(firstRoot = f.copy(nonce = "b3RoZXI="))))
	}

	@Test
	fun renameSignsAndVerifiesLocally() {
		val owner = Crypto.generateIdentity()
		val attacker = Crypto.generateIdentity()
		val r = SetDisplayName("home", "My Network", 8000L, "bg==")
		val signed = ProvisionOpsCrypto.signSetDisplayName(r, owner.sign.priv, owner.sign.pub)
		assertTrue(ProvisionOpsCrypto.verifySetDisplayName(signed, owner.sign.pub))
		assertFalse(ProvisionOpsCrypto.verifySetDisplayName(signed, attacker.sign.pub))
		assertFalse(ProvisionOpsCrypto.verifySetDisplayName(signed.copy(rename = r.copy(displayName = "Hijacked")), owner.sign.pub))
	}
}
