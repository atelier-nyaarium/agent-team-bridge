package com.atelier_nyaarium.switchboard

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle

////////////////////////////////
//  ANSI SGR rendering
//
//  Parsing is split into a PURE state machine (parseAnsiRuns, JVM-unit-testable with plain ARGB
//  longs) and the Compose adapter (ansiToAnnotated) that maps runs to colored spans.

// The standard + bright 16-color palette (VS Code's terminal theme) as ARGB longs.
private val ANSI_8 = longArrayOf(
	0xFF1E1E1E, 0xFFCD3131, 0xFF0DBC79, 0xFFE5E510, 0xFF2472C8, 0xFFBC3FBC, 0xFF11A8CD, 0xFFCCCCCC,
)
private val ANSI_BRIGHT = longArrayOf(
	0xFF666666, 0xFFF14C4C, 0xFF23D18B, 0xFFF5F543, 0xFF3B8EEA, 0xFFD670D6, 0xFF29B8DB, 0xFFFFFFFF,
)

private fun rgb(r: Int, g: Int, b: Int): Long =
	0xFF000000 or (r.toLong() shl 16) or (g.toLong() shl 8) or b.toLong()

/** The xterm 256-color index to an ARGB long (16 base, a 6x6x6 cube, then a grayscale ramp). */
private fun xterm256(n: Int): Long {
	if (n < 8) return ANSI_8[n]
	if (n < 16) return ANSI_BRIGHT[n - 8]
	if (n in 16..231) {
		val c = n - 16
		fun step(v: Int) = if (v == 0) 0 else 55 + v * 40
		return rgb(step(c / 36), step((c % 36) / 6), step(c % 6))
	}
	val v = 8 + (n - 232) * 10
	return rgb(v, v, v)
}

// Codepoint-constructed rather than a char literal, so no raw control byte sits in the source file.
private val ESC = 0x1b.toChar()
private val BEL = 0x07.toChar()

/** A styled run of text. A null color means "terminal default" (unspecified). `reverse` swaps
 * fg/bg at render time (SGR 7), which tmux status lines and selected rows rely on. */
internal data class AnsiRun(val text: String, val fg: Long?, val bg: Long?, val bold: Boolean, val reverse: Boolean)

/**
 * Parse a `tmux capture-pane -e` snapshot (text with SGR color escapes, no cursor motion) into
 * styled runs. Non-SGR escape sequences are skipped; unsupported SGR codes (italic, underline) are
 * ignored. Handles 16-color, 256-color, truecolor, bold, and reverse. Pure (no Compose), JVM-testable.
 */
internal fun parseAnsiRuns(input: String): List<AnsiRun> {
	val runs = ArrayList<AnsiRun>()
	var fg: Long? = null
	var bg: Long? = null
	var bold = false
	var reverse = false
	val buf = StringBuilder()

	fun flush() {
		if (buf.isEmpty()) return
		runs.add(AnsiRun(buf.toString(), fg, bg, bold, reverse))
		buf.setLength(0)
	}

	fun applySgr(p: List<Int>) {
		if (p.isEmpty()) {
			fg = null; bg = null; bold = false; reverse = false; return
		}
		var k = 0
		while (k < p.size) {
			when (val code = p[k]) {
				0 -> { fg = null; bg = null; bold = false; reverse = false }
				1 -> bold = true
				7 -> reverse = true
				22 -> bold = false
				27 -> reverse = false
				in 30..37 -> fg = ANSI_8[code - 30]
				in 90..97 -> fg = ANSI_BRIGHT[code - 90]
				39 -> fg = null
				in 40..47 -> bg = ANSI_8[code - 40]
				in 100..107 -> bg = ANSI_BRIGHT[code - 100]
				49 -> bg = null
				38, 48 -> {
					val isFg = code == 38
					when (p.getOrNull(k + 1)) {
						5 -> { val c = xterm256(p.getOrNull(k + 2) ?: 0); if (isFg) fg = c else bg = c; k += 2 }
						2 -> {
							val c = rgb(p.getOrNull(k + 2) ?: 0, p.getOrNull(k + 3) ?: 0, p.getOrNull(k + 4) ?: 0)
							if (isFg) fg = c else bg = c
							k += 4
						}
					}
				}
			}
			k++
		}
	}

	var i = 0
	val n = input.length
	while (i < n) {
		val c = input[i]
		if (c == ESC && i + 1 < n && input[i + 1] == '[') {
			// Scan to the CSI final byte (0x40-0x7E); param/intermediate bytes are all below it.
			// Only 'm' (SGR) carries color; any other final byte (a non-SGR CSI) is skipped without
			// eating the char after it. capture-pane -e emits only SGR, so this is robustness.
			var j = i + 2
			while (j < n && input[j] < '@') j++
			if (j < n && input[j] == 'm') {
				flush()
				applySgr(input.substring(i + 2, j).split(';').mapNotNull { it.toIntOrNull() })
			}
			i = if (j < n) j + 1 else n
			continue
		}
		if (c == ESC && i + 1 < n && input[i + 1] == ']') {
			// OSC sequence (e.g. an OSC 8 hyperlink: ESC ] 8 ; params ; URI ST/BEL), terminated by
			// BEL (0x07) or ST (ESC \). Skip the whole sequence so its markup does not leak as text;
			// a hyperlink's visible label sits outside the sequence and stays.
			var j = i + 2
			while (j < n) {
				if (input[j] == BEL) { j++; break }
				if (input[j] == ESC && j + 1 < n && input[j + 1] == '\\') { j += 2; break }
				j++
			}
			i = j
			continue
		}
		if (c == ESC) { i++; continue }
		buf.append(c)
		i++
	}
	flush()
	return runs
}

