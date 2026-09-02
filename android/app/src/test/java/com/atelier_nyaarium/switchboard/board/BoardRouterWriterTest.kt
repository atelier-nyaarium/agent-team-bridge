package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardEntryClear
import com.atelier_nyaarium.switchboard.proto.BoardEntrySealed
import com.atelier_nyaarium.switchboard.proto.BoardOp
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.BoardStateAttachment
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import com.atelier_nyaarium.switchboard.proto.BoardWrite
import com.atelier_nyaarium.switchboard.proto.BoardWriteResult
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.wireJson
import java.util.ArrayDeque
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardRouterWriterTest {
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

	private fun board(entry: BoardStoredEntry? = null, revision: Long = 0L) = BoardManager(FakeStore()).also {
		it.applyRouterBoard(revision, entry?.let(::listOf) ?: emptyList())
	}

	private fun writer(
		board: BoardManager,
		results: ArrayDeque<BoardWriteResult>,
		posts: MutableList<JsonObject>,
		signAndPost: (suspend (JsonObject, String) -> JsonElement)? = null,
	) = BoardRouterWriter(
		board,
		signAndPost ?: { body, _ ->
			posts += body
			body
		},
		{ results.removeFirst() },
	)

	private fun postedWrite(posts: List<JsonObject>, index: Int): BoardWrite =
		wireJson.decodeFromJsonElement(BoardWrite.serializer(), posts[index].getValue("write"))

	@Test
	fun appliedResultLandsRevisionAndEntries() = runBlocking {
		val resultEntry = stored("id", title("id", "title"))
		val board = board()
		val posts = mutableListOf<JsonObject>()
		val writer = writer(board, ArrayDeque(listOf(BoardWriteResult("applied", 7L, listOf(resultEntry)))), posts)

		val outcome = writer.write(
			listOf(BoardIntent.Create("id", "title", state = "open", rank = "m")),
			"op",
			sealing(),
		)
		assertEquals(BoardWriteOutcome.Applied, outcome)
		assertEquals(7L, board.routerRevision)
		assertEquals(resultEntry, board.storedById().getValue("id"))
	}

	@Test
	fun conflictRetryMaterializesAgainstTheWinningBoard() = runBlocking {
		val initial = stored("id", title("id", "old"), rank = "a")
		val winner = stored("id", title("id", "winner"), rank = "b")
		val board = board(initial, 1L)
		val posts = mutableListOf<JsonObject>()
		val writer = writer(
			board,
			ArrayDeque(
				listOf(
					BoardWriteResult("conflict", 2L, listOf(winner)),
					BoardWriteResult("applied", 3L, listOf(winner)),
				),
			),
			posts,
		)

		writer.write(listOf(BoardIntent.SetTitle("id", "new")), "op", sealing())

		val retry = postedWrite(posts, 1)
		val retryOp = retry.ops.single() as BoardOp.Upsert
		assertEquals("b", retryOp.rank)
		assertEquals(2L, retry.expectedRevision)
	}

	@Test
	fun refusedResultReturnsReasonAndLandsBoard() = runBlocking {
		val resultEntry = stored("id", title("id", "title"))
		val board = board()
		val posts = mutableListOf<JsonObject>()
		val result = BoardWriteResult("refused", 4L, listOf(resultEntry), refusal = "not owner")
		val writer = writer(board, ArrayDeque(listOf(result)), posts)

		val outcome = writer.write(
			listOf(BoardIntent.Create("id", "title", state = "open", rank = "m")),
			"op",
			sealing(),
		)
		assertEquals(BoardWriteOutcome.Refused("not owner"), outcome)
		assertEquals(4L, board.routerRevision)
		assertEquals(resultEntry, board.storedById().getValue("id"))
	}

	@Test
	fun fourConflictsExhaustAfterFourPosts() = runBlocking {
		val board = board()
		val posts = mutableListOf<JsonObject>()
		val results = ArrayDeque((1L..4L).map { BoardWriteResult("conflict", it, emptyList()) })
		val writer = writer(board, results, posts)
		val intent = BoardIntent.Create("id", "title", state = "open", rank = "m")

		assertEquals(BoardWriteOutcome.Exhausted, writer.write(listOf(intent), "op", sealing()))
		assertEquals(4, posts.size)
	}

	@Test
	fun signAndPostFailureReturnsUnreachableWithoutChangingRevision() = runBlocking {
		val board = board(stored("id", title("id", "title")), 5L)
		val posts = mutableListOf<JsonObject>()
		val writer = writer(
			board,
			ArrayDeque<BoardWriteResult>(),
			posts,
		) { _, _ -> error("offline") }

		val outcome = writer.write(listOf(BoardIntent.SetTitle("id", "new")), "op", sealing())
		assertTrue(outcome is BoardWriteOutcome.Unreachable)
		assertEquals(5L, board.routerRevision)
	}

	@Test
	fun missingEditReturnsEmptyWithoutPosting() = runBlocking {
		val board = board()
		val posts = mutableListOf<JsonObject>()
		val writer = writer(board, ArrayDeque<BoardWriteResult>(), posts)

		val outcome = writer.write(listOf(BoardIntent.SetTitle("missing", "title")), "op", sealing())
		assertEquals(BoardWriteOutcome.Empty, outcome)
		assertTrue(posts.isEmpty())
	}
}
