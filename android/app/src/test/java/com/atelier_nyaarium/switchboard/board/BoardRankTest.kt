package com.atelier_nyaarium.switchboard.board

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

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
		// The same calls in src/shared/board-rank.ts yield these exact strings; a divergence means
		// the two sides order a shared board differently.
		assertEquals("V", BoardRank.between(null, null))
		assertEquals("l", BoardRank.between("V", null))
		assertEquals("g", BoardRank.between("V", "r"))
		assertEquals("VV", BoardRank.between("V", "W"))
		assertEquals("8", BoardRank.between(null, "G"))
	}
}
