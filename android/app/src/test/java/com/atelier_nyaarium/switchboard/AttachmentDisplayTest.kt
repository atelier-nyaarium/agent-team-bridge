package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The one decision layer both renderers consume, so what it decides here is what both surfaces do. */
class AttachmentDisplayTest {
	private fun file(name: String, mime: String, src: String? = "attachments/1-2/$name", size: Long? = null) =
		MessageFile(name, mime, src, size)

	private val noDecoration: (MessageFile) -> ChipDecoration? = { null }

	@Test
	fun drawsAThumbnailOnlyForAFormatTheRendererCanDecode() {
		assertTrue(isPreviewable(file("a.png", "image/png")))
		assertTrue(isPreviewable(file("a.webp", "image/webp")))
		// The WebView decodes neither, so a prefix test would have shown a broken tile.
		assertFalse(isPreviewable(file("a.tiff", "image/tiff")))
		assertFalse(isPreviewable(file("a.heic", "image/heic")))
	}

	@Test
	fun listsAVideoAsAFileWhileNothingGeneratesPosterFrames() {
		assertFalse(isPreviewable(file("clip.mp4", "video/mp4")))
	}

	@Test
	fun listsAnSvgAsAFileBecauseTheViewerBehindTheThumbnailCannotDecodeIt() {
		assertFalse(isPreviewable(file("logo.svg", "image/svg+xml")))
	}

	@Test
	fun listsAnEmptyOrMalformedMimeAsAFile() {
		assertFalse(isPreviewable(file("mystery", "")))
		assertFalse(isPreviewable(file("mystery", "notamime")))
		assertTrue(isPreviewable(file("a.png", "  image/png  ")))
	}

	@Test
	fun listsAnAttachmentWithNoBytesAsAFile() {
		assertFalse(isPreviewable(file("a.png", "image/png", src = null)))
	}

	@Test
	fun toleratesAMimeCarryingParametersOrCasing() {
		assertTrue(isPreviewable(file("a.png", "IMAGE/PNG")))
		assertTrue(isPreviewable(file("a.png", "image/png; charset=binary")))
	}

	@Test
	fun putsEveryThumbnailBeforeEveryFileAndKeepsSentOrderWithinEach() {
		val files = listOf(
			file("doc.pdf", "application/pdf"),
			file("one.png", "image/png"),
			file("notes.txt", "text/plain"),
			file("two.png", "image/png"),
		)
		val shown = displayAttachments(files, noDecoration)
		assertEquals(listOf("one.png", "two.png", "doc.pdf", "notes.txt"), shown.map { it.file.name })
	}

	@Test
	fun dropsAHiddenAttachmentEntirelyRatherThanOrderingIt() {
		val files = listOf(file("shot.png", "image/png"), file("switchboard-references.json", "application/json"))
		val shown = displayAttachments(files) { f ->
			if (f.name.endsWith(".json")) ChipDecoration("refs", "ref", hidden = true) else null
		}
		assertEquals(listOf("shot.png"), shown.map { it.file.name })
	}

	@Test
	fun anUnrecognizedRoleNeverTakesAThumbnailAndSortsLast() {
		// The sender said something deliberate this build does not understand: the signal spends on
		// ranking only, never reachability - shown as a plain row at the end, not hidden, because a
		// wrong show heals at the next update while a wrong hide is a file the user cannot reach.
		val files = listOf(
			file("future.png", "image/png").copy(role = "hologram-frame"),
			file("shot.png", "image/png").copy(role = "attachment"),
			file("notes.txt", "text/plain"),
		)
		val shown = displayAttachments(files, noDecoration)
		assertEquals(listOf("shot.png", "notes.txt", "future.png"), shown.map { it.file.name })
		assertTrue(!shown.last().previewable)
	}

	@Test
	fun labelsAnAttachmentWithItsDecorationTitleInsteadOfTheFilename() {
		val shown = displayAttachments(listOf(file("a1b2c3.txt", "text/plain"))) {
			ChipDecoration("cart.ts : add", "ref")
		}
		assertEquals("cart.ts : add", displayName(shown[0]))
	}

	@Test
	fun fallsBackToTheFilenameWhenADecorationCarriesNoUsableTitle() {
		val shown = displayAttachments(listOf(file("real.txt", "text/plain"))) { ChipDecoration("  ", "ref") }
		assertEquals("real.txt", displayName(shown[0]))
	}

	@Test
	fun formatsSizeInTheUnitsAFileManagerShows() {
		assertEquals("512 B", prettySize(512))
		assertEquals("4 KB", prettySize(4_096))
		assertEquals("2.5 MB", prettySize(2_500_000))
	}

	@Test
	fun doesNotPrintAThousandOfASmallerUnit() {
		assertEquals("1.0 MB", prettySize(999_600))
		assertEquals("999 KB", prettySize(999_400))
	}

	@Test
	fun showsNoSizeAtAllWhenNoneWasCarried() {
		assertNull(prettySize(null))
	}

	@Test
	fun showsAnEmptyFileAsZeroRatherThanHidingIt() {
		assertEquals("0 B", prettySize(0))
	}
}
