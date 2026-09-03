package com.atelier_nyaarium.switchboard.board

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class BoardRankTest {
	@Test
	fun appendingKeepsInsertionOrderAndValidity() {
		val ranks = mutableListOf<String>()
		repeat(50) { ranks.add(BoardRank.between(ranks.lastOrNull(), null)) }
		assertEquals(ranks.sorted(), ranks)
		assertTrue(ranks.all { BoardRank.isValid(it) })
	}

	@Test
	fun droppingBetweenNeighboursLandsStrictlyBetween() {
		var ranks = listOf("A", "V", "q")
		repeat(3) {
			ranks = ranks.flatMapIndexed { i, r ->
				if (i + 1 < ranks.size) listOf(r, BoardRank.between(r, ranks[i + 1])) else listOf(r)
			}
			assertEquals(ranks.sorted(), ranks)
			assertEquals(ranks.distinct().size, ranks.size)
		}
	}

	@Test
	fun mirrorsTheTypescriptTwinOnPinnedVectors() {
		val vectors = Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("board-rank/vectors.json")!!.bufferedReader().readText(),
		).jsonObject
		assertEquals(62, vectors["alphabet"]!!.jsonPrimitive.content.length)
		for (vector in vectors["between"]!!.jsonArray + vectors["after"]!!.jsonArray) {
			val value = vector.jsonObject
			assertEquals(value["rank"]!!.jsonPrimitive.content, BoardRank.between(
				value["before"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,
				value["after"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,
			))
		}
	}
}
