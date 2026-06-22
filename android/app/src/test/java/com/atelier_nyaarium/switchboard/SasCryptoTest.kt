package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainParty
import com.atelier_nyaarium.switchboard.proto.SasCrypto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drives the hand-authored SasCrypto twin through the same vectors the vitest suite
 * reads (tests/fixtures/cross-domain-sas/vectors.json), so the twin cannot drift from
 * the TS source: a differing SAS code, commitment, or canonical preimage fails here.
 */
class SasCryptoTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("cross-domain-sas/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun party(o: JsonObject) =
		CrossDomainParty(
			ownerSignPub = o["ownerSignPub"]!!.jsonPrimitive.content,
			gatewaySignPub = o["gatewaySignPub"]!!.jsonPrimitive.content,
			gatewayBoxPub = o["gatewayBoxPub"]!!.jsonPrimitive.content,
			domainId = o["domainId"]!!.jsonPrimitive.content,
			gatewayId = o["gatewayId"]!!.jsonPrimitive.content,
		)

	@Test
	fun sasVectors() {
		for (v in vectors()["cases"]!!.jsonArray) {
			val o = v.jsonObject
			val sas = SasCrypto.crossDomainSas(party(o["a"]!!.jsonObject), party(o["b"]!!.jsonObject), o["pin"]!!.jsonPrimitive.content)
			assertEquals(o["sas"]!!.jsonPrimitive.content, sas)
		}
	}

	@Test
	fun orderIndependent() {
		val oi = vectors()["orderIndependent"]!!.jsonObject
		val sas = SasCrypto.crossDomainSas(party(oi["a"]!!.jsonObject), party(oi["b"]!!.jsonObject), oi["pin"]!!.jsonPrimitive.content)
		assertEquals(oi["sas"]!!.jsonPrimitive.content, sas)
	}

	@Test
	fun substitutionYieldsDifferentCode() {
		val sub = vectors()["substitution"]!!.jsonObject
		val sas = SasCrypto.crossDomainSas(party(sub["a"]!!.jsonObject), party(sub["b"]!!.jsonObject), sub["pin"]!!.jsonPrimitive.content)
		assertEquals(sub["sas"]!!.jsonPrimitive.content, sas)
		assertNotEquals(sub["differsFrom"]!!.jsonPrimitive.content, sas)
	}

	@Test
	fun commitmentVector() {
		val c = vectors()["commitment"]!!.jsonObject
		val party = party(c["a"]!!.jsonObject)
		val salt = c["salt"]!!.jsonPrimitive.content
		val expected = c["commitment"]!!.jsonPrimitive.content
		assertEquals(expected, SasCrypto.crossDomainCommitment(party, salt))
		assertTrue(SasCrypto.verifyCrossDomainCommitment(expected, party, salt))
	}

	@Test
	fun commitmentSaltBinding() {
		val c = vectors()["commitmentSaltBinding"]!!.jsonObject
		val party = party(c["a"]!!.jsonObject)
		val salt = c["salt"]!!.jsonPrimitive.content
		val got = SasCrypto.crossDomainCommitment(party, salt)
		assertEquals(c["commitment"]!!.jsonPrimitive.content, got)
		assertNotEquals(c["differsFrom"]!!.jsonPrimitive.content, got)
		// The differing-salt commitment must NOT verify against this party+salt.
		assertFalse(SasCrypto.verifyCrossDomainCommitment(c["differsFrom"]!!.jsonPrimitive.content, party, salt))
	}

	@Test
	fun handComputedPreimages() {
		val hc = vectors()["handComputed"]!!.jsonObject
		val a = party(hc["a"]!!.jsonObject)
		val b = party(hc["b"]!!.jsonObject)
		val pin = hc["pin"]!!.jsonPrimitive.content
		val salt = hc["salt"]!!.jsonPrimitive.content

		val sasPreimage = SasCrypto.crossDomainSasPreimage(a, b, pin).toString(Charsets.UTF_8)
		assertEquals(hc["sasPreimage"]!!.jsonPrimitive.content, sasPreimage)

		val commitmentPreimage = SasCrypto.crossDomainCommitmentPreimage(a, salt).toString(Charsets.UTF_8)
		assertEquals(hc["commitmentPreimage"]!!.jsonPrimitive.content, commitmentPreimage)

		assertEquals(hc["sas"]!!.jsonPrimitive.content, SasCrypto.crossDomainSas(a, b, pin))
		assertEquals(hc["commitment"]!!.jsonPrimitive.content, SasCrypto.crossDomainCommitment(a, salt))
	}
}
