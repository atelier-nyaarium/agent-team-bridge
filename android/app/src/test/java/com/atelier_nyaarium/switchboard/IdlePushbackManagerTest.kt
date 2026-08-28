package com.atelier_nyaarium.switchboard

import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure function + state-machine tests for the idle pushback ladder (tierFor, nextAlignedMark,
 * IdlePushbackManager.decide). No Android context (no Robolectric) - IdlePushbackManager takes
 * IdleSilenceStore, not the concrete AppStateStore, for exactly this reason.
 */
class IdlePushbackManagerTest {

	// ---- tierFor: only the exact-equal boundary distinguishes a < off-by-one from <= ----

	@Test
	fun tierForBoundaries() {
		assertEquals(PollTier.FOREGROUND, tierFor(foreground = true, silenceMs = 0, watchedWorking = false))
		assertEquals(PollTier.FOREGROUND, tierFor(foreground = true, silenceMs = Long.MAX_VALUE, watchedWorking = false))

		assertEquals(PollTier.MINUTE, tierFor(foreground = false, silenceMs = 599_999, watchedWorking = false))
		assertEquals(PollTier.HALF_HOUR, tierFor(foreground = false, silenceMs = 600_000, watchedWorking = false))

		assertEquals(PollTier.HALF_HOUR, tierFor(foreground = false, silenceMs = 35_999_999, watchedWorking = false))
		assertEquals(PollTier.HOURLY, tierFor(foreground = false, silenceMs = 36_000_000, watchedWorking = false))

		assertEquals(PollTier.HOURLY, tierFor(foreground = false, silenceMs = 172_799_999, watchedWorking = false))
		assertEquals(PollTier.TWELVE_HOUR, tierFor(foreground = false, silenceMs = 172_800_000, watchedWorking = false))
	}

	// ---- the watched-working cap ----

	/**
	 * The silence clock measures MAIL, and a working session sends none until it finishes - so the
	 * ladder would descend through exactly the stretch its owner most wants reported. An open tab is
	 * a declaration of interest; a session working under one holds the cadence at the top of the
	 * ladder for as long as the work runs.
	 */
	@Test
	fun watchedWorkingCapsEveryDeepTier() {
		for (silence in listOf(600_000L, 36_000_000L, 172_800_000L, Long.MAX_VALUE)) {
			assertEquals(
				"silence=$silence must cap at MINUTE while a watched session works",
				PollTier.MINUTE,
				tierFor(foreground = false, silenceMs = silence, watchedWorking = true),
			)
		}
	}

	// A CAP, never an override. It may only make the cadence faster, so the two tiers already at or
	// above it are untouched - foreground especially, which must keep chaining long-polls.
	@Test
	fun theCapNeverSlowsATierDown() {
		assertEquals(PollTier.FOREGROUND, tierFor(foreground = true, silenceMs = 0, watchedWorking = true))
		assertEquals(PollTier.FOREGROUND, tierFor(foreground = true, silenceMs = Long.MAX_VALUE, watchedWorking = true))
		assertEquals(PollTier.MINUTE, tierFor(foreground = false, silenceMs = 0, watchedWorking = true))
	}

	// Nothing sticky: the cap stops applying the moment the work does, and the ladder resumes from
	// wherever the silence clock had already got to rather than restarting from the top.
	@Test
	fun theCapLiftsItselfWhenTheWorkStops() {
		assertEquals(PollTier.MINUTE, tierFor(foreground = false, silenceMs = 172_800_000, watchedWorking = true))
		assertEquals(PollTier.TWELVE_HOUR, tierFor(foreground = false, silenceMs = 172_800_000, watchedWorking = false))
	}

	// The whole point, at the level the poll loop actually asks: a deep-tier silence that would have
	// parked on an alarm becomes a kickable one-minute wait instead, with the wakelock held.
	@Test
	fun aWatchedWorkingSessionKeepsTheLoopOutOfDeepSleep() {
		val (mgr, _) = manager(hydrateNow = 0L)
		val parked = mgr.decide(now = 600_000L, visible = false, lastPassFailed = false, watchedWorking = false)
		assertTrue("without the cap this silence parks on an alarm", parked is PollWait.Alarm)

		val held = mgr.decide(now = 600_000L, visible = false, lastPassFailed = false, watchedWorking = true)
		assertEquals(PollWait.Delay(60_000L), held)
	}

