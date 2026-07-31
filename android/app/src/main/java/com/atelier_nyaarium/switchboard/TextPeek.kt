package com.atelier_nyaarium.switchboard

import java.io.File
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

////////////////////////////////
//  Functions & Helpers

/**
 * Decides whether a file is text the viewer can show, and returns it if so.
 *
 * The decoder does the classifying rather than a hand-rolled byte scan. It already separates the two
 * cases that matter: a multi-byte sequence cut off by the peek window returns UNDERFLOW, while bytes
 * that could not appear in the encoding at all return MALFORMED. A rule that forgave any bad tail
 * would excuse binary files whose last bytes happen to look truncated.
 *
 * Kotlin's `String(bytes)` cannot be used here. It substitutes U+FFFD for anything invalid and never
 * fails, so every file would classify as text and the distinction would be untestable.
 */
object TextPeek {
	/** How much of a file is read before deciding. Enough to catch binary content that opens with a
	 * plausible text header, small enough to stay cheap on a large file. */
	const val PEEK_BYTES = 64 * 1024

	/** How much of the decoded text the stage renders. */
	const val PREVIEW_CHARS = 4 * 1024

	/** U+FEFF, matched by code point because the character itself is invisible in an editor and in a
	 * diff, where a reader could not tell it from an empty string. */
	private const val BOM_CODE = 0xFEFF

	/** The head of a file plus whether more of it exists beyond the peek. */
	class Peek(val bytes: ByteArray, val truncated: Boolean)

	fun read(file: File): Peek? = runCatching {
		file.inputStream().use { stream ->
			val buffer = ByteArray(PEEK_BYTES)
			var filled = 0
			while (filled < buffer.size) {
				val n = stream.read(buffer, filled, buffer.size - filled)
				if (n < 0) break
				filled += n
			}
			// One more read answers truncated-vs-complete without stat-ing the file, which could
			// disagree with what was actually readable.
			val more = filled == buffer.size && stream.read() >= 0
			Peek(buffer.copyOf(filled), more)
		}
	}.getOrNull()

	/**
	 * The file's text, or null when it is binary.
	 *
	 * `truncated` is what makes a cut-off multi-byte sequence forgivable: with more bytes beyond the
	 * window the cut is the window's doing, but in a file that ENDS there the same bytes are genuinely
	 * malformed and the file is not text.
	 */
	fun sniff(peek: Peek): String? {
		// A NUL never appears in UTF-8 text and is the one cheap signal that survives any encoding
		// question. It also classifies UTF-16 as binary, which is known and accepted.
		if (peek.bytes.any { it == 0.toByte() }) return null

		val decoder = StandardCharsets.UTF_8.newDecoder().apply {
			onMalformedInput(CodingErrorAction.REPORT)
			onUnmappableCharacter(CodingErrorAction.REPORT)
		}
		val input = ByteBuffer.wrap(peek.bytes)
		// UTF-8 never yields more chars than bytes, so this cannot overflow.
		val output = CharBuffer.allocate(peek.bytes.size + 1)

		val decoded = decoder.decode(input, output, !peek.truncated)
		if (decoded.isError) return null
		if (!peek.truncated && decoder.flush(output).isError) return null

		output.flip()
		val text = output.toString()
		// A byte-order marker is not content; left in place it draws as a stray glyph on the first
		// line of the preview.
		return if (text.isNotEmpty() && text[0].code == BOM_CODE) text.substring(1) else text
	}

	/** What the stage draws: the sniffed text, capped. Null when the file is binary. */
	fun preview(peek: Peek): String? = sniff(peek)?.take(PREVIEW_CHARS)
}
