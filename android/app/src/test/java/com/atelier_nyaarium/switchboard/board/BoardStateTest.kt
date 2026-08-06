package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardStateTest {
	private fun entry(id: String, parent: String? = null, sessionId: String? = null) =
		BoardEntry(id = id, title = "t-$id", state = "open", parent = parent, rank = "m", sessionId = sessionId)

	private fun action(opId: String, gateway: String, op: ConsoleOp, dependsOn: String? = null, attempts: Int = 0) =
		PendingBoardAction(opId, gateway, op, dependsOn, attempts)

	@Test
	fun aStrugglingHeadStopsBlockingLaterWorkButIsStillRetried() {
		val queue = listOf(
			action("stuck", "gw", ConsoleOp.BoardSetState("a", "done"), attempts = 8),
			action("later", "gw", ConsoleOp.BoardSetState("b", "done")),
		)
		// The lane steps past the head that keeps failing...
		assertEquals(listOf("later"), eligibleBoardActions(queue, strugglingAfter = 8).map { it.opId })
		// ...and once nothing else is left, it is the lane's answer again rather than being stranded.
		val alone = retireBoardAction(queue, "later")
		assertEquals(listOf("stuck"), eligibleBoardActions(alone, strugglingAfter = 8).map { it.opId })
		// Below the threshold, ordinary head-first behaviour.
		assertEquals(listOf("stuck"), eligibleBoardActions(queue, strugglingAfter = 9).map { it.opId })
	}

	@Test
	fun theLaneNeverStepsPastAStrugglingActionOntoTheSameEntry() {
		// These ops are absolute, so sending the later one first would apply the older value last.
		val queue = listOf(
			action("stuck", "gw", ConsoleOp.BoardSetState("a", "done"), attempts = 8),
			action("same", "gw", ConsoleOp.BoardSetState("a", "paused")),
			action("other", "gw", ConsoleOp.BoardSetState("b", "done")),
		)
		assertEquals(listOf("stuck"), eligibleBoardActions(queue, strugglingAfter = 8).map { it.opId })
	}

	@Test
	fun perGatewayLanesLetTheLiveGatewayDrainPastTheDeadOne() {
		val queue = listOf(
			action("dead-1", "gw-off", ConsoleOp.BoardSetState("a", "done")),
			action("dead-2", "gw-off", ConsoleOp.BoardSetState("b", "done")),
			action("live-1", "gw-on", ConsoleOp.BoardSetState("c", "done")),
		)
		assertEquals(listOf("dead-1", "live-1"), eligibleBoardActions(queue).map { it.opId })

		val afterLive = retireBoardAction(queue, "live-1")
		assertEquals(listOf("dead-1"), eligibleBoardActions(afterLive).map { it.opId })
	}

	@Test
	fun theMovesDeleteHalfWaitsForItsWriteHalfToRetire() {
		val write = action("w", "gw-b", ConsoleOp.BoardUpsert(listOf(entry("m1"))))
		val delete = action("d", "gw-a", ConsoleOp.BoardRemove(listOf("m1")), dependsOn = "w")
		val queue = listOf(write, delete)

		assertEquals(listOf("w"), eligibleBoardActions(queue).map { it.opId })
		val afterWrite = retireBoardAction(queue, "w")
		assertEquals(listOf("d"), eligibleBoardActions(afterWrite).map { it.opId })
	}

	@Test
	fun aFreshSnapshotDoesNotRevertAPendingEdit() {
		// The gateway still says "open" (our set_state reply was lost); the pending action re-applies.
		val snapshot = listOf(entry("a"), entry("b"))
		val queue = listOf(action("op1", "gw-a", ConsoleOp.BoardSetState("a", "done")))
		val merged = mergeBoardSnapshot(snapshot, queue, "gw-a", now = 100)
		assertEquals("done", merged.single { it.id == "a" }.state)
		assertEquals("open", merged.single { it.id == "b" }.state)

		// Once retired, the snapshot alone is the truth.
		val settled = mergeBoardSnapshot(snapshot, retireBoardAction(queue, "op1"), "gw-a", now = 100)
		assertEquals("open", settled.single { it.id == "a" }.state)
	}

	@Test
	fun anotherGatewaysPendingActionsLeaveThisSnapshotAlone() {
		val snapshot = listOf(entry("a"))
		val queue = listOf(action("op1", "gw-b", ConsoleOp.BoardSetState("a", "done")))
		assertEquals("open", mergeBoardSnapshot(snapshot, queue, "gw-a", now = 0).single().state)
	}

	@Test
	fun optimisticOpsMirrorTheStoresSubtreeSemantics() {
		val tree = listOf(entry("p"), entry("k1", parent = "p"), entry("k2", parent = "k1"))

		val assigned = applyBoardOp(tree, ConsoleOp.BoardSetSession("p", "sess-1"), now = 0)
		assertTrue(assigned.all { it.sessionId == "sess-1" })

		val trashed = applyBoardOp(tree, ConsoleOp.BoardSetTrashed("k1", true), now = 42)
		assertNull(trashed.single { it.id == "p" }.trashedAt)
		assertEquals(42L, trashed.single { it.id == "k1" }.trashedAt)
		assertEquals(42L, trashed.single { it.id == "k2" }.trashedAt)

		val pendingCapture = applyBoardOp(tree, ConsoleOp.BoardUpsert(listOf(entry("new"))), now = 0)
		assertEquals(4, pendingCapture.size)

		val removed = applyBoardOp(tree, ConsoleOp.BoardRemove(listOf("k1", "k2")), now = 0)
		assertEquals(listOf("p"), removed.map { it.id })
	}

	@Test
	fun anOpForAVanishedEntryIsSkippedNotInvented() {
		val merged = applyBoardOp(emptyList(), ConsoleOp.BoardSetState("ghost", "done"), now = 0)
		assertTrue(merged.isEmpty())
	}
}
