package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for stepTabDrag: the pure adjacent-swap arithmetic behind the session tab row's
 * hold-to-drag reorder. Pure function, no Compose/Android dependency, so the gesture math is
 * exercised without an emulator.
 */
class TabReorderTest {
	private val order = listOf("a", "b", "c", "d")
	private val width: (String) -> Int = { 100 }

	@Test
	fun doesNotSwapBelowHalfTheNeighborsWidth() {
		val (newOrder, idx, offset) = stepTabDrag(order, 1, 40f, width)
		assertEquals(order, newOrder)
		assertEquals(1, idx)
		assertEquals(40f, offset)
	}

	@Test
	fun swapsRightPastHalfTheNeighborsWidthAndCarriesTheRemainder() {
		val (newOrder, idx, offset) = stepTabDrag(order, 1, 60f, width)
		assertEquals(listOf("a", "c", "b", "d"), newOrder)
		assertEquals(2, idx)
		assertEquals(-40f, offset)
	}

	@Test
	fun swapsLeftPastHalfTheNeighborsWidthAndCarriesTheRemainder() {
		val (newOrder, idx, offset) = stepTabDrag(order, 2, -60f, width)
		assertEquals(listOf("a", "c", "b", "d"), newOrder)
		assertEquals(1, idx)
		assertEquals(40f, offset)
	}

	@Test
	fun hopsAcrossMultipleNeighborsInOneStepWhenTheOffsetIsLargeEnough() {
		// From index 0, a 160px rightward drag (with all tabs 100px wide) crosses two neighbors in
		// one call rather than one hop per call: past "b" (index 1) at offset 160, then past "c"
		// (now the neighbor at index 2) at the carried-over offset of 60.
		val (newOrder, idx, offset) = stepTabDrag(order, 0, 160f, width)
		assertEquals(listOf("b", "c", "a", "d"), newOrder)
		assertEquals(2, idx)
		assertEquals(-40f, offset)
	}

	@Test
	fun neverSwapsPastTheRightEdge() {
		val (newOrder, idx, offset) = stepTabDrag(order, 3, 500f, width)
		assertEquals(order, newOrder)
		assertEquals(3, idx)
		assertEquals(500f, offset)
	}

	@Test
	fun neverSwapsPastTheLeftEdge() {
		val (newOrder, idx, offset) = stepTabDrag(order, 0, -500f, width)
		assertEquals(order, newOrder)
		assertEquals(0, idx)
		assertEquals(-500f, offset)
	}

	@Test
	fun swapThresholdScalesWithTheActualNeighborWidthNotAFixedConstant() {
		// "b" is unusually wide (240px, so half is 120); a 100px drag alone must not be enough to
		// swap past it even though it would clear a uniform 100px-wide neighbor.
		val varied = listOf("a", "b", "c")
		val varyingWidth: (String) -> Int = { t -> if (t == "b") 240 else 100 }
		val (newOrder, idx, offset) = stepTabDrag(varied, 0, 100f, varyingWidth)
		assertEquals(varied, newOrder)
		assertEquals(0, idx)
		assertEquals(100f, offset)
	}
}
