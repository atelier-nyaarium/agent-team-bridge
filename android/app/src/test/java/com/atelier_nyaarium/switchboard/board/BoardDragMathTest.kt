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
	fun noDropEverNamesAParentInsideTheDraggedSubtree() {
		// The carried rows are skipped rather than blocking, so the pointer passing over b's own child
		// still resolves - just never to a parent that would make b its own ancestor.
		val carried = boardSubtreeIds("b", rows)
		for (y in -100..500 step 20) {
			for (delta in -2..2) {
				val drop = boardDropTarget("b", pointerY = y, visible = visible, rows = rows, depthDelta = delta)
				assertTrue("y=$y delta=$delta", drop?.parent !in carried)
			}
		}
	}

	@Test
	fun aPointerInAGapBetweenRowsTakesTheNearestSlotNotTheLastRow() {
		// A spaced list leaves the pointer inside no row at all. Resolving by containment fell through
		// to the last visible row, so a drop near the top landed at the bottom.
		val spaced = listOf(RowSpan("a", 0, 60), RowSpan("b", 100, 60), RowSpan("b1", 200, 60), RowSpan("c", 300, 60))
		// y=80 sits in the gap between a and b, above b's centre, so it lands between them.
		val drop = boardDropTarget("c", pointerY = 80, visible = spaced, rows = rows)!!
		assertTrue(drop.rank > "a")
		assertTrue(drop.rank < "m")
	}

	@Test
	fun theInsertionLineFollowsWhatIsVisible() {
		// Scrolled so only the last two rows are on screen. The drop's logical predecessor is offscreen,
		// but the line still has somewhere to go: the top of the first row that is rendered.
		val onScreen = listOf(RowSpan("b1", 0, 100), RowSpan("c", 100, 100))
		assertEquals(0, boardDropBoundary(-20, onScreen, setOf("a")))
		// Below everything on screen, the line sits at the bottom edge of the last one.
		assertEquals(200, boardDropBoundary(9999, onScreen, setOf("a")))
		// A carried row is never a landing edge: with b1 carried, a pointer over it resolves against c
		// instead of going dead.
		assertEquals(100, boardDropBoundary(50, onScreen, setOf("b1")))
		assertEquals(200, boardDropBoundary(180, onScreen, setOf("b1")))
		assertNull(boardDropBoundary(50, onScreen, setOf("b1", "c")))
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
	fun aDraggedRowCarriesItsChildren() {
		assertEquals(setOf("b", "b1"), boardSubtreeIds("b", rows))
		assertEquals(setOf("a"), boardSubtreeIds("a", rows))
	}

	@Test
	fun anUnknownOrOffscreenDragResolvesToNothingRatherThanGuessing() {
		assertNull(boardDropTarget("ghost", pointerY = 100, visible = visible, rows = rows))
		assertNull(boardDropTarget("a", pointerY = 100, visible = emptyList(), rows = rows))
		assertNull(boardDropBoundary(100, emptyList(), emptySet()))
	}
}
