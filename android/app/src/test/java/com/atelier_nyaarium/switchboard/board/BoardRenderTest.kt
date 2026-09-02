package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.BoardEntryClear
import com.atelier_nyaarium.switchboard.proto.BoardEntrySealed
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardRenderTest {
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
	) = BoardStoredEntry(
		clear = BoardEntryClear(id, state, parent, rank, session, trashedAt, null, 1L),
		sealed = BoardEntrySealed(title, body),
	)

	@Test
	fun sealThenOpenRoundTripsTitle() {
		val envelope = checkNotNull(sealing().seal("title", BOARD_KIND_TITLE))

		assertEquals("title", sealing().open(envelope, BOARD_KIND_TITLE))
	}

	@Test
	fun openingTitleAsBodyReturnsNull() {
		val envelope = checkNotNull(sealing().seal("title", BOARD_KIND_TITLE))

		assertNull(sealing().open(envelope, BOARD_KIND_BODY))
	}

	@Test
	fun openingWithoutEnvelopeEpochReturnsNull() {
		val envelope = checkNotNull(sealing().seal("title", BOARD_KIND_TITLE))

		assertNull(sealing(ContentKeyring()).open(envelope, BOARD_KIND_TITLE))
	}

	@Test
	fun sealWithoutAnEpochReturnsNull() {
		assertNull(sealing(ContentKeyring()).seal("title", BOARD_KIND_TITLE))
	}

	@Test
	fun renderBoardCarriesReadableEntryFields() {
		val session = BoardSession(domainId, "gateway", "session")
		val result = renderBoard(
			listOf(stored("id", title("title"), body("body"), "done", "parent", "rank", session, 42L)),
			sealing(),
			emptyMap(),
		)
		val rendered = result.entries.single()

		assertEquals("id", rendered.id)
		assertEquals("title", rendered.title)
		assertEquals("body", rendered.body)
		assertEquals("done", rendered.state)
		assertEquals("parent", rendered.parent)
		assertEquals("rank", rendered.rank)
		assertEquals(session.sessionId, rendered.sessionId)
		assertEquals(session, rendered.session)
		assertEquals(42L, rendered.trashedAt)
		assertTrue("id" !in result.unavailable)
	}

	@Test
	fun renderBoardUsesCachedTitleForMissingEpoch() {
		val rendered = renderBoard(
			listOf(stored("id", title("title"))),
			sealing(ContentKeyring()),
			mapOf("id" to BoardCachedText("cached")),
		)

		assertEquals("cached", rendered.entries.single().title)
		assertTrue("id" !in rendered.unavailable)
	}

	@Test
	fun renderBoardMarksMissingTitleWithoutCacheUnavailable() {
		val rendered = renderBoard(listOf(stored("id", title("title"))), sealing(ContentKeyring()), emptyMap())

		assertEquals(BOARD_TEXT_UNAVAILABLE, rendered.entries.single().title)
		assertTrue("id" in rendered.unavailable)
	}

	@Test
	fun renderBoardDoesNotResurrectRemovedBody() {
		val rendered = renderBoard(
			listOf(stored("id", title("title"), body = null)),
			sealing(),
			mapOf("id" to BoardCachedText("title", "removed")),
		)

		assertNull(rendered.entries.single().body)
	}

	@Test
	fun renderBoardCacheCarriesForwardRenderedText() {
		val storedEntry = stored("id", title("title"), body("body"))
		val first = renderBoard(listOf(storedEntry), sealing(), emptyMap())
		val second = renderBoard(listOf(storedEntry), sealing(ContentKeyring()), first.cache)

		assertEquals("title", second.entries.single().title)
		assertEquals("body", second.entries.single().body)
	}
}
