package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The pure ANSI-SGR state machine behind the terminal renderer. ESC is written \u001b. */
class AnsiParseTest {
	@Test
	fun plainTextIsOneDefaultRun() {
		val runs = parseAnsiRuns("hello world")
		assertEquals(1, runs.size)
		assertEquals("hello world", runs[0].text)
		assertNull(runs[0].fg)
		assertNull(runs[0].bg)
		assertEquals(false, runs[0].bold)
	}

	@Test
	fun foregroundColorThenResetSplitsRuns() {
		val runs = parseAnsiRuns("\u001b[31mred\u001b[0m x")
		assertEquals(2, runs.size)
		assertEquals("red", runs[0].text)
		assertEquals(0xFFCD3131L, runs[0].fg) // standard red
		assertEquals(" x", runs[1].text)
		assertNull(runs[1].fg) // reset
	}

	@Test
	fun boldAndColorCombine() {
		val runs = parseAnsiRuns("\u001b[1;32mok\u001b[0m")
		assertEquals(1, runs.size)
		assertEquals("ok", runs[0].text)
		assertEquals(0xFF0DBC79L, runs[0].fg) // standard green
		assertEquals(true, runs[0].bold)
	}

	@Test
	fun backgroundColorIsApplied() {
		val runs = parseAnsiRuns("\u001b[44mb")
		assertEquals(0xFF2472C8L, runs[0].bg) // standard blue background
	}

	@Test
	fun xterm256RedMapsToTruecolor() {
		// 196 = pure red in the 6x6x6 cube.
		val runs = parseAnsiRuns("\u001b[38;5;196mX")
		assertEquals(0xFFFF0000L, runs[0].fg)
	}

	@Test
	fun truecolorIsApplied() {
		val runs = parseAnsiRuns("\u001b[38;2;10;20;30mX")
		assertEquals((0xFF000000L or (10L shl 16) or (20L shl 8) or 30L), runs[0].fg)
	}

	@Test
	fun nonSgrEscapeIsSkipped() {
		// A clear-screen sequence (ends in 'J', not 'm') carries no style and must not appear.
		val runs = parseAnsiRuns("\u001b[2Jhi")
		assertEquals(1, runs.size)
		assertEquals("hi", runs[0].text)
		assertNull(runs[0].fg)
	}

	@Test
	fun brightForegroundColor() {
		val runs = parseAnsiRuns("\u001b[91mx")
		assertEquals(0xFFF14C4CL, runs[0].fg) // bright red
	}

	@Test
	fun nonSgrCsiIsSkippedWithoutEatingNextChar() {
		// ESC[1@ is a non-SGR CSI (final byte '@'); the char after it must survive.
		val runs = parseAnsiRuns("\u001b[1@b")
		assertEquals(1, runs.size)
		assertEquals("b", runs[0].text)
		assertNull(runs[0].fg)
	}

	@Test
	fun emptyParamsIsReset() {
		// ESC[m with no params is a reset, so the text after it returns to default.
		val runs = parseAnsiRuns("\u001b[31mred\u001b[mplain")
		assertEquals(2, runs.size)
		assertEquals("red", runs[0].text)
		assertEquals(0xFFCD3131L, runs[0].fg)
		assertEquals("plain", runs[1].text)
		assertNull(runs[1].fg)
	}

	// Build ESC from its code point so no literal control byte lives in the source.
	private val e = 27.toChar()

	@Test
	fun background256AndTruecolor() {
		assertEquals(0xFF0000FFL, parseAnsiRuns("$e[48;5;21mX")[0].bg) // cube blue
		assertEquals(0xFF010203L, parseAnsiRuns("$e[48;2;1;2;3mX")[0].bg)
	}

	@Test
	fun grayscaleRamp() {
		// index 244 -> 8 + (244-232)*10 = 128 on each channel.
		assertEquals(0xFF808080L, parseAnsiRuns("$e[38;5;244mX")[0].fg)
	}

	@Test
	fun midLineResetsEndAttributes() {
		val bold = parseAnsiRuns("$e[1mb$e[22mn")
		assertEquals(true, bold[0].bold)
		assertEquals(false, bold[1].bold)
		val fg = parseAnsiRuns("$e[31mr$e[39md")
		assertEquals(0xFFCD3131L, fg[0].fg)
		assertNull(fg[1].fg)
	}

	@Test
	fun reverseVideoIsTrackedAndCleared() {
		assertEquals(true, parseAnsiRuns("$e[7mx")[0].reverse)
		val runs = parseAnsiRuns("$e[7ma$e[27mb")
		assertEquals(true, runs[0].reverse)
		assertEquals(false, runs[1].reverse)
	}

	@Test
	fun osc8HyperlinkMarkupIsStrippedLeavingTheLabel() {
		// OSC 8 hyperlink: ESC ] 8 ; params ; URI ST <label> ESC ] 8 ; ; ST. The markup must not leak;
		// only the visible label survives. ST is ESC \.
		val input = "before${e}]8;;https://claude.com/x${e}\\shown${e}]8;;${e}\\end"
		val runs = parseAnsiRuns(input)
		assertEquals(1, runs.size)
		assertEquals("beforeshownend", runs[0].text)
	}

	@Test
	fun oscSequenceTerminatedByBelIsStripped() {
		val bel = 7.toChar()
		val runs = parseAnsiRuns("a${e}]0;window title${bel}b")
		assertEquals(1, runs.size)
		assertEquals("ab", runs[0].text)
	}

	@Test
	fun rowPaddingIsDroppedWhenItCarriesNoColour() {
		val runs = trimLineEnds(parseAnsiRuns("short   \nnext line    \n"))
		assertEquals("short\nnext line\n", runs.joinToString("") { it.text })
	}

	@Test
	fun paddingUnderABackgroundSurvives() {
		// A tmux status line colours out to the pane edge, so its trailing cells are visible.
		val runs = trimLineEnds(parseAnsiRuns("\u001b[44mstatus   \u001b[0m\nplain   \n"))
		assertEquals("status   \nplain\n", runs.joinToString("") { it.text })
	}

	@Test
	fun paddingUnderReverseSurvives() {
		// Reverse paints a background from the fg, so those cells are visible too.
		val runs = trimLineEnds(parseAnsiRuns("\u001b[7msel  \u001b[0m\n"))
		assertEquals("sel  \n", runs.joinToString("") { it.text })
	}

	@Test
	fun aRowOfOnlyPaddingBecomesEmpty() {
		val runs = trimLineEnds(parseAnsiRuns("a\n      \nb"))
		assertEquals("a\n\nb", runs.joinToString("") { it.text })
	}

	@Test
	fun spacingInsideARowIsUntouched() {
		// Only the end of a row is padding; spacing within it is layout and must stay.
		val runs = trimLineEnds(parseAnsiRuns("col1   col2   "))
		assertEquals("col1   col2", runs.joinToString("") { it.text })
	}

	@Test
	fun paddingSpanningSeveralRunsIsFullyDropped() {
		// A row can end in fresh colours whose only content is padding.
		val runs = trimLineEnds(parseAnsiRuns("text\u001b[31m  \u001b[32m  \u001b[0m\ntail"))
		assertEquals("text\ntail", runs.joinToString("") { it.text })
	}
}
