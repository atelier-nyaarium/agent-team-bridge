package com.atelier_nyaarium.switchboard.plugins.designer

import com.atelier_nyaarium.switchboard.Message
import com.atelier_nyaarium.switchboard.MessageFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pins card ingest and byte resolution. [storedCardFrom] turns ONE wire-declared file into a stored
 * card with no disk read and no dependence on whether the bytes have landed; [resolveCardRel] finds
 * the landed bytes from the live thread rows, content-keyed. [parseDsCardMarker] survives only for
 * the tap-time opener and must still accept only HTML that LEADS with the `@dsCard` marker. The
 * agent-only (fromMe/isPeer) guard lives in the ingest caller (DesignerPlugin), not here.
 */
class DesignerCardsTest {

	private val cardHtml = """
		<!-- @dsCard group="Designer dock" width="400" height="800" -->
		<!DOCTYPE html>
		<html><head><title>Editor form</title></head><body>hi</body></html>
	""".trimIndent()

	private fun wireCard(name: String, src: String? = null, blobId: String? = "sha256-aa") =
		MessageFile(
			name,
			"text/html",
			src,
			blobId = blobId,
			role = "design-card",
			cardTitle = "Editor form",
			cardGroup = "Designer dock",
			cardWidth = 400,
			cardHeight = 800,
		)

	////////////////////////////////
	//  Wire-declared ingest

	@Test
	fun storedCardFromCarriesTheDeclaredFieldsAndTheMessageTime() {
		val card = storedCardFrom(wireCard("editor-form.html"), at = 1700)!!
		assertEquals("editor-form.html", card.fileName)
		assertNull(card.rel)
		assertEquals("Editor form", card.title)
		assertEquals("Designer dock", card.group)
		assertEquals(400, card.w)
		assertEquals(800, card.h)
		assertEquals(1700L, card.at)
		assertEquals("sha256-aa", card.blobId)
	}

	@Test
	fun storedCardFromTakesTheRelWhenTheBytesAlreadyLanded() {
		val landed = wireCard("a.html", src = "https://appassets.androidplatform.net/attachments/1-1/a.html")
		assertEquals("1-1/a.html", storedCardFrom(landed, at = 0)!!.rel)
	}

	@Test
	fun storedCardFromIgnoresEverythingButADeclaredCard() {
		assertNull(storedCardFrom(MessageFile("shot.png", "image/png", role = "attachment"), at = 0))
		assertNull(storedCardFrom(MessageFile("cart.ts", "text/plain", role = "ref-snapshot"), at = 0))
		assertNull(storedCardFrom(MessageFile("page.html", "text/html"), at = 0))
	}

	@Test
	fun aDeclaredCardWithoutATitleFallsBackToTheFilenameStemViaToCard() {
		val card = storedCardFrom(MessageFile("my-canvas.html", "text/html", role = "design-card"), at = 0)!!
		assertNull(card.title)
		assertEquals("my-canvas", card.toCard().name)
	}

	////////////////////////////////
	//  Byte resolution from live rows

	private fun row(at: Long, vararg files: MessageFile) = Message(false, "", at, files = files.toList())

	@Test
	fun resolveCardRelFindsTheLandedBytesByContent() {
		val rows = listOf(
			row(100, MessageFile("a.html", "text/html", null, blobId = "sha256-aa")),
			row(
				200,
				MessageFile(
					"a.html",
					"text/html",
					"https://appassets.androidplatform.net/attachments/2-1/a.html",
					blobId = "sha256-aa",
				),
			),
		)
		val card = StoredCard("a.html", rel = null, at = 200, blobId = "sha256-aa")
		assertEquals("2-1/a.html", resolveCardRel(rows, card))
	}

	@Test
	fun resolveCardRelNeverBorrowsAnOlderRevisionsBytes() {
		// Same filename, different content: the old revision's landed bytes must not stand in for
		// the new push still in flight.
		val rows = listOf(
			row(
				100,
				MessageFile(
					"a.html",
					"text/html",
					"https://appassets.androidplatform.net/attachments/1-1/a.html",
					blobId = "sha256-old",
				),
			),
			row(200, MessageFile("a.html", "text/html", null, blobId = "sha256-new")),
		)
		val card = StoredCard("a.html", rel = null, at = 200, blobId = "sha256-new")
		assertNull(resolveCardRel(rows, card))
	}

	@Test
	fun resolveCardRelIsNullWhileNothingHasLanded() {
		val rows = listOf(row(100, MessageFile("a.html", "text/html", null, blobId = "sha256-aa")))
		assertNull(resolveCardRel(rows, StoredCard("a.html", rel = null, at = 100, blobId = "sha256-aa")))
		// A legacy card with no blobId resolves nothing; its persisted rel is already its answer.
		assertNull(resolveCardRel(rows, StoredCard("a.html", rel = "1-1/a.html", at = 100)))
	}

	////////////////////////////////
	//  Tap-time marker parse (the opener's gate)

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
		// The opener's read is a bounded prefix, so the marker must still parse off a truncated head.
		val large = cardHtml + "\n" + "<div>x</div>".repeat(5000)
		assertEquals("Designer dock", parseDsCardMarker(large.take(2048))!!.group)
	}
}
