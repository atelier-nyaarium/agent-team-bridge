package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The mime guard in front of createDocument.
 *
 * A file's mime arrives on the wire and nothing upstream constrains its shape, so this is the last
 * place that decides what the document provider is asked to make. The rest of SaveTarget needs real
 * Android providers and is not reachable from a JVM test.
 */
class SaveTargetTest {
	private val opaque = "application/octet-stream"

	@Test
	fun anOrdinaryTypePassesThroughUnchanged() {
		assertEquals("image/png", SaveTarget.documentMime("image/png"))
		assertEquals("application/pdf", SaveTarget.documentMime("application/pdf"))
		assertEquals("text/plain", SaveTarget.documentMime("text/plain"))
	}

	@Test
	fun theDirectoryTypeIsRefusedSoASaveCannotCreateAFolderInsteadOfAFile() {
		// The whole reason this guard exists: a sender controls this string, and the provider would
		// happily make a folder in the user's chosen location.
		assertEquals(opaque, SaveTarget.documentMime("vnd.android.document/directory"))
		assertEquals(opaque, SaveTarget.documentMime("VND.ANDROID.DOCUMENT/DIRECTORY"))
		assertEquals(opaque, SaveTarget.documentMime("vnd.android.document/directory; charset=utf-8"))
	}

	@Test
	fun anythingThatIsNotAPlainTypeSubtypeBecomesOpaqueBytes() {
		assertEquals(opaque, SaveTarget.documentMime(""))
		assertEquals(opaque, SaveTarget.documentMime("   "))
		assertEquals(opaque, SaveTarget.documentMime("notamime"))
		assertEquals(opaque, SaveTarget.documentMime("image/"))
		assertEquals(opaque, SaveTarget.documentMime("/png"))
		assertEquals(opaque, SaveTarget.documentMime("image/png/extra"))
		assertEquals(opaque, SaveTarget.documentMime("image png"))
		assertEquals(opaque, SaveTarget.documentMime("../../etc/passwd"))
	}

	@Test
	fun normalizationMatchesWhatTheRestOfTheAppDoesWithAMime() {
		// Parameters and casing are carried by real senders, and dropping them here rather than
		// refusing keeps an ordinary file saving with its real type.
		assertEquals("image/png", SaveTarget.documentMime("IMAGE/PNG"))
		assertEquals("image/png", SaveTarget.documentMime("image/png; charset=binary"))
		assertEquals("image/png", SaveTarget.documentMime("  image/png  "))
	}
}
