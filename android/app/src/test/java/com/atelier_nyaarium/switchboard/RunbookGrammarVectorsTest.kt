package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.runbooks.placeholdersOf
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/** Drives the placeholder twin through the vectors src/__tests__/runbook-grammar-vectors.test.ts reads. */
class RunbookGrammarVectorsTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("runbook-grammar/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	@Test
	fun theScanMatchesTheSharedRule() {
		val cases = vectors["cases"]!!.jsonArray
		assertEquals(true, cases.isNotEmpty())
		for (case in cases) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val body = o["body"]!!.jsonPrimitive.content
			val expected = o["names"]!!
			if (expected is JsonNull) {
				assertEquals(name, null, placeholdersOf(body))
			} else {
				assertEquals(name, expected.jsonArray.map { it.jsonPrimitive.content }, placeholdersOf(body))
			}
		}
	}
}
