package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.BoardRefused
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardAttachment
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

	/** Seeds the Router board, which is what the session-scoped reads answer from. */
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
					sealed = BoardEntrySealed(title = sealing.seal(e.title, BOARD_KIND_TITLE)!!),
				)
			},
		)
	}

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
		board.enqueueMove(subtree, fromGateway = "gw-route", toGateway = "gw-b") { e, b -> "/tmp/$e/$b" }

		// Optimistically the entry has already moved: gone from the origin, present at the
		// destination with the SAME ids, so the union renders it exactly once.
		assertTrue(board.mergedEntries("gw-route").isEmpty())
		assertEquals(listOf("m1", "kid"), board.mergedEntries("gw-b").map { it.id })
		assertTrue(board.mergedEntries("gw-b").all { it.sessionId == "sess-b" })
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
		board.enqueueMove(subtree, fromGateway = "gw-a", toGateway = "gw-b") { e, b -> "/tmp/$e/$b" }

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
	fun aMoveCarriesItsBytesAndDeletesTheOriginLast() {
		// The origin entry stops existing when the delete lands, so the destination has to hold the
		// bytes by then or the picture is reachable from nowhere.
		val picture = BoardAttachment("sha256-${"a".repeat(64)}", "gw-a", "shot.png", "image/png", 3)
		val board = BoardManager(storeStub())
		val subtree = listOf(entry("m1").copy(attachments = listOf(picture)))

		board.enqueueMove(subtree, fromGateway = "gw-a", toGateway = "gw-b") { e, b -> "/tmp/$e/$b" }

		val queue = board.queuedActions
		assertEquals(3, queue.size)
		assertTrue("the upsert goes first", queue[0].op is ConsoleOp.BoardUpsert)
		assertTrue("then the destination's own attachment write", queue[1].op is ConsoleOp.BoardSetAttachments)
		assertTrue("and the origin delete is last", queue[2].op is ConsoleOp.BoardRemove)
		// Chained, so the delete cannot drain before the bytes have landed.
		assertEquals(queue[0].opId, queue[1].dependsOn)
		assertEquals(queue[1].opId, queue[2].dependsOn)
		// It knows where to PULL a picture this device never opened: the ORIGIN still holds it.
		assertEquals("gw-a", queue[1].fetchFrom[picture.blobId])
		// And the record it writes names the DESTINATION, which is where the bytes are going. These
		// two gateway ids sit one line apart and swapping them compiles, so both are pinned.
		val written = (queue[1].op as ConsoleOp.BoardSetAttachments).attachments.single()
		assertEquals("gw-b", written.blobGateway)
		assertEquals(picture.blobId, written.blobId)
	}

	@Test
	fun pendingFetchesAnswersEntryThenBlobThenHolder() {
		// The consumer indexes this tuple positionally and every element is a String, so a reordering
		// compiles and silently turns its lookup into a constant false - the shape that lets a caller
		// keep reading the first element after a new one is prepended and start comparing the wrong
		// field.
		val picture = BoardAttachment("sha256-${"a".repeat(64)}", "gw-a", "shot.png", "image/png", 3)
		val board = BoardManager(storeStub())

		board.enqueueMove(listOf(entry("m1").copy(attachments = listOf(picture))), "gw-a", "gw-b") { e, b ->
			"/tmp/$e/$b"
		}

		val (entryId, blobId, holder) = board.pendingFetches().single()
		assertEquals("m1", entryId)
		assertEquals(picture.blobId, blobId)
		assertEquals("gw-a", holder)
	}

	@Test
	fun aMoveChainsOnlyTheEntriesThatHaveAttachments() {
		// The chain threads through a subtree where most entries carry nothing, and a broken link is
		// what lets the origin delete overtake an attachment write.
		val picture = BoardAttachment("sha256-${"a".repeat(64)}", "gw-a", "shot.png", "image/png", 3)
		val board = BoardManager(storeStub())
		val subtree = listOf(entry("m1"), entry("m2").copy(attachments = listOf(picture)), entry("m3"))

		board.enqueueMove(subtree, fromGateway = "gw-a", toGateway = "gw-b") { e, b -> "/tmp/$e/$b" }

		val queue = board.queuedActions
		assertEquals("one upsert, one attachment write, one delete", 3, queue.size)
		assertEquals("m2", (queue[1].op as ConsoleOp.BoardSetAttachments).id)
		assertEquals(queue[1].opId, queue[2].dependsOn)
	}

	@Test
	fun aMoveWithNoAttachmentsLinksTheDeleteStraightToTheUpsert() {
		val board = BoardManager(storeStub())

		board.enqueueMove(listOf(entry("m1")), fromGateway = "gw-a", toGateway = "gw-b") { e, b -> "/tmp/$e/$b" }

		val queue = board.queuedActions
		assertEquals(2, queue.size)
		assertEquals(queue[0].opId, queue[1].dependsOn)
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

	@Test
	fun aRevokedGatewaysColumnAndItsQueuedWritesGoWithIt() {
		// A purged machine is wiped and gone, but nothing ever takes a column BACK: its last snapshot
		// would be drawn as live work forever and board_read on every refresh. The keyring is the one
		// fact that says gone rather than down, so a Gateway it no longer admits loses its column here.
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("r1")), null, false)
		board.applySnapshot("gw-gone", listOf(entry("g1")), null, false)
		board.applySnapshot("gw-kept", listOf(entry("k1")), null, false)
		board.enqueue(ConsoleOp.BoardSetState("g1", "done"), "gw-gone")
		val keptOp = board.enqueue(ConsoleOp.BoardSetState("k1", "done"), "gw-kept")

		board.retainGateways(listOf("gw-route", "gw-kept"))

		assertEquals(setOf("gw-route", "gw-kept"), board.sourceGatewayIds().toSet())
		assertTrue("the revoked column is gone", board.mergedEntries("gw-gone").isEmpty())
		assertEquals("the kept column is untouched", listOf("k1"), board.mergedEntries("gw-kept").map { it.id })
		assertEquals("only the kept write survives", listOf(keptOp), board.queuedActions.map { it.opId })
	}

	@Test
	fun aRevokedMoveDestinationTakesTheOriginDeleteWithIt() {
		// The delete half of a move waits on its write half. Dropping the write because its Gateway was
		// revoked must drop the delete too, or the delete becomes eligible and the entry exists nowhere -
		// the same inversion abandonBoardAction exists to prevent for a refusal.
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-route", listOf(entry("m1")), null, false)
		board.enqueueMove(board.mergedEntries("gw-route"), fromGateway = "gw-route", toGateway = "gw-gone") { e, b -> "/tmp/$e/$b" }
		assertEquals(2, board.queuedActions.size)

		board.retainGateways(listOf("gw-route"))

		assertTrue("the linked origin delete went with the destination write", board.queuedActions.isEmpty())
		assertEquals("the entry is back on its origin", listOf("m1"), board.mergedEntries("gw-route").map { it.id })
	}

	@Test
	fun anEmptyKeyringPrunesNothing() {
		// What a device knows before its first sync. An empty answer is never permission to delete.
		val board = BoardManager(storeStub())
		board.applySnapshot("gw-a", listOf(entry("a1")), null, false)
		board.retainGateways(emptyList())
		assertEquals(listOf("a1"), board.mergedEntries("gw-a").map { it.id })
	}
}
