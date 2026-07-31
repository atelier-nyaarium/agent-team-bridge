package com.atelier_nyaarium.switchboard

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The text-vs-binary decision behind the viewer's preview stage.
 *
 * Several of these fail against the obvious `String(bytes)` implementation, which substitutes U+FFFD
 * rather than reporting, and would therefore call every binary file text.
 *
 * Multi-byte cases are built from explicit bytes rather than written as characters, so a test says
 * the same thing regardless of how this source file happens to encode a given glyph.
 */
class TextPeekTest {
	private lateinit var dir: File

	@Before
	fun setUp() {
		dir = Files.createTempDirectory("text-peek").toFile()
	}

	@After
	fun tearDown() {
		dir.deleteRecursively()
	}

	private fun peek(bytes: ByteArray, truncated: Boolean = false) = TextPeek.Peek(bytes, truncated)

	/** U+FEFF as it appears on disk. */
	private val markerBytes = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())

	/** U+00E9 (e-acute), a two-byte sequence. */
	private val eAcute = byteArrayOf(0xC3.toByte(), 0xA9.toByte())

	// ---- plain cases ----

	@Test
	fun readsAsciiBackVerbatim() {
		assertEquals("hello world\n", TextPeek.sniff(peek("hello world\n".toByteArray())))
	}

	@Test
	fun readsMultiByteTextBackVerbatim() {
		val bytes = "caf".toByteArray() + eAcute + " ok\n".toByteArray()

		val text = TextPeek.sniff(peek(bytes))!!

		// Eight characters from nine bytes: the accented one arrives as a single char, not two.
		assertEquals(8, text.length)
		assertEquals(0xE9, text[3].code)
		assertTrue(text.endsWith(" ok\n"))
	}

	@Test
	fun anEmptyFileIsTextNotBinary() {
		assertEquals("", TextPeek.sniff(peek(ByteArray(0))))
	}

	// ---- binary ----

	@Test
	fun aNulByteMakesItBinaryEvenWhenEverythingElseLooksLikeText() {
		val bytes = "plausible header".toByteArray() + byteArrayOf(0) + "more".toByteArray()

		assertNull(TextPeek.sniff(peek(bytes)))
	}

	@Test
	fun bytesThatCannotAppearInUtf8AtAllMakeItBinary() {
		// 0xC0 and 0xC1 are never valid UTF-8 lead bytes. String(bytes) would silently turn these
		// into replacement characters and report success.
		val bytes = byteArrayOf(0x68, 0x69, 0xC0.toByte(), 0xC1.toByte(), 0x0A)

		assertNull(TextPeek.sniff(peek(bytes)))
	}

	@Test
	fun aLoneContinuationByteMakesItBinary() {
		val bytes = byteArrayOf(0x68, 0x80.toByte(), 0x69)

		assertNull(TextPeek.sniff(peek(bytes)))
	}

	// ---- the truncation rule, which is the whole point of carrying `truncated` ----

	@Test
	fun aMultiByteCharacterCutOffByThePeekWindowIsStillText() {
		// The window stopped mid-character, so the cut is the reader's doing. Refusing here would
		// call a large UTF-8 file binary or not depending on where the 64 KB boundary happened to
		// land inside it.
		val cut = "caf".toByteArray() + eAcute.copyOf(1)

		val text = TextPeek.sniff(peek(cut, truncated = true))

		assertNotNull("a boundary cut must not classify as binary", text)
		// The held lead byte is dropped, not guessed at: which character it starts is not yet known.
		assertEquals("caf", text)
	}

	@Test
	fun theSameCutBytesAreBinaryWhenTheFileActuallyEndsThere() {
		// Identical bytes, opposite verdict. Nothing but `truncated` distinguishes them, which is
		// why a rule that forgave any bad tail would excuse real binary files.
		val cut = "caf".toByteArray() + eAcute.copyOf(1)

		assertNull(TextPeek.sniff(peek(cut, truncated = false)))
	}

	// ---- byte-order marker ----

	@Test
	fun aLeadingByteOrderMarkIsStrippedSoItDoesNotDrawAsAStrayGlyph() {
		val bytes = markerBytes + "# Title\n".toByteArray()

		assertEquals("# Title\n", TextPeek.sniff(peek(bytes)))
	}

	@Test
	fun aMarkerLaterInTheFileIsContentAndIsLeftAlone() {
		// Only a LEADING marker is a byte-order marker. One in the middle is a zero-width no-break
		// space the author put there, so stripping every occurrence would edit the file's content.
		val bytes = markerBytes + "start".toByteArray() + markerBytes + "end".toByteArray()

		val text = TextPeek.sniff(peek(bytes))!!

		assertTrue("the leading one must be gone", text.startsWith("start"))
		assertEquals("the interior one must survive", 1, text.count { it.code == 0xFEFF })
	}

	// ---- reading from disk ----

	@Test
	fun readReportsAShortFileAsComplete() {
		val file = File(dir, "short.txt").apply { writeText("small\n") }

		val p = TextPeek.read(file)!!

		assertEquals(false, p.truncated)
		assertEquals("small\n", TextPeek.sniff(p))
	}

	@Test
	fun readStopsAtThePeekBoundAndSaysThereIsMore() {
		val file = File(dir, "big.txt").apply { writeText("x".repeat(TextPeek.PEEK_BYTES * 2)) }

		val p = TextPeek.read(file)!!

		assertEquals(TextPeek.PEEK_BYTES, p.bytes.size)
		assertTrue("a file past the bound must report truncated", p.truncated)
	}

	@Test
	fun readReportsAFileExactlyAtTheBoundAsComplete() {
		// The off-by-one worth pinning: filling the buffer is not by itself evidence of more bytes.
		val file = File(dir, "exact.txt").apply { writeText("y".repeat(TextPeek.PEEK_BYTES)) }

		val p = TextPeek.read(file)!!

		assertEquals(TextPeek.PEEK_BYTES, p.bytes.size)
		assertEquals(false, p.truncated)
	}

	@Test
	fun readReportsNothingForAMissingFile() {
		assertNull(TextPeek.read(File(dir, "absent.txt")))
	}

	// ---- what the stage draws ----

	@Test
	fun thePreviewIsCappedSoALongFileCannotFloodTheStage() {
		val file = File(dir, "long.txt").apply { writeText("z".repeat(TextPeek.PEEK_BYTES)) }

		val preview = TextPeek.preview(TextPeek.read(file)!!)!!

		assertEquals(TextPeek.PREVIEW_CHARS, preview.length)
	}

	@Test
	fun aBinaryFileHasNoPreviewSoTheStageFallsBackToTheGlyph() {
		val file = File(dir, "blob.bin").apply { writeBytes(byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x00, 0x01)) }

		assertNull(TextPeek.preview(TextPeek.read(file)!!))
	}
}
