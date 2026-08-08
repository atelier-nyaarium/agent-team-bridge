package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A session card shows one branch of its session's tree. These pin WHICH branch and how much of it,
 * because the card is a glance: the wrong slice reads as the session working on something else.
 */
class CardBranchTest {
	private fun row(id: String, depth: Int) =
		BoardRow(BoardEntry(id = id, title = "t-$id", state = "open", rank = "m"), "gw", depth)

	/** Two roots, the second with three children. Mirrors a session that finished one thing and is
	 * partway into another. */
	private val tree = listOf(
		row("done-root", 0),
		row("work", 0),
		row("c1", 1),
		row("c2", 1),
		row("c3", 1),
	)

	private fun idsFor(currentId: String?, max: Int = CARD_BRANCH_MAX) =
		cardBranchOf(tree, currentId, max).rows.map { it.entry.id }

	@Test
	fun aChildShowsItsWholeBranchStartingFromTheRoot() {
		// The root names what the work IS. Starting at the current entry would show indented children
		// hanging under nothing.
		assertEquals(listOf("work", "c1", "c2", "c3"), idsFor("c2"))
	}

	@Test
	fun aRootShowsItselfAndItsChildrenAndStopsAtTheNextRoot() {
		assertEquals(listOf("work", "c1", "c2", "c3"), idsFor("work"))
		assertEquals(listOf("done-root"), idsFor("done-root"))
	}

	@Test
	fun anUnknownOrAbsentCurrentFallsBackToTheFirstBranch() {
		// The current entry can be trashed or reassigned between the line and the branch being built.
		// Showing nothing would read as a session with no board work at all.
		assertEquals(listOf("done-root"), idsFor(null))
		assertEquals(listOf("done-root"), idsFor("no-such-entry"))
	}

	@Test
	fun anEmptyTreeAsksForNothing() {
		assertEquals(CardBranch(emptyList(), 0), cardBranchOf(emptyList(), "c1"))
	}

	@Test
	fun anOversizedBranchKeepsItsTopAndCountsTheRest() {
		val cut = cardBranchOf(tree, "c2", max = 2)
		assertEquals(listOf("work", "c1"), cut.rows.map { it.entry.id })
		assertEquals(2, cut.hidden)
	}

	@Test
	fun aBranchThatFitsCountsNothing() {
		assertEquals(0, cardBranchOf(tree, "c2", max = 4).hidden)
	}
}
