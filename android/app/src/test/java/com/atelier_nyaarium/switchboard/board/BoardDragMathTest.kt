package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardDragMathTest {
	private fun row(id: String, rank: String, parent: String? = null, depth: Int = 0) =
		BoardRow(BoardEntry(id = id, title = id, state = "open", parent = parent, rank = rank), "gw", depth)

	/** Three roots at 100px each, plus one child of b. */
	private val rows = listOf(
		row("a", "a"),
		row("b", "m"),
		row("b1", "m", parent = "b", depth = 1),
		row("c", "x"),
	)
	private val visible = listOf(
		RowSpan("a", 0, 100),
		RowSpan("b", 100, 100),
		RowSpan("b1", 200, 100),
		RowSpan("c", 300, 100),
	)

	@Test
	fun droppingBetweenTwoRootsMintsBetweenTheirRanks() {
		// Pointer in the lower half of "a" -> lands after a, before b.
		val drop = boardDropTarget("c", pointerY = 80, visible = visible, rows = rows)!!
		assertEquals("c", drop.id)
		assertNull(drop.parent)
		assertTrue(drop.rank > "a")
		assertTrue(drop.rank < "m")
	}

	@Test
	fun droppingOverANestedRowAdoptsThatRowsParentNotTheVisibleNeighbour() {
		// b1 is a child of b. Dropping "a" over b1 must make it a child of b, not a root - the
		// visible neighbour above (b) is at a different depth.
		val drop = boardDropTarget("a", pointerY = 260, visible = visible, rows = rows)!!
		assertEquals("b", drop.parent)
		assertTrue(BoardRank.isValid(drop.rank))
	}

	@Test
	fun droppingWhereItAlreadySitsIsANoOp() {
		assertNull(boardDropTarget("b", pointerY = 130, visible = visible, rows = rows))
		// And a drop onto its own row never resolves either.
		assertNull(boardDropTarget("b", pointerY = 150, visible = visible, rows = rows))
	}

	@Test
	fun aPointerPastEitherEdgeClampsToTheEndRowsInsteadOfFailing() {
		val top = boardDropTarget("c", pointerY = -50, visible = visible, rows = rows)
		assertEquals(null, top?.parent)
		assertTrue(top!!.rank < "a")

		val bottom = boardDropTarget("a", pointerY = 9999, visible = visible, rows = rows)!!
		assertTrue(bottom.rank > "x")
	}

	@Test
	fun rowsBetweenTheOriginAndThePointerShiftByTheDraggedRowsOwnHeight() {
		// Dragging "c" (span 300..400, centre 350) upward to y=120 opens a gap: b and b1 move down.
		val shifts = boardRowShift("c", pointerY = 120, visible = visible)
		assertEquals(100, shifts["b"])
		assertEquals(100, shifts["b1"])
		assertNull(shifts["a"])
		assertNull(shifts["c"])

		// Dragging "a" downward moves the passed rows up instead.
		val down = boardRowShift("a", pointerY = 260, visible = visible)
		assertEquals(-100, down["b"])
		assertEquals(-100, down["b1"])
	}

	@Test
	fun anUnknownOrOffscreenDragResolvesToNothingRatherThanGuessing() {
		assertNull(boardDropTarget("ghost", pointerY = 100, visible = visible, rows = rows))
		assertNull(boardDropTarget("a", pointerY = 100, visible = emptyList(), rows = rows))
		assertTrue(boardRowShift("ghost", pointerY = 100, visible = visible).isEmpty())
	}
}
