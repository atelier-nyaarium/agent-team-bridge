package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the directory picker browses for a given field text.
 *
 * The defect this pins: a Windows field had no implied directory, so an empty one listed nothing and
 * tapping it did nothing at all. The drives stand in for home there.
 */
class DirBrowseTest {
	@Test
	fun `an empty Windows field browses the drives`() {
		val b = dirBrowse("", isWindows = true)
		assertTrue(b.listable)
		assertEquals("/", b.listPath)
		assertEquals("", b.parent)
		assertEquals("", b.fragment)
	}

	@Test
	fun `a bare Windows fragment filters the drive list`() {
		val b = dirBrowse("C", isWindows = true)
		assertTrue(b.listable)
		assertEquals("/", b.listPath)
		assertEquals("C", b.fragment)
	}

	@Test
	fun `tapping a drive row yields a rooted path the launch accepts`() {
		val b = dirBrowse("", isWindows = true)
		// The row builds parent + entry + "/".
		assertEquals("C:/", "${b.parent}C:/")
	}

	@Test
	fun `a rooted Windows path lists that directory`() {
		val b = dirBrowse("C:/Users/", isWindows = true)
		assertTrue(b.listable)
		assertEquals("C:/Users/", b.listPath)
		assertEquals("", b.fragment)
	}

	@Test
	fun `a relative Windows path lists nothing`() {
		assertFalse(dirBrowse("foo/", isWindows = true).listable)
	}

	@Test
	fun `an empty host field implies home`() {
		val b = dirBrowse("", isWindows = false)
		assertTrue(b.listable)
		assertEquals("~/", b.listPath)
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
