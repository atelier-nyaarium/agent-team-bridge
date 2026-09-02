package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardRowsTest {
	private fun entry(
		id: String,
		state: String = "open",
		parent: String? = null,
		rank: String = "m",
		sessionId: String? = null,
		session: BoardSession? = null,
		trashedAt: Long? = null,
	) = BoardEntry(id = id, title = "t-$id", state = state, parent = parent, rank = rank, sessionId = sessionId, session = session, trashedAt = trashedAt)

	private fun allIds(rows: BoardRows): List<String> {
		val groups = listOf(rows.unassigned) + rows.sessions
		return groups.flatMap { g -> g.rows.map { it.entry.id } } + rows.trash.map { it.entry.id }
	}

	@Test
	fun everyEntryRendersExactlyOnceAcrossPileSessionsGatherAndTrash() {
		val rows = flattenBoard(
			listOf(
				entry("pile1"),
				entry("pile2", parent = "pile1", rank = "V"),
				entry("mine", sessionId = "s1", state = "in_progress"),
				entry("kid", parent = "mine", sessionId = "s1"),
				entry("doneLeaf", sessionId = "s1", state = "done", rank = "x"),
				entry("bin", trashedAt = 5L),
			),
		)
		val ids = allIds(rows)
		assertEquals(ids.size, ids.distinct().size)
		assertEquals(setOf("pile1", "pile2", "mine", "kid", "doneLeaf", "bin"), ids.toSet())
	}

	@Test
	fun twoGatewaysRunningTheSameSessionNameStayTwoGroups() {
		// Session IDs are local to each gateway.
		val rows = flattenBoard(
			listOf(
				entry("a1", sessionId = "recipe.claude", session = BoardSession("domain", "gw-a", "recipe.claude")),
				entry("b1", sessionId = "recipe.claude", session = BoardSession("domain", "gw-b", "recipe.claude")),
			),
		)
		assertEquals(2, rows.sessions.size)
		assertEquals(
			setOf(GroupKey("gw-a", "recipe.claude"), GroupKey("gw-b", "recipe.claude")),
			rows.sessions.mapNotNull { it.key }.toSet(),
		)
		assertEquals(listOf("a1"), rows.sessions.single { it.key?.gatewayId == "gw-a" }.rows.map { it.entry.id })
	}

	@Test
	fun aFinishedBranchStaysInPlaceWithEveryDescendantShown() {
		// Nothing collapses and nothing moves to the bottom: a finished entry reads as finished from
		// its own state mark, so collapsing or relocating it would only hide the shape of the work behind
		// a tap.
		val rows = flattenBoard(
			listOf(
				entry("root", state = "in_progress", sessionId = "s1", rank = "a"),
				entry("doneParent", state = "done", sessionId = "s1", rank = "b"),
				entry("d1", state = "done", parent = "doneParent", sessionId = "s1", rank = "a"),
				entry("d2", state = "cancelled", parent = "doneParent", sessionId = "s1", rank = "b"),
				entry("loneDone", state = "done", sessionId = "s1", rank = "c"),
			),
		)
		val group = rows.sessions.single()
		assertEquals(listOf("root", "doneParent", "d1", "d2", "loneDone"), group.rows.map { it.entry.id })
		assertEquals(listOf(0, 0, 1, 1, 0), group.rows.map { it.depth })
	}

	@Test
	fun aParentCycleTerminatesRatherThanHangingTheList() {
		val rows = flattenBoard(
			listOf(
				entry("a", parent = "b", sessionId = "s1"),
				entry("b", parent = "a", sessionId = "s1"),
			),
		)
		assertTrue(rows.sessions.sumOf { it.rows.size } <= 2)
	}

	@Test
	fun siblingsOrderByRankAndAClaimedChildRootsItsOwnGroup() {
		val rows = flattenBoard(
			listOf(
				entry("p", rank = "m"),
				entry("claimed", parent = "p", sessionId = "s1"),
				entry("second", rank = "x"),
				entry("first", rank = "a"),
			),
		)
		assertEquals(listOf("first", "p", "second"), rows.unassigned.rows.map { it.entry.id })
		val group = rows.sessions.single()
		assertEquals(listOf("claimed"), group.rows.map { it.entry.id })
		assertEquals(0, group.rows[0].depth)
	}

	@Test
	fun aParentCycleFromBadDataTerminatesInsteadOfHangingTheUi() {
		val rows = flattenBoard(
			listOf(
				entry("a", parent = "b"),
				entry("b", parent = "a"),
			),
		)
		// Neither is a root (each parent is live in the same group), so neither renders - but the
		// call returns rather than looping, and nothing crashes downstream.
		assertTrue(allIds(rows).isEmpty())
	}

	@Test
	fun trashSortsNewestFirstAndStaysOutOfTheTree() {
		val rows = flattenBoard(
			listOf(
				entry("old", trashedAt = 1L),
				entry("new", trashedAt = 9L),
				entry("kidOfTrashed", parent = "old"),
			),
		)
		assertEquals(listOf("new", "old"), rows.trash.map { it.entry.id })
		// A live child of a trashed parent renders as a root of its group, not under the trash.
		assertEquals(listOf("kidOfTrashed"), rows.unassigned.rows.map { it.entry.id })
	}
}
