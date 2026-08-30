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
	fun withNoSidewaysDragTheRowKeepsItsOwnDepth() {
		// Dropped after b1, which is a child of b. Depth is chosen, not inherited from the row it
		// landed next to, so a root stays a root.
		val drop = boardDropTarget("a", pointerY = 260, visible = visible, rows = rows)!!
		assertEquals(null, drop.parent)
		assertEquals(0, drop.depth)
		assertTrue(BoardRank.isValid(drop.rank))
	}

	@Test
	fun draggingRightIndentsUnderTheRowAbove() {
		val drop = boardDropTarget("a", pointerY = 260, visible = visible, rows = rows, depthDelta = 1)!!
		assertEquals("b", drop.parent)
		assertEquals(1, drop.depth)
	}

	@Test
	fun depthIsClampedToWhatTheSlotAllows() {
		// One below the row above is the ceiling, however far the drag goes.
		val deep = boardDropTarget("a", pointerY = 260, visible = visible, rows = rows, depthDelta = 9)!!
		assertEquals(2, deep.depth)
		assertEquals("b1", deep.parent)

		// And top level is the floor.
		val shallow = boardDropTarget("a", pointerY = 260, visible = visible, rows = rows, depthDelta = -9)!!
		assertEquals(0, shallow.depth)
		assertEquals(null, shallow.parent)
	}

	@Test
	fun aRowCannotBeDroppedInsideItsOwnSubtree() {
		// Dragging b onto its own child resolves to nothing rather than making b its own ancestor.
		assertNull(boardDropTarget("b", pointerY = 260, visible = visible, rows = rows, depthDelta = 1))
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
