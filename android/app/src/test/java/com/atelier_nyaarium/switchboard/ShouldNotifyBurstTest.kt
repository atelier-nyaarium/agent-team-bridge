package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The full-notification (banner + TTS) gate for a team's burst: suppressed while the Activity is
 * visible, while notifications are otherwise unavailable, or while the team is muted (Closed and
 * not yet reopened). A never-opened team is not muted, so it still gets full treatment - only an
 * explicit Close does.
 *
 * Also covers the burst-granularity rule: the gate takes only (visibility, permission, team), never
 * a per-entry kind, so a burst mixing a peer-mirror entry with a genuine to-user entry for the same
 * team can never be partially suppressed - there is no code path for that split to exist.
 *
 * Pure function tests, no Android context (no Robolectric).
 */
class ShouldNotifyBurstTest {
	private val team = "alice.sakura.coollib.main"

	@Test
	fun firesWhenBackgroundedNotifiableAndUnmuted() {
		// Also stands in for "never opened" and for a burst mixing a peer-mirror entry with a
		// real to-user entry - see the class doc for why both collapse to this same case.
		assertTrue(shouldNotifyBurst(isVisible = false, canNotify = true, closedTeams = emptySet(), team = team))
	}

	@Test
	fun suppressedWhileTheActivityIsVisible() {
		assertFalse(shouldNotifyBurst(isVisible = true, canNotify = true, closedTeams = emptySet(), team = team))
	}

	@Test
	fun suppressedWhenNotificationsAreUnavailable() {
		assertFalse(shouldNotifyBurst(isVisible = false, canNotify = false, closedTeams = emptySet(), team = team))
	}

	@Test
	fun anExplicitlyClosedTeamIsSuppressed() {
		assertFalse(shouldNotifyBurst(isVisible = false, canNotify = true, closedTeams = setOf(team), team = team))
	}

	@Test
	fun closingADifferentTeamDoesNotMuteThisOne() {
		assertTrue(shouldNotifyBurst(isVisible = false, canNotify = true, closedTeams = setOf("alice.sakura.other.main"), team = team))
	}
}
