package com.atelier_nyaarium.switchboard.plugins.designer

import com.atelier_nyaarium.switchboard.Message
import com.atelier_nyaarium.switchboard.MessageFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the card-index derivation: an attachment is a card only when it is HTML leading with the
 * `@dsCard` marker, identity is the filename with update-in-place on a re-push, and the index is
 * a pure view over the message list (no persisted second copy to drift).
 */
class DesignerCardsTest {

	private val cardHtml = """
		<!-- @dsCard group="Designer dock" width="400" height="800" -->
		<!DOCTYPE html>
		<html><head><title>Editor form</title></head><body>hi</body></html>
	""".trimIndent()

	// Each message writes its attachments to its own bucket in production (<epoch>-<seq>), so the
	// helper stamps a per-message bucket keyed by `at` - same filename in two messages then has
	// distinct srcs, exactly as on-device, which is what lets versions accumulate.
	private fun msg(at: Long, vararg files: MessageFile) =
		Message(
			fromMe = false,
			text = "",
			at = at,
			// Preserve an intentionally-null src (a metadata-only attachment); only bucket real ones.
			files = files.map {
				if (it.src == null) it else it.copy(src = "https://appassets.androidplatform.net/attachments/$at-1/${it.name}")
			},
		)

	private fun html(name: String, src: String = "https://appassets.androidplatform.net/attachments/1-1/$name") =
		MessageFile(name, "text/html", src)

	@Test
	fun markerParsesGroupAndViewport() {
		val meta = parseDsCardMarker(cardHtml)!!
		assertEquals("Designer dock", meta.group)
		assertEquals(400, meta.width)
		assertEquals(800, meta.height)
	}

	@Test
	fun markerMustLeadTheFile() {
		assertNull(parseDsCardMarker("<!DOCTYPE html>\n<!-- @dsCard group=\"x\" -->"))
		assertNull(parseDsCardMarker("plain text, no marker"))
	}

	@Test
	fun markerSurvivesAPrefixTruncation() {
		// The chip opener reads only the first ~2 KB to decide (the marker leads the file), so a
		// truncated prefix of a large card must still be detected as a card.
		val large = cardHtml + "\n" + "<div>x</div>".repeat(5000)
		assertEquals("Designer dock", parseDsCardMarker(large.take(2048))!!.group)
	}

	@Test
	fun attributelessMarkerIsStillACard() {
		val meta = parseDsCardMarker("<!-- @dsCard -->\n<html></html>")
		assertEquals(DsCardMeta(), meta)
	}

	@Test
	fun titleNamesTheCardElseFilenameStem() {
		val cards = designerCards(
			listOf(
				msg(
					1000,
					html("editor-form.html"),
					html("untitled.html", src = "https://appassets.androidplatform.net/attachments/1-1/untitled.html"),
				),
			),
		) { src -> if (src.endsWith("untitled.html")) "<!-- @dsCard -->\n<html></html>" else cardHtml }
		assertEquals(listOf("Editor form", "untitled"), cards.map { it.name })
	}

	@Test
	fun rePushWithTheSameFilenameUpdatesInPlace() {
		val cards = designerCards(
			listOf(
				msg(1000, html("a.html")),
				msg(2000, html("b.html")),
				msg(3000, html("a.html")),
			),
		) { cardHtml }
		// "a" keeps its first position but carries the newest timestamp.
		assertEquals(listOf("a.html", "b.html"), cards.map { it.fileName })
		assertEquals(3000, cards.first { it.fileName == "a.html" }.updatedAt)
	}

	@Test
	fun nonHtmlAndMarkerlessAndUnreadableAttachmentsAreNotCards() {
		val cards = designerCards(
			listOf(
				msg(
					1000,
					MessageFile("photo.png", "image/png", "https://appassets.androidplatform.net/attachments/1-1/photo.png"),
					html("plain.html"),
					html("gone.html"),
					MessageFile("meta-only.html", "text/html", null),
				),
			),
		) { src ->
			when {
				src.endsWith("plain.html") -> "<html>no marker</html>"
				src.endsWith("gone.html") -> null
				else -> cardHtml
			}
		}
		assertTrue(cards.isEmpty())
	}

