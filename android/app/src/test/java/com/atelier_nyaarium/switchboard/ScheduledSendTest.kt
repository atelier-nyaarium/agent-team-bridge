package com.atelier_nyaarium.switchboard

import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure function tests for Scheduled Send's countdown/absolute-time formatting and its notification
 * request-code/id hash functions. No Android context (no Robolectric) - the same reason
 * IdlePushbackManagerTest exists for tierFor/nextAlignedMark.
 */
class ScheduledSendTest {

	// ---- countdownText: coarsest-unit-first, boundary at each unit rollover ----

	@Test
	fun countdownTextBoundaries() {
		assertEquals("in less than a minute", countdownText(0))
		assertEquals("in less than a minute", countdownText(59_999))
		// Overdue (negative remaining, e.g. a due-or-past record not yet swept) reads the same as
		// "less than a minute" rather than a nonsensical negative count.
		assertEquals("in less than a minute", countdownText(-60_000))
		assertEquals("in 1m", countdownText(60_000))
		assertEquals("in 59m", countdownText(59 * 60_000L))
		assertEquals("in 1h 0m", countdownText(60 * 60_000L))
		assertEquals("in 1h 30m", countdownText(90 * 60_000L))
		assertEquals("in 23h 59m", countdownText((24 * 60 - 1) * 60_000L))
		assertEquals("in 1d 0h", countdownText(24 * 60 * 60_000L))
		assertEquals("in 2d 3h", countdownText((2 * 24 * 60 + 3 * 60) * 60_000L))
	}

	// ---- absoluteTimeText: same-day (bare time) vs a different day (dated) ----

	private val utc = ZoneId.of("UTC")

	private fun millisAt(iso: String): Long = ZonedDateTime.parse(iso).toInstant().toEpochMilli()

	@Test
	fun absoluteTimeTextSameDayIsBareTime() {
		// absoluteTimeText compares against LocalDate.now(zone), so this only holds when run on the
		// same calendar day as "now" in the given zone - pin it against a fixed instant close to
		// system time by formatting "now" itself, which is always "today" by construction.
		val now = System.currentTimeMillis()
		val text = absoluteTimeText(now, ZoneId.systemDefault())
		assertTrue("expected bare HH:mm for today, got: $text", text.matches(Regex("\\d{2}:\\d{2}")))
	}

	@Test
	fun absoluteTimeTextDifferentDayIsDated() {
		// A fixed instant far from "now" in either direction is never "today" regardless of when
		// this test runs.
		val text = absoluteTimeText(millisAt("2020-06-15T14:30:00Z"), utc)
		assertEquals("Jun 15, 14:30", text)
	}

	// ---- scheduledSendRetryRc / scheduledSendFailedNotificationId: deterministic, land in their
	// declared ranges, and distinguish inputs that must not collide in practice ----

	@Test
	fun retryRcIsDeterministic() {
		assertEquals(
			SwitchboardService.scheduledSendRetryRc("team-a", "op-1"),
			SwitchboardService.scheduledSendRetryRc("team-a", "op-1"),
		)
	}

	@Test
	fun retryRcDistinguishesSameTeamDifferentOpId() {
		// The exact case the round-1 audit fix exists for: two sequential failures for the SAME team
		// (a fresh schedule reuses the team the moment the prior one fires) must not hash to the same
		// request code, or the second retry's arm silently replaces the first's.
		assertNotEquals(
			SwitchboardService.scheduledSendRetryRc("team-a", "op-1"),
			SwitchboardService.scheduledSendRetryRc("team-a", "op-2"),
		)
	}

	@Test
	fun retryRcLandsInDeclaredRange() {
		val rc = SwitchboardService.scheduledSendRetryRc("some.team.address.here", "some-op-id")
		assertTrue(rc >= SwitchboardService.SCHEDULED_SEND_RETRY_RC_START)
		assertTrue(rc < SwitchboardService.SCHEDULED_SEND_RETRY_RC_START + SwitchboardService.SCHEDULED_SEND_RETRY_RC_SIZE)
	}

	@Test
	fun failedNotificationIdIsDeterministic() {
		assertEquals(
			SwitchboardService.scheduledSendFailedNotificationId("team-a"),
			SwitchboardService.scheduledSendFailedNotificationId("team-a"),
		)
	}

	@Test
	fun failedNotificationIdDistinguishesDifferentTeams() {
		// Not a formal collision-freedom proof (it is a hash into a bounded range) - just confirms two
		// ordinary, differently-named teams do not land on the same id, the common case the red-team
		// finding's "two teams fail together" scenario depends on actually being independent.
		assertNotEquals(
			SwitchboardService.scheduledSendFailedNotificationId("teamA"),
			SwitchboardService.scheduledSendFailedNotificationId("teamB"),
		)
	}

	@Test
	fun failedNotificationIdLandsInDeclaredRange() {
		val id = SwitchboardService.scheduledSendFailedNotificationId("some.team.address.here")
		assertTrue(id >= SwitchboardService.SCHEDULED_SEND_FAILED_ID_RANGE_START)
		assertTrue(id < SwitchboardService.SCHEDULED_SEND_FAILED_ID_RANGE_START + SwitchboardService.SCHEDULED_SEND_FAILED_ID_RANGE_SIZE)
	}
}
