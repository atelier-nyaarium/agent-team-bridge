package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drives trimLineEnds through the same rows the vitest suite reads
 * (tests/fixtures/pane-trim/vectors.json), so this rule and the daemon's capture-side twin
 * (src/shared/pane-trim.ts) cannot drift.
 *
 * Both sides run it and neither may stop: the daemon trims so the polled frame carries text instead
 * of blank cells, and the console trims because an older daemon still ships padded frames. Trimming
 * is idempotent, so agreeing here is what makes running it twice a no-op rather than a second
 * opinion. A drift shows up as a coloured row losing the cells that painted it out to the pane edge.
 */
class PaneTrimVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("pane-trim/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["vectors"]!!.jsonArray

	@Test
	fun paneTrimVectors() {
		val all = vectors()
		assertTrue("fixture must not be empty", all.isNotEmpty())
		for (v in all) {
			val o = v.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val input = o["input"]!!.jsonPrimitive.content
			val expected = o["expectText"]!!.jsonPrimitive.content
			val got = trimLineEnds(parseAnsiRuns(input)).joinToString("") { it.text }
			assertEquals(name, expected, got)
		}
	}
}
