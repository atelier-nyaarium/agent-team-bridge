package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.BoardRefused
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardEntryClear
import com.atelier_nyaarium.switchboard.proto.BoardEntrySealed
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardManagerTest {
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

	private fun seedRouter(board: BoardManager, entries: List<BoardEntry>) {
		val keyring = ContentKeyring(store = null)
		keyring.deriveOwned(Crypto.generateIdentity(), "domain", 1)
		val sealing = BoardSealing(keyring, "domain", "owner")
		board.sealing = { sealing }
		board.applyRouterBoard(
			1L,
			entries.map { e ->
				BoardStoredEntry(
					clear = BoardEntryClear(
						id = e.id,
						state = e.state,
						parent = e.parent,
						rank = e.rank,
						session = e.sessionId?.let { BoardSession("domain", "gw-route", it) },
						trashedAt = e.trashedAt,
						version = 1L,
					),
					sealed = BoardEntrySealed(title = sealing.seal(e.title, BOARD_KIND_TITLE, e.id)!!),
				)
			},
		)
	}

	@Test
	fun anEditIsVisibleImmediatelyAndSurvivesAStaleSnapshot() {
		val board = BoardManager(storeStub())
		seedRouter(board, listOf(entry("a")))

		board.enqueue(ConsoleOp.BoardSetState("a", "done"), "gw-route")
		assertEquals("done", board.mergedEntries("gw-route").single().state)

		board.applyRouterBoard(board.routerRevision, board.snapshot().stored)
		assertEquals("done", board.mergedEntries("gw-route").single().state)
	}

	@Test
	fun theLiveLinePicksInProgressFirstAndCountsFinished() {
		val board = BoardManager(storeStub())
		seedRouter(
			board,
			listOf(
				entry("done1", sessionId = "s1", state = "done"),
				entry("open1", sessionId = "s1", state = "open"),
				entry("busy", sessionId = "s1", state = "in_progress"),
				entry("theirs", sessionId = "s2"),
			),
		)
		val line = board.liveLine("s1")!!
		assertEquals("t-busy", line.title)
		assertEquals("in_progress", line.state)
		assertEquals(1, line.finished)
		assertEquals(3, line.total)
		assertNull(board.liveLine("nobody"))
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
		board.applySnapshot("gw-route", listOf(entry("a", state = "done"), entry("b", state = "done")), null, false)
		assertTrue(board.mergedEntries("gw-route").all { it.state == "done" })
	}

	@Test
	fun aTransportFailureKeepsTheEditQueuedForALaterDrain() = runBlocking {
		val board = BoardManager(storeStub())
		seedRouter(board, listOf(entry("a")))
		board.enqueue(ConsoleOp.BoardSetState("a", "done"), "gw-route")

		board.drain(RecordingWriter(fail = { error("offline") }))
		assertEquals("done", board.mergedEntries("gw-route").single().state)
		val retry = RecordingWriter()
		board.drain(retry)
		assertEquals(listOf<ConsoleOp>(ConsoleOp.BoardSetState("a", "done")), retry.sent)
	}

	@Test
	fun aRefusedActionIsRetiredAndTheRowRevertsWithAMarker() = runBlocking {
		val board = BoardManager(storeStub())
		seedRouter(board, listOf(entry("a")))
		board.enqueue(ConsoleOp.BoardSetState("a", "done"), "gw-route")

		board.drain(RecordingWriter(fail = { throw BoardRefused("entry_missing") }))
		assertEquals("open", board.mergedEntries("gw-route").single().state)
		assertEquals(listOf("entry_missing"), board.refusals.map { it.reason })
	}

	@Test
	fun forgettingASessionDropsItsQueuedEditsSoNoneCanOutliveTheDisposition() = runBlocking {
		val board = BoardManager(storeStub())
		seedRouter(board, listOf(entry("mine", sessionId = "s1"), entry("theirs", sessionId = "s2")))
		board.enqueue(ConsoleOp.BoardSetState("mine", "in_progress"), "gw-route")
		board.enqueue(ConsoleOp.BoardSetState("theirs", "in_progress"), "gw-route")

		assertEquals(1, board.dropQueuedForSession("gw-route", "s1"))

		val writer = RecordingWriter()
		board.drain(writer)
		assertEquals(listOf<ConsoleOp>(ConsoleOp.BoardSetState("theirs", "in_progress")), writer.sent)
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
		val manager = BoardManager(storeStub())
		manager.enqueue(ConsoleOp.BoardSetAttachments("e1", emptyList()), "gw-route")

		manager.drain(RecordingWriter(dropped = listOf("gone.png")))

		assertEquals(1, manager.refusals.size)
		assertTrue(manager.refusals.single().reason.contains("gone.png"))
		// Applied writes retire.
		assertTrue(manager.strugglingEntries().isEmpty())
	}

	// Unlanded boards have no keep set.
	@Test
	fun aBoardNeverLandedFromTheRouterIsNotKnown() {
		val manager = BoardManager(storeStub())

		assertFalse("no Router revision means no keep set", manager.boardIsKnown)

		seedRouter(manager, listOf(entry("a1")))
		assertTrue("a landed board is known", manager.boardIsKnown)
		val keep = manager.attachmentBuckets()
		assertTrue("a landed board answers its keep set", keep != null && keep.isNotEmpty())
	}

	@Test
	fun anUndecodableBoardIsNotAnEmptyOne() {
		// Decode failure must not prune.
		assertFalse("a stored board that will not parse is UNKNOWN", BoardManager(FakeStore("{not json")).boardIsKnown)
	}

	@Test
	fun anEmptyKeyringPrunesNothing() {
		val board = BoardManager(storeStub())
		board.retainGateways(emptyList())
		assertNull(board.attachmentBuckets())
	}

	@Test
	fun aPreviousBlobWithGatewayColumnsLoadsRouterEntriesWithoutGatewayState() {
		val oldBlob = """
			{"gateways":{"old-gateway":{"entries":[]}},"routerRevision":7,"stored":[{"clear":{"id":"old-entry","state":"open","rank":"m","version":1},"sealed":{"title":{"v":1,"epoch":1,"nonce":"","ciphertext":""}}}]}
		""".trimIndent()
		val board = BoardManager(FakeStore(oldBlob))

		assertEquals(7L, board.snapshot().routerRevision)
		assertEquals(listOf("old-entry"), board.snapshot().stored.map { it.clear.id })
		assertFalse(Json.encodeToString(BoardBlob.serializer(), board.snapshot()).contains("\"gateways\""))
	}
}
