package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.BoardRefused
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardManagerTest {
	/** In-memory storage: the manager's whole persistence surface (see BoardStore). */
	private class FakeStore(private var blob: String? = null) : BoardStore {
		override fun loadTaskBoard(): String? = blob

		override fun saveTaskBoard(json: String) {
			blob = json
		}

		override fun loadGatewayId(): String = "gw-route"
	}

	private fun storeStub(): BoardStore = FakeStore()

	private fun entry(id: String, sessionId: String? = null, state: String = "open", trashedAt: Long? = null) =
		BoardEntry(id = id, title = "t-$id", state = state, rank = "m", sessionId = sessionId, trashedAt = trashedAt)

	@Test
	fun anEditIsVisibleImmediatelyAndSurvivesAStaleSnapshot() {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("a")), version = null, truncated = false)

		board.enqueue(ConsoleOp.BoardSetState("a", "done"), "gw-route")
		assertEquals("done", board.mergedEntries("gw-route").single().state)

		// The gateway re-sends the pre-edit truth (our reply was lost); the queue still wins.
		board.applySnapshot("gw-route", listOf(entry("a")), version = null, truncated = false)
		assertEquals("done", board.mergedEntries("gw-route").single().state)
	}

	@Test
	fun aTruncatedSnapshotKeepsTheUncoveredTailButHonoursDeletionsInsideItsRange() {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("a"), entry("b"), entry("c"), entry("z")), null, false)

		// The projection is an id-sorted PREFIX, so ["a","c"] means: authoritative through "c", and
		// silent past it. "b" was DELETED. "z" is beyond the cut and its cached copy stands.
		board.applySnapshot("gw-route", listOf(entry("a"), entry("c")), null, truncated = true)
		assertEquals(listOf("a", "c", "z"), board.mergedEntries("gw-route").map { it.id }.sorted())
	}

	@Test
	fun anUntruncatedSnapshotIsTakenWholeSoNothingCarriesForward() {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("a"), entry("z")), null, truncated = true)
		board.applySnapshot("gw-route", listOf(entry("a")), null, truncated = false)
		assertEquals(listOf("a"), board.mergedEntries("gw-route").map { it.id })
	}

	@Test
	fun aCrossGatewayMoveReadsAsDoneLocallyWhileTheDeleteStillWaitsOnTheWrite() {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("m1"), entry("kid").copy(parent = "m1")), null, false)

		val subtree = board.mergedEntries("gw-route").map { it.copy(sessionId = "sess-b") }
		board.enqueueMove(subtree, fromGateway = "gw-route", toGateway = "gw-b")

		// Optimistically the entry has already moved: gone from the origin, present at the
		// destination with the SAME ids, so the union renders it exactly once.
		assertTrue(board.mergedEntries("gw-route").isEmpty())
		assertEquals(listOf("m1", "kid"), board.mergedEntries("gw-b").map { it.id })
		assertTrue(board.mergedEntries("gw-b").all { it.sessionId == "sess-b" })
	}

	@Test
	fun theLiveLinePicksInProgressFirstAndCountsFinished() {
		val board = BoardManager(storeStub())
		board.applySnapshot(
			"gw-route",
			listOf(
				entry("done1", sessionId = "s1", state = "done"),
				entry("open1", sessionId = "s1", state = "open"),
				entry("busy", sessionId = "s1", state = "in_progress"),
				entry("theirs", sessionId = "s2"),
			),
			null,
			false,
		)
		val line = board.liveLine("gw-route", "s1")!!
		assertEquals("t-busy", line.title)
		assertEquals("in_progress", line.state)
		assertEquals(1, line.finished)
		assertEquals(3, line.total)
		assertNull(board.liveLine("gw-route", "nobody"))
	}

	@Test
	fun anAcceptedActionRetiresAndTheLaneCarriesOn() = runBlocking {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("a"), entry("b")), null, false)
		board.enqueue(ConsoleOp.BoardSetState("a", "done"), "gw-route")
		board.enqueue(ConsoleOp.BoardSetState("b", "done"), "gw-route")

		val writer = RecordingWriter()
		board.drain(writer)
		assertEquals(
			listOf<ConsoleOp>(ConsoleOp.BoardSetState("a", "done"), ConsoleOp.BoardSetState("b", "done")),
			writer.sent,
		)
		// Both applied, so the snapshot alone is the truth again.
		board.applySnapshot("gw-route", listOf(entry("a", state = "done"), entry("b", state = "done")), null, false)
		assertTrue(board.mergedEntries("gw-route").all { it.state == "done" })
	}

	@Test
	fun aTransportFailureKeepsTheEditQueuedForALaterDrain() = runBlocking {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("a")), null, false)
		board.enqueue(ConsoleOp.BoardSetState("a", "done"), "gw-route")

		board.drain(RecordingWriter(fail = { error("offline") }))
		// Still applied optimistically, and still queued - only a gateway refusal may discard it.
		assertEquals("done", board.mergedEntries("gw-route").single().state)
		val retry = RecordingWriter()
		board.drain(retry)
		assertEquals(listOf<ConsoleOp>(ConsoleOp.BoardSetState("a", "done")), retry.sent)
	}

	@Test
	fun aRefusedActionIsRetiredAndTheRowRevertsWithAMarker() = runBlocking {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("a")), null, false)
		board.enqueue(ConsoleOp.BoardSetState("a", "done"), "gw-route")

		board.drain(RecordingWriter(fail = { throw BoardRefused("entry_missing") }))
		assertEquals("open", board.mergedEntries("gw-route").single().state)
		assertEquals(listOf("entry_missing"), board.refusals.map { it.reason })
	}

	@Test
	fun forgettingASessionDropsItsQueuedEditsSoNoneCanOutliveTheDisposition() = runBlocking {
		val board = BoardManager(storeStub())
		board.applySnapshot(
			"gw-route",
			listOf(entry("mine", sessionId = "s1"), entry("theirs", sessionId = "s2")),
			null,
			false,
		)
		board.enqueue(ConsoleOp.BoardSetState("mine", "in_progress"), "gw-route")
		board.enqueue(ConsoleOp.BoardSetState("theirs", "in_progress"), "gw-route")

		assertEquals(1, board.dropQueuedForSession("gw-route", "s1"))

		// The forgotten session's edit is gone; an unrelated session's still drains.
		val writer = RecordingWriter()
		board.drain(writer)
		assertEquals(listOf<ConsoleOp>(ConsoleOp.BoardSetState("theirs", "in_progress")), writer.sent)
	}

	@Test
	fun forgettingAMovesDESTINATIONDropsBothHalvesOfTheInFlightMove() = runBlocking {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-a", listOf(entry("m1")), null, false)
		// A move to session s2 on gw-b: the write lands there, the delete on gw-a waits for it.
		val subtree = board.mergedEntries("gw-a").map { it.copy(sessionId = "s2") }
		board.enqueueMove(subtree, fromGateway = "gw-a", toGateway = "gw-b")

		// Forgetting s2 supersedes the move. Dropping the write takes its linked delete, so the entry
		// cannot be removed from the origin with nothing written at the destination.
		assertEquals(1, board.dropQueuedForSession("gw-b", "s2"))
		val writer = RecordingWriter()
		board.drain(writer)
		assertTrue(writer.sent.isEmpty())
		assertEquals(listOf("m1"), board.mergedEntries("gw-a").map { it.id })
	}

	private class RecordingWriter(
		private val fail: (() -> Unit)? = null,
		private val dropped: List<String> = emptyList(),
	) : BoardWriter {
		val sent = mutableListOf<ConsoleOp>()

		override suspend fun boardWrite(op: ConsoleOp, gatewayId: String, opId: String): List<String> {
			fail?.invoke()
			sent.add(op)
			return dropped
		}
	}

	@Test
	fun aDroppedAttachmentIsReportedToTheOwner() = runBlocking {
		// Dropping is a normal outcome now, so an unreported one is indistinguishable from a picture
		// vanishing on its own. It lands on the same row the owner already reads for a refused edit.
		val manager = BoardManager(storeStub())
		manager.enqueue(ConsoleOp.BoardSetAttachments("e1", emptyList()), "gw-route")

		manager.drain(RecordingWriter(dropped = listOf("gone.png")))

		assertEquals(1, manager.refusals.size)
		assertTrue(manager.refusals.single().reason.contains("gone.png"))
		// The write APPLIED, so the action retires rather than retrying.
		assertTrue(manager.strugglingEntries().isEmpty())
	}

	@Test
	fun oneGatewaysEmptySnapshotCannotDriveAByteDelete() {
		// A Gateway that lost its own board file answers with an EMPTY list over the wire, and the
		// phone then holds the last copies of its attachments. Buckets are keyed per entry and the keep
		// set is built per gateway, so a second Gateway still having entries must not make this true -
		// two machines is the ordinary configuration, not an edge case.
		val json = Json { ignoreUnknownKeys = true }
		val blob = BoardBlob(
			gateways = mapOf(
				"gw-a" to GatewayBoard(entries = listOf(entry("a1"))),
				"gw-b" to GatewayBoard(entries = emptyList()),
			),
		)
		val manager = BoardManager(FakeStore(json.encodeToString(BoardBlob.serializer(), blob)))

		assertFalse("one gateway's loss is not permission to delete its bytes", manager.boardIsKnown)
	}

	@Test
	fun anUndecodableBoardIsNotAnEmptyOne() {
		// The keep set is the only thing between every board picture on the device and the orphan
		// sweep. A board that failed to decode answers the same empty set a genuinely empty one does,
		// so without this distinction one bad prefs blob deletes every attachment in a single pass -
		// the reclaim shape the gateway explicitly refuses, rebuilt on the console.
		assertFalse("a stored board that will not parse is UNKNOWN", BoardManager(FakeStore("{not json")).boardIsKnown)
	}
}
