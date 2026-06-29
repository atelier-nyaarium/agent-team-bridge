package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.ownerKeyId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drives the Kotlin ownerKeyId twin (crypto/OwnerId.kt) through the same vectors the vitest suite
 * reads (tests/fixtures/owner-id/vectors.json), so it cannot drift from the gateway's
 * shared/owner-id.ts: a differing owner id fails one of the two runtimes.
 */
class OwnerIdVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	@Test
	fun ownerKeyIdVectors() {
		val cases = json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("owner-id/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["cases"]!!.jsonArray
		assertTrue(cases.isNotEmpty())
		for (c in cases) {
			val o = c.jsonObject
			val signPub = o["signPub"]!!.jsonPrimitive.content
			val expected = o["ownerKeyId"]!!.jsonPrimitive.content
			assertEquals(expected, ownerKeyId(signPub))
		}
	}
}