	// ---- nextAlignedMark ----

	private val utc = ZoneId.of("UTC")

	private fun millisAt(iso: String): Long = ZonedDateTime.parse(iso).toInstant().toEpochMilli()

	@Test
	fun halfHourMark() {
		assertEquals(
			millisAt("2026-01-05T12:30:00Z"),
			nextAlignedMark(millisAt("2026-01-05T12:03:00Z"), PollTier.HALF_HOUR, utc),
		)
		// Exactly on a mark: strictly future, so the NEXT one - the state a deep wakeup re-enters
		// decide() at.
		assertEquals(
			millisAt("2026-01-05T13:00:00Z"),
			nextAlignedMark(millisAt("2026-01-05T12:30:00Z"), PollTier.HALF_HOUR, utc),
		)
	}

	@Test
	fun hourlyMark() {
		assertEquals(
			millisAt("2026-01-05T13:00:00Z"),
			nextAlignedMark(millisAt("2026-01-05T12:59:00Z"), PollTier.HOURLY, utc),
		)
		assertEquals(
			millisAt("2026-01-05T14:00:00Z"),
			nextAlignedMark(millisAt("2026-01-05T13:00:00Z"), PollTier.HOURLY, utc),
		)
	}

	@Test
	fun twelveHourMark() {
		assertEquals(
			millisAt("2026-01-05T08:00:00Z"),
			nextAlignedMark(millisAt("2026-01-05T07:00:00Z"), PollTier.TWELVE_HOUR, utc),
		)
		assertEquals(
			millisAt("2026-01-05T20:00:00Z"),
			nextAlignedMark(millisAt("2026-01-05T09:00:00Z"), PollTier.TWELVE_HOUR, utc),
		)
		assertEquals(
			millisAt("2026-01-06T08:00:00Z"),
			nextAlignedMark(millisAt("2026-01-05T21:00:00Z"), PollTier.TWELVE_HOUR, utc),
		)
		assertEquals(
			millisAt("2026-01-05T20:00:00Z"),
			nextAlignedMark(millisAt("2026-01-05T08:00:00Z"), PollTier.TWELVE_HOUR, utc),
		)
		assertEquals(
			millisAt("2026-01-06T08:00:00Z"),
			nextAlignedMark(millisAt("2026-01-05T20:00:00Z"), PollTier.TWELVE_HOUR, utc),
		)
	}

	@Test
	fun dstSpringForwardNightStaysValidAndStrictlyFuture() {
		// US spring-forward 2026: 2026-03-08 02:00 local -> 03:00 (the 2 o'clock hour does not exist).
		val laZone = ZoneId.of("America/Los_Angeles")
		val before = millisAt("2026-03-08T01:15:00-08:00")
		val mark = nextAlignedMark(before, PollTier.HALF_HOUR, laZone)
		assertTrue("mark must be strictly future", mark > before)
	}

	@Test
	fun dstSpringForwardResolvesWhenTheWinningCandidateItselfLandsInTheGap() {
		// From 01:45, the earlier HALF_HOUR candidate (01:30) already failed the strictly-future
		// filter, so only top.plusHours(1) - a nominal 02:00, inside the gap - survives to win.
		// Unlike the test above, the SELECTED mark itself is the gap-adjacent one here.
		val laZone = ZoneId.of("America/Los_Angeles")
		val before = millisAt("2026-03-08T01:45:00-08:00")
		val mark = nextAlignedMark(before, PollTier.HALF_HOUR, laZone)
		assertEquals(millisAt("2026-03-08T03:00:00-07:00"), mark)
	}

