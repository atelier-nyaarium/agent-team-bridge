package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.BoardRefused
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardManagerTest {
	/** In-memory storage: the manager's whole persistence surface (see BoardStore). */
	private class FakeStore : BoardStore {
		private var blob: String? = null

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
	fun theForgetDispositionCancelsOnlyUnfinishedLiveWork() = runBlocking {
		val board = BoardManager(storeStub())
		board.applySnapshot(
			"gw-route",
			listOf(
				entry("a", sessionId = "s1", state = "open"),
				entry("b", sessionId = "s1", state = "in_progress"),
				entry("c", sessionId = "s1", state = "done"),
				entry("gone", sessionId = "s1", state = "open", trashedAt = 5L),
			),
			null,
			false,
		)
		assertEquals(2, board.undoneCount("gw-route", "s1"))

		val writer = RecordingWriter()
		assertTrue(board.sendDispositionBeforeForget(writer, "gw-route", "s1", cancelThem = true))
		assertEquals(
			listOf<ConsoleOp>(ConsoleOp.BoardSetState("a", "cancelled"), ConsoleOp.BoardSetState("b", "cancelled")),
			writer.sent,
		)
	}

	@Test
	fun unassigningBeforeForgetReturnsUnfinishedWorkToThePile() = runBlocking {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("a", sessionId = "s1"), entry("d", sessionId = "s1", state = "done")), null, false)

		val writer = RecordingWriter()
		assertTrue(board.sendDispositionBeforeForget(writer, "gw-route", "s1", cancelThem = false))
		assertEquals(listOf<ConsoleOp>(ConsoleOp.BoardSetSession("a", null)), writer.sent)
	}

	@Test
	fun aDispositionThatDidNotLandReportsFailureSoTheForgetCanHold() = runBlocking {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("a", sessionId = "s1")), null, false)

		val writer = RecordingWriter(fail = { error("offline") })
		assertFalse(board.sendDispositionBeforeForget(writer, "gw-route", "s1", cancelThem = true))
	}

	@Test
	fun aRefusedDispositionDoesNotBlockTheForget() = runBlocking {
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("a", sessionId = "s1")), null, false)

		val writer = RecordingWriter(fail = { throw BoardRefused("entry_missing") })
		assertTrue(board.sendDispositionBeforeForget(writer, "gw-route", "s1", cancelThem = true))
	}

	private class RecordingWriter(private val fail: (() -> Unit)? = null) : BoardWriter {
		val sent = mutableListOf<ConsoleOp>()

		override suspend fun boardWrite(op: ConsoleOp, gatewayId: String, opId: String) {
			fail?.invoke()
			sent.add(op)
		}
	}
}
