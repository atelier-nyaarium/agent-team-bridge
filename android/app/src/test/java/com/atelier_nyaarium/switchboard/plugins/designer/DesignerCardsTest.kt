package com.atelier_nyaarium.switchboard.plugins.designer

import com.atelier_nyaarium.switchboard.MessageFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins card detection for the additive store: [parseDsCardMarker] accepts only HTML that LEADS with
 * the `@dsCard` marker, and [cardsFrom] turns ONE message's attachments into stored cards - titling
 * each, skipping non-HTML / markerless / unreadable files, and capping how many it opens. The
 * agent-only (fromMe/isPeer) guard lives in the ingest caller (DesignerPlugin / dock backfill), not
 * here; exactly-once delivery is the pipeline's job, so this store needs no watermark.
 */
class DesignerCardsTest {

	private val cardHtml = """
		<!-- @dsCard group="Designer dock" width="400" height="800" -->
		<!DOCTYPE html>
		<html><head><title>Editor form</title></head><body>hi</body></html>
	""".trimIndent()

	/** An html attachment whose src resolves to the on-device bucket `relOf` strips to `<bucket>/<name>`. */
	private fun html(name: String, bucket: String = "1-1") =
		MessageFile(name, "text/html", "https://appassets.androidplatform.net/attachments/$bucket/$name")

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
		// The ingest read is a bounded prefix, so the marker must still parse off a truncated head.
		val large = cardHtml + "\n" + "<div>x</div>".repeat(5000)
		assertEquals("Designer dock", parseDsCardMarker(large.take(2048))!!.group)
	}

	@Test
	fun cardsFromTitlesEachCardAndStampsTheMessageTime() {
		val card = cardsFrom(listOf(html("editor-form.html")), at = 1700) { cardHtml }.single()
		assertEquals("editor-form.html", card.fileName)
		assertEquals("1-1/editor-form.html", card.rel)
		assertEquals("Editor form", card.title)
		assertEquals("Designer dock", card.group)
		assertEquals(400, card.w)
		assertEquals(800, card.h)
		assertEquals(1700L, card.at)
	}

	@Test
	fun cardsFromSkipsNonHtmlMarkerlessAndUnreadable() {
		val files = listOf(
			MessageFile("photo.png", "image/png", "https://appassets.androidplatform.net/attachments/1-1/photo.png"),
			html("plain.html"),
			html("gone.html"),
			MessageFile("meta-only.html", "text/html", null), // no src: never landed on disk
		)
		val cards = cardsFrom(files, at = 10) { rel ->
			when {
				rel.endsWith("plain.html") -> "<html>no marker</html>"
				rel.endsWith("gone.html") -> null // unreadable / oversize
				else -> cardHtml
			}
		}
		assertTrue(cards.isEmpty())
	}

	@Test
	fun cardsFromReadsAtMostTheFileCap() {
		val files = (1..6).map { html("c$it.html") }
		val cards = cardsFrom(files, at = 0, maxFiles = 2) { cardHtml }
		// Only the first two html attachments are opened; the rest are never read (a burst of files
		// on one message can't run an unbounded read on the drain thread).
		assertEquals(listOf("c1.html", "c2.html"), cards.map { it.fileName })
	}

	@Test
	fun cardsFromTitleFallsBackToTheFilenameStemViaToCard() {
		val noTitle = "<!-- @dsCard group=\"g\" -->\n<html><body>x</body></html>"
		val card = cardsFrom(listOf(html("my-canvas.html")), at = 0) { noTitle }.single()
		assertNull(card.title)
		assertEquals("my-canvas", card.toCard().name)
	}

	@Test
	fun theRealMockupCorpusScans() {
		val real = "<!-- @dsCard group=\"Designer dock\" -->\n<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n" +
			"<title>1 - Chat with the Designer dock docked</title></head><body></body></html>"
		val card = cardsFrom(listOf(html("dock-collapsed.html")), at = 0) { real }.single()
		assertEquals("1 - Chat with the Designer dock docked", card.title)
		assertEquals("Designer dock", card.group)
	}
}
