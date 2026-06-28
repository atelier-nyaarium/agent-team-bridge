package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the spawn-dialog session-name slugifier (applied on spawn): lowercase, non-[a-z0-9] runs
 * collapse to a single '-', '-' trimmed from both ends, capped at 64.
 */
class SlugifySessionNameTest {
	@Test
	fun convertsFreeText() {
		assertEquals("my-session", slugifySessionName("My Session"))
		assertEquals("scratch-pad", slugifySessionName("scratch pad"))
	}

	@Test
	fun compressesRunsAndTrimsBothEnds() {
		assertEquals("a-b", slugifySessionName("a!!!b"))
		assertEquals("foo", slugifySessionName("--foo--"))
		assertEquals("ab", slugifySessionName("--ab"))
		assertEquals("foo-bar", slugifySessionName("  Foo___Bar  "))
	}

	@Test
	fun capsAt64() {
		assertEquals(64, slugifySessionName("a".repeat(80)).length)
	}

	@Test
	fun allInvalidIsEmpty() {
		assertEquals("", slugifySessionName("!!!"))
		assertEquals("", slugifySessionName("---"))
		assertEquals("", slugifySessionName("   "))
	}
}
