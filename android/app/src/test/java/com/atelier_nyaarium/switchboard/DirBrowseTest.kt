package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the directory picker browses for a given field text.
 *
 * The defect this pins: a Windows field had no implied directory, so an empty one listed nothing and
 * tapping it did nothing at all. A blank parent now asks the machine for its own default.
 */
class DirBrowseTest {
	@Test
	fun `an empty Windows field asks for the machine's default directory`() {
		val b = dirBrowse("", isWindows = true)
		assertTrue(b.listable)
		assertEquals("", b.parent)
		assertEquals("", b.fragment)
	}

	@Test
	fun `a bare Windows fragment still asks for the default and filters it`() {
		val b = dirBrowse("Doc", isWindows = true)
		assertTrue(b.listable)
		assertEquals("", b.parent)
		assertEquals("Doc", b.fragment)
	}

	@Test
	fun `a rooted Windows path lists that directory`() {
		val b = dirBrowse("C:/Users/", isWindows = true)
		assertTrue(b.listable)
		assertEquals("C:/Users/", b.parent)
		assertEquals("", b.fragment)
	}

	@Test
	fun `a rooted Windows path splits at its last separator`() {
		val b = dirBrowse("C:/Users/nyaa", isWindows = true)
		assertEquals("C:/Users/", b.parent)
		assertEquals("nyaa", b.fragment)
	}

	@Test
	fun `a relative Windows path lists nothing`() {
		assertFalse(dirBrowse("foo/", isWindows = true).listable)
	}

	@Test
	fun `an empty host field implies home`() {
		val b = dirBrowse("", isWindows = false)
		assertTrue(b.listable)
		assertEquals("~/", b.parent)
		assertEquals("", b.fragment)
	}

	@Test
	fun `a host path splits at its last separator`() {
		val b = dirBrowse("~/projects/switch", isWindows = false)
		assertTrue(b.listable)
		assertEquals("~/projects/", b.parent)
		assertEquals("switch", b.fragment)
	}

	@Test
	fun `a relative host path lists nothing`() {
		assertFalse(dirBrowse("foo/", isWindows = false).listable)
	}
}
