package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.PhoneAmbient
import com.atelier_nyaarium.switchboard.PhoneBootstrap
import com.atelier_nyaarium.switchboard.testAmbient
import com.atelier_nyaarium.switchboard.testBootstrap
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardEntryClear
import com.atelier_nyaarium.switchboard.proto.BoardEntrySealed
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
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

	private class RecordingSealing(
		boot: PhoneBootstrap,
		ambient: PhoneAmbient,
	) : BoardSealing(boot, ambient, {}) {
		var openCount = 0
		val openThreads = mutableListOf<String>()

		override fun open(env: ContentEnvelope, kind: String, entryId: String): String? {
			openCount++
			openThreads += Thread.currentThread().name
			return super.open(env, kind, entryId)
		}
	}

	private fun stored(entry: BoardEntry, sealing: BoardSealing) = BoardStoredEntry(
		clear = BoardEntryClear(
			id = entry.id,
			state = entry.state,
			parent = entry.parent,
			rank = entry.rank,
			session = entry.sessionId?.let { BoardSession("domain", "gw-route", it) },
			trashedAt = entry.trashedAt,
			version = 1L,
		),
		sealed = BoardEntrySealed(sealing.seal(entry.title, BOARD_KIND_TITLE, entry.id)!!),
	)

	private fun sealing(identity: Crypto.Identity, keyring: ContentKeyring): RecordingSealing =
		RecordingSealing(testBootstrap(domainId = "domain", owner = identity, contentKeyring = keyring), testAmbient())

	private fun seedRouter(board: BoardManager, entries: List<BoardEntry>) {
		val keyring = ContentKeyring(store = null)
		keyring.deriveOwned(Crypto.generateIdentity(), "domain", 1)
		val sealing = BoardSealing(
			testBootstrap(domainId = "domain", contentKeyring = keyring),
			testAmbient(),
		) {}
		board.sealing = { sealing }
		board.applyRouterBoard(1L, entries.map { stored(it, sealing) })
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

	@Test
	fun backgroundApplyMemoizesRenderingForSynchronousReaders() {
		val identity = Crypto.generateIdentity()
		val keyring = ContentKeyring(store = null).also { it.deriveOwned(identity, "domain", 1) }
		val sealing = sealing(identity, keyring)
		val board = BoardManager(storeStub()).also { it.sealing = { sealing } }
		val entries = listOf(stored(entry("one", "team"), sealing), stored(entry("two", "team"), sealing))
		val before = sealing.openCount
		Thread { board.applyRouterBoard(1L, entries) }.apply { start(); join() }
		val afterApply = sealing.openCount

		repeat(3) {
			assertEquals(listOf("t-one", "t-two"), board.routerEntries().map { it.title })
			assertEquals("t-one", board.liveLine("team")?.title)
			assertEquals(2, board.undoneCount("team"))
		}

		assertTrue(afterApply > before)
		assertEquals(afterApply, sealing.openCount)
		assertTrue(sealing.openThreads.none { it == Thread.currentThread().name })
	}

	@Test
	fun newlyAvailableEpochRebuildsTheMemo() {
		val identity = Crypto.generateIdentity()
		val epochTwoKeyring = ContentKeyring(store = null).also { it.deriveOwned(identity, "domain", 2) }
		val epochTwoSealing = sealing(identity, epochTwoKeyring)
		val keyring = ContentKeyring(store = null).also { it.deriveOwned(identity, "domain", 1) }
		val sealing = sealing(identity, keyring)
		val board = BoardManager(storeStub()).also { it.sealing = { sealing } }
		board.applyRouterBoard(1L, listOf(stored(entry("one"), epochTwoSealing)))

		assertEquals(BOARD_TEXT_UNAVAILABLE, board.routerEntries().single().title)
		keyring.deriveOwned(identity, "domain", 2)
		val updated = sealing(identity, keyring)
		board.sealing = { updated }

		assertEquals("t-one", board.routerEntries().single().title)
		assertTrue(updated.openCount > 0)
	}

	@Test
	fun liveRenderingPersistsItsCachedTitles() {
		val identity = Crypto.generateIdentity()
		val keyring = ContentKeyring(store = null).also { it.deriveOwned(identity, "domain", 1) }
		val sourceSealing = sealing(identity, keyring)
		val store = FakeStore()
		val board = BoardManager(store).also { it.sealing = { sourceSealing } }
		board.applyRouterBoard(1L, listOf(stored(entry("one"), sourceSealing)))

		val restored = BoardManager(store)
		val emptySealing = sealing(identity, ContentKeyring())
		restored.sealing = { emptySealing }

		assertEquals(listOf("t-one"), restored.routerEntries().map { it.title })
		assertEquals(1, emptySealing.openCount)
	}
}