	@Test
	fun dstFallBackNightStaysValidAndStrictlyFuture() {
		// US fall-back 2026: 2026-11-01 02:00 local -> 01:00 (the 1-2 AM hour repeats).
		val laZone = ZoneId.of("America/Los_Angeles")
		val before = millisAt("2026-11-01T00:45:00-07:00")
		val mark = nextAlignedMark(before, PollTier.HALF_HOUR, laZone)
		assertTrue("mark must be strictly future", mark > before)
	}

	@Test
	fun nonIntegerOffsetZoneStillLandsCleanlyOnTheMark() {
		// Asia/Kolkata is UTC+5:30 year-round (no DST) - a classic trap for hour-truncation math.
		val kolkata = ZoneId.of("Asia/Kolkata")
		assertEquals(
			millisAt("2026-01-05T08:00:00+05:30"),
			nextAlignedMark(millisAt("2026-01-05T07:00:00+05:30"), PollTier.TWELVE_HOUR, kolkata),
		)
	}

	// ---- IdlePushbackManager state machine ----

	private class FakeStore(initial: Long? = null) : IdleSilenceStore {
		var value: Long? = initial

		override fun loadIdleSilenceStart(): Long? = value

		override fun saveIdleSilenceStart(v: Long) {
			value = v
		}
	}

	private class RecordingScheduler : DeepIdleScheduler {
		var deepSleepAt: Long? = null
		var heldPassMs: Long? = null
		var exitedDeepSleep = false

		override fun enterDeepSleep(wakeAtMillis: Long) {
			deepSleepAt = wakeAtMillis
			heldPassMs = null
			exitedDeepSleep = false
		}

		override fun holdPass(ms: Long) {
			heldPassMs = ms
			deepSleepAt = null
			exitedDeepSleep = false
		}

		override fun exitDeepSleep() {
			exitedDeepSleep = true
			deepSleepAt = null
			heldPassMs = null
		}
	}

	private fun manager(store: IdleSilenceStore = FakeStore(), hydrateNow: Long = 0L): Pair<IdlePushbackManager, RecordingScheduler> {
		val mgr = IdlePushbackManager(store, hydrateNow) { utc }
		val scheduler = RecordingScheduler()
		mgr.scheduler = scheduler
		return mgr to scheduler
	}

	@Test
	fun foregroundAlwaysChainsAndExitsDeepSleep() {
		val (mgr, scheduler) = manager()
		val wait = mgr.decide(now = 100_000L, visible = true, lastPassFailed = false, watchedWorking = false)
		assertEquals(PollWait.Chain, wait)
		assertTrue(scheduler.exitedDeepSleep)
	}

	@Test
	fun freshlyBackgroundedIsMinute() {
		val (mgr, scheduler) = manager()
		mgr.onBackground(1_000L)
		val wait = mgr.decide(now = 1_000L, visible = false, lastPassFailed = false, watchedWorking = false)
		assertEquals(PollWait.Delay(60_000L), wait)
		assertTrue(scheduler.exitedDeepSleep)
	}

	@Test
	fun tenMinutesSilentSchedulesAnAlarm() {
		val (mgr, scheduler) = manager()
		mgr.onBackground(0L)
		val wait = mgr.decide(now = 600_000L, visible = false, lastPassFailed = false, watchedWorking = false)
		assertTrue(wait is PollWait.Alarm)
		assertEquals((wait as PollWait.Alarm).atMillis, scheduler.deepSleepAt)
	}

	@Test
	fun tenHoursSilentLandsOnATopOfHourMark() {
		val (mgr, _) = manager()
		mgr.onBackground(0L)
		val wait = mgr.decide(now = 10 * 3_600_000L, visible = false, lastPassFailed = false, watchedWorking = false) as PollWait.Alarm
		val landed = Instant.ofEpochMilli(wait.atMillis).atZone(utc)
		assertEquals("decide() must hand nextAlignedMark the HOURLY tier, not a HALF_HOUR guess", 0, landed.minute)
	}

	@Test
	fun fortyEightHoursSilentLandsOnAnEightOrTwentyMark() {
		val (mgr, _) = manager()
		mgr.onBackground(0L)
		val wait = mgr.decide(now = 48 * 3_600_000L, visible = false, lastPassFailed = false, watchedWorking = false) as PollWait.Alarm
		val landed = Instant.ofEpochMilli(wait.atMillis).atZone(utc)
		assertTrue("decide() must hand nextAlignedMark the TWELVE_HOUR tier", landed.hour == 8 || landed.hour == 20)
	}

