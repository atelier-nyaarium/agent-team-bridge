package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardAttachment
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
	fun aProvenDeadFetchStopsTheWaitButNeverTouchesTheOpsOwnList() {
		// The member leaves fetchFrom (nothing resumes the pull) and sources (readiness stops
		// demanding it), while the op's attachment list stays whole: the GATEWAY drops the
		// unresolvable member and reports it, which is the terminal answer - this device never
		// predicts what another machine holds.
		val members = listOf(BoardAttachment("dead-blob", "gw-b", "pic.png", "image/png", 9))
		val attach = action("a", "gw-b", ConsoleOp.BoardSetAttachments("m1", members, supplied = emptyList()))
			.copy(sources = mapOf("dead-blob" to "/gone/pic.png"), fetchFrom = mapOf("dead-blob" to "gw-a"))
		val delete = action("d", "gw-a", ConsoleOp.BoardRemove(listOf("m1")), dependsOn = "a")

		val next = markFetchDead(listOf(attach, delete), "m1", "dead-blob")
		val healed = next.first { it.opId == "a" }
		assertTrue(healed.fetchFrom.isEmpty())
		assertTrue(healed.sources.isEmpty())
		assertEquals(members, (healed.op as ConsoleOp.BoardSetAttachments).attachments)
		// A different entry's action waiting on the same blobId is untouched: the proof was about
		// THIS entry's queued move, and identity here is (entry, blob) like PendingFetch's.
		val other = action("x", "gw-b", ConsoleOp.BoardSetAttachments("m2", members, supplied = emptyList()))
			.copy(fetchFrom = mapOf("dead-blob" to "gw-a"))
		assertEquals(mapOf("dead-blob" to "gw-a"), markFetchDead(listOf(other), "m1", "dead-blob").first().fetchFrom)
	}

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

	@Test
	fun upsertDropsAttachments_soAMoveNeverShowsBytesTheDestinationLacks() {
		// Mirrors the gateway's own upsert rule. A move ships a subtree VERBATIM, so keeping the list
		// here would paint the destination holding pictures it never ingested - and the console WRITES
		// off this view, producing an absolute attachment op that Gateway can never satisfy.
		val picture = BoardAttachment("sha256-${"a".repeat(64)}", "gw-a", "shot.png", "image/png", 3)
		val moved = entry("m1").copy(attachments = listOf(picture))

		val landed = applyBoardOp(emptyList(), ConsoleOp.BoardUpsert(listOf(moved)), now = 0)
		assertNull("a moved entry arrives with no attachments", landed.single().attachments)
	}

	@Test
	fun upsertLeavesAnExistingEntrysAttachmentsAlone() {
		// The other half of the same rule: an upsert is not how attachments change, so one that
		// touches an entry already holding some must not clear them either.
		val picture = BoardAttachment("sha256-${"b".repeat(64)}", "gw-a", "kept.png", "image/png", 3)
		val existing = listOf(entry("m1").copy(attachments = listOf(picture)))

		val landed = applyBoardOp(existing, ConsoleOp.BoardUpsert(listOf(entry("m1").copy(title = "renamed"))), now = 0)
		assertEquals("renamed", landed.single().title)
		assertEquals(listOf(picture), landed.single().attachments)
	}

	@Test
	fun aQueuedHeadUnderTheStrugglingThresholdClosesItsLaneForEveryOtherEntry() {
		// Why an unfinished upload MUST charge an attempt. A head below the threshold holds the lane,
		// so an action that can never reach the threshold blocks unrelated work forever and silently.
		val stuck = action("a1", "gw-a", ConsoleOp.BoardSetAttachments("e1", emptyList()), attempts = 0)
		val other = action("a2", "gw-a", ConsoleOp.BoardSetState("e2", "done"))

		assertEquals(listOf(stuck), eligibleBoardActions(listOf(stuck, other), strugglingAfter = 8))
		// Once it is charged past the threshold the lane serves the other entry as well.
		val charged = stuck.copy(attempts = 8)
		assertTrue(eligibleBoardActions(listOf(charged, other), strugglingAfter = 8).contains(other))
	}
}
