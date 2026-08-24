package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Turning a terminal selection into the link the owner was reaching for. */
class TerminalCopyTest {
	@Test
	fun rowsThePaneBrokeALinkAcrossAreJoined() {
		val selected = "https://example.com/a/very/long/path/\nthat/wraps?token=abcdef"
		assertEquals("https://example.com/a/very/long/path/that/wraps?token=abcdef", selectedUrl(selected))
	}

	@Test
	fun aContinuationRowLosesTheIndentTheTuiDrewAroundIt() {
		// Claude Code boxes and indents its content, so a continuation starts well inside the pane.
		val selected = "https://example.com/a/long\n    /path/inside/a/box"
		assertEquals("https://example.com/a/long/path/inside/a/box", selectedUrl(selected))
	}

	@Test
	fun aLinkOnOneRowIsAnsweredUnchanged() {
		assertEquals("https://example.com/x", selectedUrl("https://example.com/x"))
	}

	@Test
	fun surroundingWhitespaceIsDropped() {
		assertEquals("https://example.com/x", selectedUrl("   https://example.com/x  "))
	}

	@Test
	fun aSelectionWithNoSchemeIsRefused() {
		assertNull(selectedUrl("just some words"))
		assertNull(selectedUrl(""))
	}

	@Test
	fun aLinkFollowedByProseIsRefused() {
		// Joining leaves the prose spacing in place, and a URL carries no spaces, so it fails the gate.
		assertNull(selectedUrl("https://a.example/x\nand some words"))
	}

	@Test
	fun aBlankRowDisqualifiesTheJoin() {
		// The pane never forces a break onto a blank row, so this one came from the content.
		assertNull(selectedUrl("https://a.example/x\n\nmore"))
	}

	@Test
	fun aBareWordEndingInAColonIsNotALink() {
		assertNull(selectedUrl("TODO:fix\nthis"))
		assertNull(selectedUrl("note:something"))
	}

	@Test
	fun aSlashlessSchemeIsAllowedFromItsOwnSet() {
		assertEquals("mailto:someone@example.com", selectedUrl("mailto:someone@example.com"))
		assertEquals("tel:+15550100", selectedUrl("tel:+15550100"))
	}

	@Test
	fun aCustomAppSchemeIsAcceptedAndJoined() {
		assertEquals("myapp://open/a/thing", selectedUrl("myapp://open/a\n/thing"))
	}

	@Test
	fun aSchemeWithNothingAfterItIsRefused() {
		assertNull(selectedUrl("https://"))
		assertNull(selectedUrl("mailto:"))
	}

	@Test
	fun theLabelIsTheHost() {
		assertEquals("example.com", linkLabel("https://example.com/a/b?c=d#e"))
		assertEquals("open", linkLabel("myapp://open/a/thing"))
	}

	@Test
	fun theLabelFallsBackToTheSchemeWhenThereIsNoHost() {
		assertEquals("mailto:", linkLabel("mailto:someone@example.com"))
	}
}
