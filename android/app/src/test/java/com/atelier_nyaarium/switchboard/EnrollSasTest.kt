package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollParty
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
 * Drives the hand-authored enroll* SasCrypto twins through the same vectors the vitest
 * suite reads (tests/fixtures/enroll-sas/vectors.json), so the owner-anchored role-tagged
 * enroll SAS cannot drift from the TS source. Unlike the gateway SAS, the preimage is
 * role-FIXED: swapping roles or reassigning fields must change the code.
 */
class EnrollSasTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("enroll-sas/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun party(o: JsonObject) =
		EnrollParty(
			ownerSignPub = o["ownerSignPub"]!!.jsonPrimitive.content,
			ownerBoxPub = o["ownerBoxPub"]!!.jsonPrimitive.content,
			domainId = o["domainId"]!!.jsonPrimitive.content,
		)

	private fun sasOf(o: JsonObject) =
		SasCrypto.enrollSas(party(o["admin"]!!.jsonObject), party(o["enrollee"]!!.jsonObject), o["pin"]!!.jsonPrimitive.content)

	@Test
	fun sasVectors() {
		for (v in vectors()["cases"]!!.jsonArray) {
			val o = v.jsonObject
			assertEquals(o["sas"]!!.jsonPrimitive.content, sasOf(o))
		}
	}

	@Test
	fun roleFixedAndInjective() {
		// Swapping ADMIN/ENROLLEE roles AND reassigning fields each yield a different code.
		for (key in listOf("roleSwap", "fieldReassign", "substitution")) {
			val o = vectors()[key]!!.jsonObject
			val sas = sasOf(o)
			assertEquals(o["sas"]!!.jsonPrimitive.content, sas)
			assertNotEquals(o["differsFrom"]!!.jsonPrimitive.content, sas)
		}
	}

	@Test
	fun commitmentVector() {
		val c = vectors()["commitment"]!!.jsonObject
		val p = party(c["party"]!!.jsonObject)
		val role = c["role"]!!.jsonPrimitive.content
		val salt = c["salt"]!!.jsonPrimitive.content
		val expected = c["commitment"]!!.jsonPrimitive.content
		assertEquals(expected, SasCrypto.enrollCommitment(p, role, salt))
		assertTrue(SasCrypto.verifyEnrollCommitment(expected, p, role, salt))
	}

	@Test
	fun commitmentRoleBinding() {
		val c = vectors()["commitmentRoleBinding"]!!.jsonObject
		val p = party(c["party"]!!.jsonObject)
		val role = c["role"]!!.jsonPrimitive.content
		val salt = c["salt"]!!.jsonPrimitive.content
		val got = SasCrypto.enrollCommitment(p, role, salt)
		assertEquals(c["commitment"]!!.jsonPrimitive.content, got)
		assertNotEquals(c["differsFrom"]!!.jsonPrimitive.content, got)
	}

	@Test
	fun commitmentSaltBinding() {
		val c = vectors()["commitmentSaltBinding"]!!.jsonObject
		val p = party(c["party"]!!.jsonObject)
		val role = c["role"]!!.jsonPrimitive.content
		val salt = c["salt"]!!.jsonPrimitive.content
		val got = SasCrypto.enrollCommitment(p, role, salt)
		assertEquals(c["commitment"]!!.jsonPrimitive.content, got)
		assertNotEquals(c["differsFrom"]!!.jsonPrimitive.content, got)
		assertFalse(SasCrypto.verifyEnrollCommitment(c["differsFrom"]!!.jsonPrimitive.content, p, role, salt))
	}

	@Test
	fun handComputedPreimages() {
		val hc = vectors()["handComputed"]!!.jsonObject
		val admin = party(hc["admin"]!!.jsonObject)
		val enrollee = party(hc["enrollee"]!!.jsonObject)
		val pin = hc["pin"]!!.jsonPrimitive.content
		val role = hc["role"]!!.jsonPrimitive.content
		val salt = hc["salt"]!!.jsonPrimitive.content

		assertEquals(
			hc["sasPreimage"]!!.jsonPrimitive.content,
			SasCrypto.enrollSasPreimage(admin, enrollee, pin).toString(Charsets.UTF_8),
		)
		assertEquals(
			hc["commitmentPreimage"]!!.jsonPrimitive.content,
			SasCrypto.enrollCommitmentPreimage(admin, role, salt).toString(Charsets.UTF_8),
		)
		assertEquals(hc["sas"]!!.jsonPrimitive.content, SasCrypto.enrollSas(admin, enrollee, pin))
		assertEquals(hc["commitment"]!!.jsonPrimitive.content, SasCrypto.enrollCommitment(admin, role, salt))
	}
}
