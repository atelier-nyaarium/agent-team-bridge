package com.atelier_nyaarium.switchboard.board

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class BoardAuthorityVectorsTest {
	@Test
	fun refusalVocabularyMatchesFixture() {
		val json = Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("board-authority/vocabulary.json")!!.bufferedReader().readText(),
		).jsonObject
		val refusals = json["refusals"]!!.jsonArray.map { it.jsonPrimitive.content }
		assertEquals(refusals, BOARD_REFUSALS.toList())
	}
}
