package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the directory picker's failure vocabulary. The point of these is that the causes stay
 * DISTINGUISHABLE: they all rendered as an empty picker once, so a machine that was switched off read
 * as a broken feature.
 */
class DirListingTest {

	@Test
	fun anOfflineMachineSaysSo() {
		assertEquals("That machine is offline.", dirListError(Error("""gateway "ql-2815" is not connected""")))
		assertEquals("That machine is offline.", dirListError(Error("gateway unavailable")))
	}

	@Test
	fun aMisroutedFrameIsNotReportedAsCryptography() {
		// What the Router's substitute-gateway fallback produced. A person reading it needs to know the
		// machine was not reached, not that an AEAD tag failed.
		val answer = dirListError(Error("list_dirs failed: unseal failed: unable to authenticate data"))
		assertEquals("Couldn't reach that machine.", answer)
	}

	@Test
	fun aMissingDaemonIsItsOwnCause() {
		assertEquals(
			"No host daemon on that machine.",
			dirListError(Error("list_dirs failed: terminal view unavailable on this Gateway")),
		)
	}

	@Test
	fun anUnrecognizedCauseKeepsItsOwnMessage() {
		// Never guessed at: this string is the only thing between a person and a silent failure, so a
		// raw message beats a wrong friendly one.
		assertEquals("invalid path: must be absolute or ~-rooted", dirListError(Error("invalid path: must be absolute or ~-rooted")))
		assertTrue(dirListError(Error("")).isNotEmpty())
	}

	@Test
	fun anEmptyFolderIsNotAnError() {
		assertEquals(null, DirListing(emptyList()).error)
	}
}
