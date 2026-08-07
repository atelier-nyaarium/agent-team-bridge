package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
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
		trashedAt: Long? = null,
	) = BoardEntry(id = id, title = "t-$id", state = state, parent = parent, rank = rank, sessionId = sessionId, trashedAt = trashedAt)

	private fun allIds(rows: BoardRows): List<String> {
		val groups = listOf(rows.unassigned) + rows.sessions
		return groups.flatMap { g -> g.rows.map { it.entry.id } } + rows.trash.map { it.entry.id }
	}

	@Test
	fun everyEntryRendersExactlyOnceAcrossPileSessionsGatherAndTrash() {
		val rows = flattenBoard(
			listOf(
				BoardSource(
					"gw-a",
					listOf(
						entry("pile1"),
						entry("pile2", parent = "pile1", rank = "V"),
						entry("mine", sessionId = "s1", state = "in_progress"),
						entry("kid", parent = "mine", sessionId = "s1"),
						entry("doneLeaf", sessionId = "s1", state = "done", rank = "x"),
						entry("bin", trashedAt = 5L),
					),
				),
			),
		)
		val ids = allIds(rows)
		assertEquals(ids.size, ids.distinct().size)
		assertEquals(setOf("pile1", "pile2", "mine", "kid", "doneLeaf", "bin"), ids.toSet())
	}

	@Test
	fun theDestinationCopyWinsEvenWhenTheStaleOriginCopyIsUnassigned() {
		// The mid-move state on the origin: the entry is still there and no longer claimed. The
		// resolver must answer "no Gateway" for an absent session, or the origin copy looks correctly
		// homed and permanently beats the copy that actually moved.
		val rows = flattenBoard(
			listOf(
				BoardSource("gw-a", listOf(entry("m1", sessionId = null))),
				BoardSource("gw-b", listOf(entry("m1", sessionId = "sess-b", state = "in_progress"))),
			),
			sessionGateway = { if (it == "sess-b") "gw-b" else null },
		)
		val all = (listOf(rows.unassigned) + rows.sessions).flatMap { it.rows }
		assertEquals(1, all.size)
		assertEquals("gw-b", all[0].gatewayId)
	}

	@Test
	fun twoGatewaysRunningTheSameSessionNameStayTwoGroups() {
		// A stored sessionId is the bare local field, unique only within its Gateway. Grouping on it
		// alone would merge two machines' work under one header, labelled with whichever was found.
		val rows = flattenBoard(
			listOf(
				BoardSource("gw-a", listOf(entry("a1", sessionId = "recipe.claude"))),
				BoardSource("gw-b", listOf(entry("b1", sessionId = "recipe.claude"))),
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
	fun theMoveCrashWindowCollapsesById_destinationCopyWins() {
		// Same id on both gateways: the copy homed where its sessionId lives (the destination) wins.
		val rows = flattenBoard(
			listOf(
				BoardSource("gw-a", listOf(entry("m1", sessionId = "sess-b"))),
				BoardSource("gw-b", listOf(entry("m1", sessionId = "sess-b", state = "in_progress"))),
			),
			sessionGateway = { if (it == "sess-b") "gw-b" else null },
		)
		val all = (listOf(rows.unassigned) + rows.sessions).flatMap { it.rows }
		assertEquals(1, all.size)
		assertEquals("gw-b", all[0].gatewayId)
		assertEquals("in_progress", all[0].entry.state)
	}

	@Test
	fun aLiveCopyBeatsATrashedOne() {
		val rows = flattenBoard(
			listOf(
				BoardSource("gw-a", listOf(entry("x", trashedAt = 9L))),
				BoardSource("gw-b", listOf(entry("x"))),
			),
		)
		assertTrue(rows.trash.isEmpty())
		assertEquals(listOf("x"), rows.unassigned.rows.map { it.entry.id })
	}

	@Test
	fun aFinishedBranchStaysInPlaceWithEveryDescendantShown() {
		// Nothing collapses and nothing moves to the bottom: a finished entry reads as finished from
		// its own state mark, and hiding the shape of the work behind a tap is what this replaced.
		val rows = flattenBoard(
			listOf(
				BoardSource(
					"gw-a",
					listOf(
						entry("root", state = "in_progress", sessionId = "s1", rank = "a"),
						entry("doneParent", state = "done", sessionId = "s1", rank = "b"),
						entry("d1", state = "done", parent = "doneParent", sessionId = "s1", rank = "a"),
						entry("d2", state = "cancelled", parent = "doneParent", sessionId = "s1", rank = "b"),
						entry("loneDone", state = "done", sessionId = "s1", rank = "c"),
					),
				),
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
				BoardSource(
					"gw-a",
					listOf(
						entry("a", parent = "b", sessionId = "s1"),
						entry("b", parent = "a", sessionId = "s1"),
					),
				),
			),
		)
		assertTrue(rows.sessions.sumOf { it.rows.size } <= 2)
	}

	@Test
	fun siblingsOrderByRankAndAClaimedChildRootsItsOwnGroup() {
		val rows = flattenBoard(
			listOf(
				BoardSource(
					"gw-a",
					listOf(
						entry("p", rank = "m"),
						entry("claimed", parent = "p", sessionId = "s1"),
						entry("second", rank = "x"),
						entry("first", rank = "a"),
					),
				),
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
				BoardSource("gw-a", listOf(entry("a", parent = "b"), entry("b", parent = "a"))),
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
				BoardSource(
					"gw-a",
					listOf(
						entry("old", trashedAt = 1L),
						entry("new", trashedAt = 9L),
						entry("kidOfTrashed", parent = "old"),
					),
				),
			),
		)
		assertEquals(listOf("new", "old"), rows.trash.map { it.entry.id })
		// A live child of a trashed parent renders as a root of its group, not under the trash.
		assertEquals(listOf("kidOfTrashed"), rows.unassigned.rows.map { it.entry.id })
	}
}