/**
 * Drop the end-of-line padding a `-J` capture preserves, so a selection copies the text on a row
 * and not the blank cells behind it. Trailing spaces are dropped only while they are INVISIBLE: a
 * run carrying a background, or reverse (which paints one from the fg), is kept untouched, because
 * a tmux status line and a selected row both colour out to the pane edge. Pure, JVM-testable.
 */
internal fun trimLineEnds(runs: List<AnsiRun>): List<AnsiRun> {
	val out = ArrayList<AnsiRun>()
	val line = ArrayList<AnsiRun>()

	// Walk the finished line tail backwards, dropping spaces until a run is visible or holds text.
	fun flushLine() {
		var i = line.size - 1
		while (i >= 0) {
			val r = line[i]
			if (r.bg != null || r.reverse) break
			val kept = r.text.trimEnd(' ')
			if (kept.length == r.text.length) break
			if (kept.isEmpty()) {
				line.removeAt(i)
				i--
				continue
			}
			line[i] = r.copy(text = kept)
			break
		}
		out.addAll(line)
		line.clear()
	}

	for (r in runs) {
		var start = 0
		while (true) {
			val nl = r.text.indexOf('\n', start)
			if (nl < 0) {
				if (start < r.text.length) line.add(r.copy(text = r.text.substring(start)))
				break
			}
			if (nl > start) line.add(r.copy(text = r.text.substring(start, nl)))
			flushLine()
			// The newline keeps the style of its own run, so a background that reached the row edge
			// renders exactly as it did before.
			out.add(r.copy(text = "\n"))
			start = nl + 1
		}
	}
	flushLine()
	return out
}

// The pane's own default colors, used to resolve a null side when reverse must swap fg<->bg.
private const val DEFAULT_FG = 0xFFCCCCCCL
private const val DEFAULT_BG = 0xFF0C0C0CL

/** The Compose adapter: styled runs to a colored AnnotatedString. Reverse swaps fg/bg (resolving
 * a null side to the pane default) so it renders as a real highlight, not same-on-same text. */
fun ansiToAnnotated(input: String): AnnotatedString = buildAnnotatedString {
	for (r in trimLineEnds(parseAnsiRuns(input))) {
		val style = if (r.reverse) {
			SpanStyle(
				color = Color(r.bg ?: DEFAULT_BG),
				background = Color(r.fg ?: DEFAULT_FG),
				fontWeight = if (r.bold) FontWeight.Bold else null,
			)
		} else {
			SpanStyle(
				color = r.fg?.let { Color(it) } ?: Color.Unspecified,
				background = r.bg?.let { Color(it) } ?: Color.Unspecified,
				fontWeight = if (r.bold) FontWeight.Bold else null,
			)
		}
		withStyle(style) { append(r.text) }
	}
}
