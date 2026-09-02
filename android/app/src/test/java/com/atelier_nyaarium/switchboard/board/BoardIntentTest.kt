package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardEntryClear
import com.atelier_nyaarium.switchboard.proto.BoardEntrySealed
import com.atelier_nyaarium.switchboard.proto.BoardOp
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.BoardStateAttachment
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class BoardIntentTest {
	private val owner = Crypto.generateIdentity()
	private val domainId = "domain"
	private val keyring = ContentKeyring().also { it.deriveOwned(owner, domainId, 1) }

	private fun sealing(ring: ContentKeyring = keyring) = BoardSealing(ring, domainId, owner.sign.pub)

	private fun title(text: String, ring: ContentKeyring = keyring) =
		checkNotNull(sealing(ring).seal(text, BOARD_KIND_TITLE))

	private fun body(text: String, ring: ContentKeyring = keyring) =
		checkNotNull(sealing(ring).seal(text, BOARD_KIND_BODY))

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

	private fun upsert(intent: BoardIntent, entry: BoardStoredEntry, ring: ContentKeyring = keyring) =
		checkNotNull(materialize(intent, mapOf(entry.clear.id to entry), sealing(ring))) as BoardOp.Upsert

	@Test
	fun setTitleCopiesClearFieldsAndPassesThroughBody() {
		val session = BoardSession(domainId, "gateway", "session")
		val attachments = listOf(BoardStateAttachment("blob", 4L, "text/plain", "gateway"))
		val entry = stored("id", title("old"), body("old body"), "done", "parent", "rank", session, 42L, attachments)
		val op = upsert(BoardIntent.SetTitle("id", "new"), entry)

		assertEquals(entry.clear.id, op.id)
		assertEquals(entry.clear.state, op.state)
		assertEquals(entry.clear.parent, op.parent)
		assertEquals(entry.clear.rank, op.rank)
		assertEquals(entry.clear.session, op.session)
		assertEquals(entry.clear.trashedAt, op.trashedAt)
		assertEquals(entry.clear.attachments, op.attachments)
		assertNotSame(entry.sealed.title, op.title)
		assertEquals("new", sealing().open(op.title, BOARD_KIND_TITLE))
		assertSame(entry.sealed.body, op.body)
	}

	@Test
	fun setBodyPassesThroughTitleAndSealsOnlyBody() {
		val entry = stored("id", title("old title"), body("old body"))
		val op = upsert(BoardIntent.SetBody("id", "new body"), entry)

		assertSame(entry.sealed.title, op.title)
		assertNotSame(entry.sealed.body, op.body)
		assertEquals("new body", op.body?.let { sealing().open(it, BOARD_KIND_BODY) })
	}

	@Test
	fun setBodyNullRemovesBody() {
		val entry = stored("id", title("title"), body("body"))

		assertNull(upsert(BoardIntent.SetBody("id", null), entry).body)
	}

	@Test
	fun setTitleForMissingEntryReturnsNull() {
		assertNull(materialize(BoardIntent.SetTitle("missing", "title"), emptyMap(), sealing()))
	}

	@Test
	fun createWithoutAnEpochReturnsNull() {
		val intent = BoardIntent.Create("id", "title", state = "open", rank = "m")

		assertNull(materialize(intent, emptyMap(), sealing(ContentKeyring())))
	}

	@Test
	fun createWithAnEpochSealsTitle() {
		val intent = BoardIntent.Create("id", "title", state = "open", rank = "m")
		val op = checkNotNull(materialize(intent, emptyMap(), sealing())) as BoardOp.Upsert

		assertEquals("title", sealing().open(op.title, BOARD_KIND_TITLE))
	}

	@Test
	fun passThroughIntentsBecomeTheirOwnOperations() {
		val session = BoardSession(domainId, "gateway", "session")
		val attachments = listOf(BoardStateAttachment("blob", 4L, "text/plain", "gateway"))
		val stored = emptyMap<String, BoardStoredEntry>()

		assertEquals(BoardOp.SetState("id", "done"), materialize(BoardIntent.SetState("id", "done"), stored, sealing()))
		assertEquals(
			BoardOp.SetParent("id", "parent", "rank"),
			materialize(BoardIntent.SetParent("id", "parent", "rank"), stored, sealing()),
		)
		assertEquals(BoardOp.SetRank("id", "rank"), materialize(BoardIntent.SetRank("id", "rank"), stored, sealing()))
		assertEquals(
			BoardOp.SetSession("id", session),
			materialize(BoardIntent.SetSession("id", session), stored, sealing()),
		)
		assertEquals(
			BoardOp.SetAttachments("id", attachments),
			materialize(BoardIntent.SetAttachments("id", attachments), stored, sealing()),
		)
		assertEquals(BoardOp.Trash("id"), materialize(BoardIntent.Trash("id"), stored, sealing()))
		assertEquals(BoardOp.Restore("id"), materialize(BoardIntent.Restore("id"), stored, sealing()))
		assertEquals(BoardOp.Remove("id"), materialize(BoardIntent.Remove("id"), stored, sealing()))
	}
}
