package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Behavior tests for the tab drag-reorder geometry: given a row of heterogeneous-width slots and a
 * ghost position, the insertion index, the sideways shifts that open the landing gap, the gap's own
 * position, and the committed order must all agree with each other - the gap left edge is asserted
 * against the final layout each committed order would actually produce.
 */
class TabDragMathTest {

	// Three tabs with distinct widths, 4px gaps: A [0..100], B [104..184], C [188..248].
	private val slots =
		listOf(
			TabSlot(0f, 0f, 100f, 36f),
			TabSlot(104f, 0f, 80f, 36f),
			TabSlot(188f, 0f, 60f, 36f),
		)
	private val tabs = listOf("A", "B", "C")
	private val gap = 4f

	private fun spanOf(draggedIndex: Int) = slots[draggedIndex].width + gap

	@Test
	fun holdingATabOverItsOwnSlotCommitsNothingAndShiftsNothing() {
		val ghost = slots[0].x + slots[0].width / 2f
		val k = tabInsertionIndex(slots, 0, ghost)
		assertEquals(0, k)
		assertEquals(tabs, tabCommitOrder(tabs, 0, k))
		for (i in tabs.indices) assertEquals(0f, tabShift(i, 0, k, spanOf(0)), 0.001f)
	}

	@Test
	fun draggingRightPastTheNextCenterSwapsWithIt() {
		// B's center is 144; ghost at 150 has crossed it.
		val k = tabInsertionIndex(slots, 0, 150f)
		assertEquals(1, k)
		assertEquals(listOf("B", "A", "C"), tabCommitOrder(tabs, 0, k))
		// B slides left into A's vacated slot; C stays.
		assertEquals(-104f, tabShift(1, 0, k, spanOf(0)), 0.001f)
		assertEquals(0f, tabShift(2, 0, k, spanOf(0)), 0.001f)
		// The gap opens where A will land: after B's width plus one gap.
		assertEquals(84f, tabGapLeftEdge(slots, 0, k, gap), 0.001f)
	}

	@Test
	fun draggingFarRightLandsAtTheEnd() {
		val k = tabInsertionIndex(slots, 0, 500f)
		assertEquals(2, k)
		assertEquals(listOf("B", "C", "A"), tabCommitOrder(tabs, 0, k))
		assertEquals(-104f, tabShift(1, 0, k, spanOf(0)), 0.001f)
		assertEquals(-104f, tabShift(2, 0, k, spanOf(0)), 0.001f)
		// Final layout: B [0..80], C [84..144], gap at 148.
		assertEquals(148f, tabGapLeftEdge(slots, 0, k, gap), 0.001f)
	}

	@Test
	fun draggingFarLeftLandsAtTheStart() {
		val k = tabInsertionIndex(slots, 2, 0f)
		assertEquals(0, k)
		assertEquals(listOf("C", "A", "B"), tabCommitOrder(tabs, 2, k))
		// A and B slide right by C's span to make room at the front.
		assertEquals(64f, tabShift(0, 2, k, spanOf(2)), 0.001f)
		assertEquals(64f, tabShift(1, 2, k, spanOf(2)), 0.001f)
		assertEquals(0f, tabGapLeftEdge(slots, 2, k, gap), 0.001f)
	}

	@Test
	fun draggingTheMiddleTabToTheEndShiftsOnlyTheTabItPasses() {
		val k = tabInsertionIndex(slots, 1, 300f)
		assertEquals(2, k)
		assertEquals(listOf("A", "C", "B"), tabCommitOrder(tabs, 1, k))
		assertEquals(0f, tabShift(0, 1, k, spanOf(1)), 0.001f)
		assertEquals(-84f, tabShift(2, 1, k, spanOf(1)), 0.001f)
		// Final layout: A [0..100], C [104..164], gap at 168.
		assertEquals(168f, tabGapLeftEdge(slots, 1, k, gap), 0.001f)
	}

	@Test
	fun aSingleTabAlwaysLandsWhereItStarted() {
		val lone = listOf(TabSlot(0f, 0f, 100f, 36f))
		assertEquals(0, tabInsertionIndex(lone, 0, -500f))
		assertEquals(0, tabInsertionIndex(lone, 0, 500f))
		assertEquals(listOf("A"), tabCommitOrder(listOf("A"), 0, 0))
		assertEquals(0f, tabGapLeftEdge(lone, 0, 0, gap), 0.001f)
	}

	@Test
	fun crossingIsByCenterNotByIndexWithHeterogeneousWidths() {
		// Ghost at 120 sits right of B's left edge (104) but left of its center (144): no swap yet.
		assertEquals(0, tabInsertionIndex(slots, 0, 120f))
		// One pixel past the center: swapped.
		assertEquals(1, tabInsertionIndex(slots, 0, 145f))
	}
}
