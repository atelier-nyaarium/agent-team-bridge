package com.atelier_nyaarium.switchboard.crypto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the Kotlin transport-request signing against switchboard's node:crypto, through the same
 * vectors the vitest suite reads (tests/fixtures/transport-request/vectors.json). If the canonical
 * encoding or the signature scheme diverges, the node-signed proof below stops verifying here -
 * which would silently break an owner pulling its network's gateway-bridge transport. Mirrors
 * ProvisionOpsTest's roster / trust-pending vectors.
 */
class TransportRequestTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("transport-request/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	@Test
	fun transportRequestCanonicalBytesMatchNode() {
		val v = vectors()
		val vec = v["transport"]!!.jsonObject
		val value = vec["value"]!!.jsonObject
		val signer = value["signerSignPub"]!!.jsonPrimitive.content
		val bytes = ProvisionOpsCrypto.transportRequestSigningBytes(
			signer,
			value["proofAt"]!!.jsonPrimitive.content.toLong(),
			value["nonce"]!!.jsonPrimitive.content,
		)
		CanonicalBytes.assertCanonicalBytes(bytes, vec)
		// The node-signed proof verifies under the signer key (the twin reproduces it).
		assertTrue(Crypto.verify(bytes, vec["signature"]!!.jsonPrimitive.content, signer))
		// A different key must not verify the node-signed proof.
		assertFalse(Crypto.verify(bytes, vec["signature"]!!.jsonPrimitive.content, Crypto.generateIdentity().sign.pub))
		// The distinct version tag means the ROSTER_V1 proof never verifies as a transport request.
		val rosterSig = ProvisionOpsCrypto.signRosterRequest(
			signer,
			value["proofAt"]!!.jsonPrimitive.content.toLong(),
			value["nonce"]!!.jsonPrimitive.content,
			v["ownerSignPriv"]!!.jsonPrimitive.content,
		)
		assertFalse(Crypto.verify(bytes, rosterSig, signer))
	}

	@Test
	fun signsAndVerifiesLocally() {
		val owner = Crypto.generateIdentity()
		val attacker = Crypto.generateIdentity()
		val proof = ProvisionOpsCrypto.signTransportRequest(owner.sign.pub, 9000L, "bm9uY2U=", owner.sign.priv)
		val bytes = ProvisionOpsCrypto.transportRequestSigningBytes(owner.sign.pub, 9000L, "bm9uY2U=")
		assertTrue(Crypto.verify(bytes, proof, owner.sign.pub))
		assertFalse(Crypto.verify(bytes, proof, attacker.sign.pub))
	}
}
