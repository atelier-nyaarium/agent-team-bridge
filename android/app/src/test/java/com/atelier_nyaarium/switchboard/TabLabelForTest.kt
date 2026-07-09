package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Unit tests for tabLabelFor: the open-tab title/label disambiguation rule. A unique label wins
 * outright; a colliding or missing label falls back to the shortest address suffix that
 * disambiguates, qualifying the label with it rather than showing a bare address alone.
 *
 * Pure function over ChatState, no Android context (no Robolectric).
 */
class TabLabelForTest {

	private fun stateWith(openTabs: List<String>, labels: Map<String, String> = emptyMap()) =
		ChatState(openTabs = openTabs, labels = labels)

	@Test
	fun aUniqueLabelWinsOutrightWithNoQualifier() {
		val state = stateWith(
			openTabs = listOf("local.gw.proja.claude", "local.gw.projb.claude"),
			labels = mapOf("local.gw.proja.claude" to "Scratch"),
		)
		assertEquals("Scratch", tabLabelFor(state, "local.gw.proja.claude"))
	}

	@Test
	fun aMissingLabelFallsBackToTheBareAddressSuffixWithNoPrefix() {
		val state = stateWith(openTabs = listOf("local.gw.proja.claude", "local.gw.projb.claude"))
		assertEquals("proja.claude", tabLabelFor(state, "local.gw.proja.claude"))
	}

	@Test
	fun sameLabelOnTwoOpenTabsQualifiesBothDistinctly() {
		val state = stateWith(
			openTabs = listOf("local.gw.proja.claude", "local.gw.projb.claude"),
			labels = mapOf("local.gw.proja.claude" to "Work", "local.gw.projb.claude" to "Work"),
		)
		val a = tabLabelFor(state, "local.gw.proja.claude")
		val b = tabLabelFor(state, "local.gw.projb.claude")
		assertEquals("Work (proja.claude)", a)
		assertEquals("Work (projb.claude)", b)
		assertNotEquals(a, b)
	}

	@Test
	fun aQualifiedLabelAlwaysIncludesTheSpawnSegmentEvenWhenBareSessionIdsAlreadyDiffer() {
		// The two session ids ("a1b2c3", "d4e5f6") are already unique on their own - a bare id-only
		// qualifier would technically disambiguate - but a random hex fragment tells a human nothing
		// about which session it is. A label present at all must qualify with at least spawn.session.
		val state = stateWith(
			openTabs = listOf("local.gw.proja.a1b2c3", "local.gw.projb.d4e5f6"),
			labels = mapOf("local.gw.proja.a1b2c3" to "Work", "local.gw.projb.d4e5f6" to "Work"),
		)
		assertEquals("Work (proja.a1b2c3)", tabLabelFor(state, "local.gw.proja.a1b2c3"))
	}

	@Test
	fun exhaustingEveryQualifiedTierRetriesTheBareSessionIdRatherThanGivingUpUnlabeled() {
		// Three planted literal labels block the n=2, n=3, and n=4 candidates in turn - every
		// qualified tier is exhausted. A labeled-but-terser "Work (deadbeef01)" still beats falling
		// all the way through to the fully unlabeled raw address.
		val state = stateWith(
			openTabs = listOf(
				"acme.gw1.myproj.deadbeef01",
				"acme.gw1.other.claude",
				"acme.gw1.projy.projz",
				"acme.gw1.projz.projz",
				"acme.gw1.projq.projz",
			),
			labels = mapOf(
				"acme.gw1.myproj.deadbeef01" to "Work",
				"acme.gw1.other.claude" to "Work",
				"acme.gw1.projy.projz" to "Work (myproj.deadbeef01)",
				"acme.gw1.projz.projz" to "Work (gw1.myproj.deadbeef01)",
				"acme.gw1.projq.projz" to "Work (acme.gw1.myproj.deadbeef01)",
			),
		)
		assertEquals("Work (deadbeef01)", tabLabelFor(state, "acme.gw1.myproj.deadbeef01"))
	}

	@Test
	fun aQualifiedCandidateThatWouldMatchAnotherTabsLiteralLabelEscalatesInstead() {
		// TeamA and TeamA2 share the label "Work" and both end in ".claude", so TeamA's
		// disambiguation would naturally land on "Work (proja.claude)" at a 2-segment suffix - but
		// TeamB's own, unrelated label IS that exact literal string. Qualifying TeamA must not
		// produce text indistinguishable from TeamB's.
		val state = stateWith(
			openTabs = listOf("local.gw.proja.claude", "local.gw.projx.claude", "local.gw.projz.other"),
			labels = mapOf(
				"local.gw.proja.claude" to "Work",
				"local.gw.projx.claude" to "Work",
				"local.gw.projz.other" to "Work (proja.claude)",
			),
		)
		val a = tabLabelFor(state, "local.gw.proja.claude")
		val b = tabLabelFor(state, "local.gw.projz.other")
		assertNotEquals(a, b)
		assertEquals("Work (proja.claude)", b)
	}
}
