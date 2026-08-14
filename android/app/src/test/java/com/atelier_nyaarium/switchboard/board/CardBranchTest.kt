package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A session card shows one branch of its session's tree. These pin WHICH branch and how much of it,
 * because the card is a glance: the wrong slice reads as the session working on something else.
 */
class CardBranchTest {
	private fun row(id: String, depth: Int, state: String = "open") =
		BoardRow(BoardEntry(id = id, title = "t-$id", state = state, rank = "m"), "gw", depth)

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
		cardBranchOf(tree, currentId, max).rungs.map { rung ->
			when (rung) {
				is CardRung.Entry -> rung.row.entry.id
				is CardRung.Finished -> "${rung.count} finished"
			}
		}

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
	fun aBranchThatFitsCountsNothing() {
		assertEquals(0, cardBranchOf(tree, "c2", max = 4).hidden)
	}

	////////////////////////////////
	//  Centering on the work

	/** A long run: five finished children, then the one in progress, then twenty untouched. */
	private val longRun = listOf(row("root", 0)) +
		(1..5).map { row("f$it", 1, state = "done") } +
		listOf(row("now", 1, state = "in_progress")) +
		(1..20).map { row("todo$it", 1) }

	@Test
	fun aFinishedRunCollapsesSoTheEntryBeingWorkedOnIsVisible() {
		val branch = cardBranchOf(longRun, "now")
		val ids = branch.rungs.map { rung ->
			when (rung) {
				is CardRung.Entry -> rung.row.entry.id
				is CardRung.Finished -> "${rung.count} done"
			}
		}

		// The whole point: the prefix used to be five finished titles and a count.
		assertEquals(listOf("root", "5 done", "now", "todo1", "todo2", "todo3"), ids)
		// The collapsed five are represented, so only what is genuinely absent is counted.
		assertEquals(17, branch.hidden)
	}

	@Test
	fun theWindowFollowsTheWorkPastTheTopOfTheBranch() {
		// Nothing finished, and the current entry sits deep: a prefix would never show it.
		val open = listOf(row("root", 0)) + (1..20).map { row("c$it", 1) }
		val ids = cardBranchOf(open, "c15").rungs.filterIsInstance<CardRung.Entry>().map { it.row.entry.id }

		assertEquals(listOf("root", "c14", "c15", "c16", "c17", "c18"), ids)
	}

	@Test
	fun aLoneFinishedEntryKeepsItsTitle() {
		// "1 done" costs the same line as the title and says less.
		val one = listOf(row("root", 0), row("f1", 1, state = "done"), row("now", 1, state = "in_progress"))
		assertEquals(listOf("root", "f1", "now"), idsForTree(one, "now"))
	}

	@Test
	fun aRunOfMixedFinishedStatesIsNotCalledDone() {
		val mixed = listOf(row("root", 0), row("f1", 1, state = "done"), row("f2", 1, state = "cancelled"))
		val rung = cardBranchOf(mixed, "root").rungs.last()

		assertEquals(CardRung.Finished(2, 1, allDone = false), rung)
	}

	private fun idsForTree(rows: List<BoardRow>, currentId: String?) =
		cardBranchOf(rows, currentId).rungs.map { rung ->
			when (rung) {
				is CardRung.Entry -> rung.row.entry.id
				is CardRung.Finished -> "${rung.count} done"
			}
		}
}
