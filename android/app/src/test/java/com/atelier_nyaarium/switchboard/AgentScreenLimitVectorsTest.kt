package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drives the hand-authored AgentScreen.limitNotice twin through the same vectors the vitest suite
 * reads (tests/fixtures/limit-notice/vectors.json), so the twin cannot drift from the TS classifier:
 * a screen either runtime reads differently fails one of the two. The console gates its own Resume
 * affordance on this, so a drift would show the button on a session that is not actually blocked.
 */
class AgentScreenLimitVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("limit-notice/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["vectors"]!!.jsonArray

	@Test
	fun limitNoticeVectors() {
		val all = vectors()
		assertTrue("fixture must not be empty", all.isNotEmpty())
		for (v in all) {
			val o = v.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val screen = o["screen"]!!.jsonArray.joinToString("\n") { it.jsonPrimitive.content }
			val expected = o["expect"]!!
			val got = AgentScreen.limitNotice(screen)
			if (expected is JsonNull) {
				assertNull(name, got)
				continue
			}
			assertNotNull(name, got)
			val detail = expected.jsonObject["detail"]!!
			if (detail is JsonNull) assertNull(name, got!!.detail)
			else assertEquals(name, detail.jsonPrimitive.content, got!!.detail)
		}
	}
}
