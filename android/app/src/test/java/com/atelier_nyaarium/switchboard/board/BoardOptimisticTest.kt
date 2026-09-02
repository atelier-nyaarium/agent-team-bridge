package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardEntryClear
import com.atelier_nyaarium.switchboard.proto.BoardEntrySealed
import com.atelier_nyaarium.switchboard.proto.BoardOp
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.BoardStateAttachment
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import com.atelier_nyaarium.switchboard.proto.BoardWriteResult
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import java.util.ArrayDeque
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardOptimisticTest {
	private class FakeStore(private var blob: String? = null) : BoardStore {
		override fun loadTaskBoard(): String? = blob

		override fun saveTaskBoard(json: String) {
			blob = json
		}

		override fun loadGatewayId(): String = "gw-route"
	}

	private val owner = Crypto.generateIdentity()
	private val domainId = "domain"
	private val keyring = ContentKeyring().also { it.deriveOwned(owner, domainId, 1) }

	private fun sealing(ring: ContentKeyring = keyring) = BoardSealing(ring, domainId, owner.sign.pub)

	private fun title(entryId: String, text: String, ring: ContentKeyring = keyring) =
		checkNotNull(sealing(ring).seal(text, BOARD_KIND_TITLE, entryId))

	private fun stored(
		id: String,
		title: ContentEnvelope,
		body: ContentEnvelope? = null,
		state: String = "open",
		parent: String? = null,
		rank: String = "m",
		session: BoardSession? = null,
		trashedAt: Long? = null,
		attachments: List<BoardStateAttachment>? = null,
	) = BoardStoredEntry(
		clear = BoardEntryClear(id, state, parent, rank, session, trashedAt, attachments, 1L),
		sealed = BoardEntrySealed(title, body),
	)

	private fun entry(
		id: String,
		title: String = "title-$id",
		body: String? = "body-$id",
		state: String = "open",
		parent: String? = null,
		rank: String = "m",
		session: BoardSession? = null,
		trashedAt: Long? = null,
	) = BoardEntry(id, title, body, state, parent, rank, session?.sessionId, session, trashedAt)

	private fun board(entry: BoardStoredEntry? = null, revision: Long = 0L) = BoardManager(FakeStore()).also {
		it.applyRouterBoard(revision, entry?.let(::listOf) ?: emptyList())
	}

	private fun writer(
		board: BoardManager,
		results: ArrayDeque<BoardWriteResult> = ArrayDeque(),
		posts: MutableList<String> = mutableListOf(),
		signAndPost: (suspend (JsonObject, String) -> JsonElement)? = null,
	) = BoardRouterWriter(
		board,
		signAndPost ?: { body, opId ->
			posts += opId
			body
		},
		{ results.removeFirst() },
	)

	@Test
	fun createSynthesizesMissingRouterEntry() {
		val session = BoardSession(domainId, "gateway", "session")
		val intent = BoardIntent.Create("id", "title", "body", "done", "parent", "rank", session)

		assertEquals(
			listOf(entry("id", "title", "body", "done", "parent", "rank", session)),
			applyPending(emptyList(), listOf(PendingWrite("op", listOf(intent)))),
		)
	}

	@Test
	fun createDoesNotOverwriteExistingRouterEntry() {
		val routerEntry = entry("id", "router title")
		val intent = BoardIntent.Create("id", "new title", state = "done", rank = "z")

		assertEquals(listOf(routerEntry), applyPending(listOf(routerEntry), listOf(PendingWrite("op", listOf(intent)))))
	}

	@Test
	fun editsApplyToExistingRouterEntry() {
		val session = BoardSession(domainId, "gateway", "new-session")
		val original = entry("id", session = BoardSession(domainId, "gateway", "old-session"), rank = "a")

		assertEquals(
			"new title",
			applyPending(listOf(original), pending(BoardIntent.SetTitle("id", "new title"))).single().title,
		)
		assertEquals("new body", applyPending(listOf(original), pending(BoardIntent.SetBody("id", "new body"))).single().body)
		assertEquals("done", applyPending(listOf(original), pending(BoardIntent.SetState("id", "done"))).single().state)
		assertEquals(
			original.copy(parent = "parent", rank = "b"),
			applyPending(listOf(original), pending(BoardIntent.SetParent("id", "parent", "b"))).single(),
		)
		assertEquals("z", applyPending(listOf(original), pending(BoardIntent.SetRank("id", "z"))).single().rank)
		assertEquals(session, applyPending(listOf(original), pending(BoardIntent.SetSession("id", session))).single().session)
		assertEquals(1L, applyPending(listOf(original), pending(BoardIntent.Trash("id"))).single().trashedAt)
		assertNull(applyPending(listOf(original.copy(trashedAt = 5L)), pending(BoardIntent.Restore("id"))).single().trashedAt)
		assertTrue(applyPending(listOf(original), pending(BoardIntent.Remove("id"))).isEmpty())
	}

	@Test
	fun missingNonCreateIntentIsDropped() {
		val pending = listOf(PendingWrite("op", listOf(BoardIntent.SetState("missing", "done"))))

		assertTrue(applyPending(emptyList(), pending).isEmpty())
	}

	@Test
	fun laterPendingWriteWinsForTheSameEntry() {
		val writes = listOf(
			PendingWrite("first", listOf(BoardIntent.SetTitle("id", "first"))),
			PendingWrite("second", listOf(BoardIntent.SetTitle("id", "second"))),
		)

		assertEquals("second", applyPending(listOf(entry("id")), writes).single().title)
	}

	@Test
	fun routerOrderIsPreservedAndCreatedEntryIsAppended() {
		val router = listOf(entry("a"), entry("b"))
		val create = BoardIntent.Create("c", "created", state = "open", rank = "z")

		assertEquals(listOf("a", "b", "c"), applyPending(router, listOf(PendingWrite("op", listOf(create)))).map { it.id })
	}

	@Test
	fun enqueueWriteReturnsQueuedWriteWithNoAttempts() {
		val board = board()
		val intents = listOf(BoardIntent.Create("id", "title", state = "open", rank = "m"))

		assertEquals("op", board.enqueueWrite(intents, "op"))
		assertEquals(listOf(PendingWrite("op", intents)), board.pendingWrites())
	}

	@Test
	fun settleWriteLandsBoardAndRetiresOnlyItsWrite() {
		val board = board()
		board.enqueueWrite(emptyList(), "first")
		board.enqueueWrite(emptyList(), "second")
		val result = stored("id", title("id", "title"))

		board.settleWrite("first", 8L, listOf(result))

		assertEquals(8L, board.routerRevision)
		assertEquals(result, board.storedById().getValue("id"))
		assertEquals(listOf(PendingWrite("second", emptyList())), board.pendingWrites())
	}

	@Test
	fun lowerSettlementRevisionDoesNotMoveBoardBackwards() {
		val original = stored("id", title("id", "original"))
		val board = board(original, 5L)
		board.enqueueWrite(emptyList(), "op")
		val older = stored("id", title("id", "older"))

		board.settleWrite("op", 4L, listOf(older))

		assertEquals(5L, board.routerRevision)
		assertEquals(original, board.storedById().getValue("id"))
		assertTrue(board.pendingWrites().isEmpty())
	}

	@Test
	fun failWriteIncrementsAttemptsWithoutDroppingWrite() {
		val board = board()
		board.enqueueWrite(emptyList(), "op")

		board.failWrite("op")

		assertEquals(PendingWrite("op", emptyList(), 1), board.pendingWrites().single())
	}

	@Test
	fun drainSendsOldestFirstAndStopsAtUnreachableWrite() = runBlocking {
		val board = board()
		board.enqueueWrite(listOf(BoardIntent.Create("one", "one", state = "open", rank = "a")), "one")
		board.enqueueWrite(listOf(BoardIntent.Create("two", "two", state = "open", rank = "b")), "two")
		board.enqueueWrite(listOf(BoardIntent.Create("three", "three", state = "open", rank = "c")), "three")
		val posts = mutableListOf<String>()
		val writer = writer(board, ArrayDeque(listOf(BoardWriteResult("applied", 1L, emptyList()))), posts) { _, opId ->
			posts += opId
			if (opId == "two") error("offline")
			JsonObject(emptyMap())
		}

		assertEquals(1, writer.drain(sealing()))
		assertEquals(listOf("one", "two"), posts)
		assertEquals(listOf("two", "three"), board.pendingWrites().map { it.opId })
		assertEquals(1, board.pendingWrites().first().attempts)
	}

	@Test
	fun drainRetiresEmptyWriteWithoutPosting() = runBlocking {
		val board = board()
		board.enqueueWrite(listOf(BoardIntent.SetTitle("missing", "title")), "op")
		val posts = mutableListOf<String>()
		val writer = writer(board, posts = posts) { _, _ -> error("must not post") }

		assertEquals(1, writer.drain(sealing()))
		assertTrue(board.pendingWrites().isEmpty())
		assertTrue(posts.isEmpty())
	}

	// Assigning a parent takes its children with it, which is what the gateway op this replaced did.
	// The Router sets one entry per set_session, so the subtree has to be fanned out by the caller and
	// ride one write.
	@Test
	fun assigningAParentCarriesItsSubtree() {
		val target = BoardSession("domain", "gw-b", "sess-b")
		val entries = listOf(entry("root"), entry("kid", parent = "root"), entry("other"))
		val write = PendingWrite(
			"op",
			listOf(BoardIntent.SetSession("root", target), BoardIntent.SetSession("kid", target)),
		)

		val applied = applyPending(entries, listOf(write)).associateBy { it.id }

		assertEquals(target, applied["root"]?.session)
		assertEquals(target, applied["kid"]?.session)
		assertEquals(null, applied["other"]?.session)
	}

	private fun pending(intent: BoardIntent) = listOf(PendingWrite("op", listOf(intent)))
}