	@Test
	fun peerMirrorRowsAreExcluded() {
		// A card the human's own agent pushed to THIS thread.
		val own = msg(1000, html("editor-form.html"))
		// A same-filename card riding a mirrored agent-to-agent exchange (from/to are other
		// parties). It must NOT seed or overwrite the human's card - the dock shows only this
		// conversation's own channel.
		val peer = Message(
			fromMe = false,
			text = "",
			at = 2000,
			files = listOf(html("editor-form.html")),
			from = "other.gw.agent.main",
			to = "third.gw.party.main",
			isPeer = true,
		)
		val cards = designerCards(listOf(own, peer)) { cardHtml }
		assertEquals(1, cards.size)
		// Still the human's original card, untouched by the later peer row.
		assertEquals(1000, cards.single().updatedAt)
	}

	@Test
	fun aPeerOnlyThreadHasNoCards() {
		val peer = Message(fromMe = false, text = "", at = 1000, files = listOf(html("a.html")), isPeer = true)
		assertTrue(designerCards(listOf(peer)) { cardHtml }.isEmpty())
	}

	@Test
	fun sameFilenameAccumulatesVersionsNewestLast() {
		val cards = designerCards(
			listOf(msg(1000, html("editor-form.html")), msg(2000, html("editor-form.html")), msg(3000, html("editor-form.html"))),
		) { cardHtml }
		val card = cards.single()
		assertEquals(3, card.versions.size)
		assertEquals(listOf(1000L, 2000L, 3000L), card.versions.map { it.at })
		assertEquals(3000L, card.latest.at)
		assertEquals(3000L, card.updatedAt)
	}

	@Test
	fun deleteHidesTheCardUntilAStrictlyNewerPush() {
		val history = listOf(msg(1000, html("a.html")), msg(2000, html("a.html")))
		// Dismissed at the newest-version marker (2000): the card is hidden.
		val dismissed = mapOf("a.html" to 2000L)
		assertTrue(designerCards(history, dismissed) { cardHtml }.isEmpty())

		// A strictly-newer push (3000 > 2000) resurfaces it, carrying full history.
		val withNewer = history + msg(3000, html("a.html"))
		val card = designerCards(withNewer, dismissed) { cardHtml }.single()
		assertEquals(3, card.versions.size)
		assertEquals(3000L, card.updatedAt)
	}

	@Test
	fun deleteWithNoNewerPushStaysHiddenEvenAtEqualMarker() {
		// Guards the boundary: latest.at == tombstone must remain hidden (<= comparison).
		val cards = designerCards(listOf(msg(5000, html("a.html"))), mapOf("a.html" to 5000L)) { cardHtml }
		assertTrue(cards.isEmpty())
	}

	@Test
	fun aDismissedFilenameDoesNotHideADifferentCard() {
		val cards = designerCards(
			listOf(msg(1000, html("a.html")), msg(1000, html("b.html"))),
			mapOf("a.html" to 2000L),
		) { cardHtml }
		assertEquals(listOf("b.html"), cards.map { it.fileName })
	}

	@Test
	fun theRealMockupCorpusDerives() {
		// The exact leading bytes of the shipped design-pass payload (temp/switchboard-designer-dock/).
		val real = "<!-- @dsCard group=\"Designer dock\" -->\n<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n" +
			"<title>1 - Chat with the Designer dock docked</title></head><body></body></html>"
		val cards = designerCards(listOf(msg(1000, html("dock-collapsed.html")))) { real }
		assertEquals(1, cards.size)
		assertEquals("1 - Chat with the Designer dock docked", cards.single().name)
		assertEquals("Designer dock", cards.single().meta.group)
	}
}
