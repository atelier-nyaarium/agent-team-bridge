package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardEntryClear
import com.atelier_nyaarium.switchboard.proto.BoardEntrySealed
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
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
