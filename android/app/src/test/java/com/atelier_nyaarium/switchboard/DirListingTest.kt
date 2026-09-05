package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The three failing layers stay distinguishable. */
class DirListingTest {
	private val offline = dirListError(Error("""gateway "ql-2815" is not connected"""))
	private val unreached = dirListError(Error("list_dirs failed: unseal failed: unable to authenticate data"))
	private val noDaemon = dirListError(Error("list_dirs failed: terminal view unavailable on this Gateway"))

	@Test
	fun eachLayerHasItsOwnAnswer() {
		assertEquals(3, setOf(offline, unreached, noDaemon).size)
		assertEquals(offline, dirListError(Error("gateway unavailable")))
	}

	@Test
	fun aMisroutedFrameIsNotReportedAsCryptography() {
		assertFalse(unreached.contains("unseal", ignoreCase = true))
	}

	@Test
	fun anUnrecognizedCauseKeepsItsOwnMessage() {
		val raw = "invalid path: must be absolute or ~-rooted"
		assertEquals(raw, dirListError(Error(raw)))
		assertTrue(dirListError(Error("")).isNotEmpty())
	}

	@Test
	fun anEmptyFolderIsNotAnError() {
		assertEquals(null, DirListing(emptyList()).error)
	}
}