	@Test
	fun deepFailureRetriesOnceThenAlarmsThenRetriesAgainAtTheNextMark() {
		val (mgr, scheduler) = manager()
		mgr.onBackground(0L)

		val first = mgr.decide(now = 600_000L, visible = false, lastPassFailed = true, watchedWorking = false)
		assertEquals(PollWait.Delay(60_000L), first)
		// Pins the DERIVATION, not a coincidental literal: this exact relationship (DEEP_RETRY_MS's
		// wait consuming part of the held budget, PASS_GRACE_MS covering the rest) must hold, since
		// PASS_GRACE_MS falling below BURST_JOIN_TIMEOUT_MS would leave too little of the held budget for
		// a retry pass's own worst-case join. A change to any of these three constants now fails this
		// assertion instead of passing silently.
		assertEquals(DEEP_RETRY_MS + PASS_GRACE_MS, scheduler.heldPassMs)
		assertTrue("the retry grace must cover the retry pass's own worst-case join", PASS_GRACE_MS >= BURST_JOIN_TIMEOUT_MS)
		assertTrue("the initial pass-lock acquisition must itself cover at least one worst-case join", PASS_TIMEOUT_MS >= BURST_JOIN_TIMEOUT_MS)

		val second = mgr.decide(now = 660_000L, visible = false, lastPassFailed = true, watchedWorking = false)
		assertTrue("the budget is consumed: a second consecutive failure schedules the alarm, not another retry", second is PollWait.Alarm)

		// A LATER mark's own failure must get its own fresh retry budget, not find it exhausted.
		val third = mgr.decide(now = (second as PollWait.Alarm).atMillis, visible = false, lastPassFailed = true, watchedWorking = false)
		assertEquals("the retry budget resets per mark, not just once", PollWait.Delay(60_000L), third)
	}

	@Test
	fun commsActivityAtADeepMarkResetsToMinute() {
		val (mgr, _) = manager()
		mgr.onBackground(0L)
		mgr.onCommsActivity(600_000L, visible = false)
		val wait = mgr.decide(now = 600_000L, visible = false, lastPassFailed = false, watchedWorking = false)
		assertEquals(PollWait.Delay(60_000L), wait)
	}

	@Test
	fun hydrateClampsAFuturePersistedTimestampToTheShallowestTier() {
		// A persisted value AFTER hydrateNow (a clock rolled backward) clamps to hydrateNow rather
		// than being preserved as-is. Evaluated well past the MINUTE boundary so the clamped and
		// unclamped paths actually diverge into different tiers: clamped, silenceStartAt=5_000 ->
		// silence=600_001 -> HALF_HOUR/Alarm. Unclamped (silenceStartAt=10_000, the persisted
		// value) -> silence=595_001 -> still MINUTE/Delay, which would pass a same-tier assertion
		// without ever exercising the clamp - checking at now == hydrateNow could not tell the two
		// apart at all.
		val (mgr, _) = manager(store = FakeStore(initial = 10_000L), hydrateNow = 5_000L)
		val wait = mgr.decide(now = 5_000L + 600_001L, visible = false, lastPassFailed = false, watchedWorking = false)
		assertTrue("the clamp must land this in a deep tier, not MINUTE", wait is PollWait.Alarm)
	}

	@Test
	fun hydrateFromAnAbsentStoreStartsAtMinuteNotTwelveHour() {
		// A never-persisted store (fresh install, or a headless post-reboot revival before the
		// first background transition) must default to "just active", not "silent since the epoch".
		val hydrateNow = 1_700_000_000_000L
		val (mgr, _) = manager(store = FakeStore(initial = null), hydrateNow = hydrateNow)
		val wait = mgr.decide(now = hydrateNow, visible = false, lastPassFailed = false, watchedWorking = false)
		assertEquals(PollWait.Delay(60_000L), wait)
	}
}
