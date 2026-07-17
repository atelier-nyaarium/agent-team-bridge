package com.atelier_nyaarium.switchboard

import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit

private const val MINUTE_MS = 60_000L
internal const val DEEP_RETRY_MS = 60_000L
private const val SILENCE_MINUTE_MAX_MS = 10 * 60_000L
private const val SILENCE_HALF_HOUR_MAX_MS = 10 * 3_600_000L
private const val SILENCE_HOURLY_MAX_MS = 48 * 3_600_000L

// The deep-tier pass-lock budget, as ONE derivation instead of three independently-edited
// literals spread across this file, ChatRepository.kt, and PollAlarmReceiver.kt - that split
// already let the budget drift out of its own required ordering once (a pass-lock hold shorter
// than the join it was meant to cover), caught only by tracing the actual numbers, not by the
// comments that were supposed to keep them in sync. BURST_JOIN_TIMEOUT_MS is the one root
// quantity every other constant here derives from.
internal const val BURST_JOIN_TIMEOUT_MS = 60_000L // ChatRepository's burstJobs.joinAll() bound
private const val PASS_OVERHEAD_MS = 15_000L // poll round trip + drain + decide, beyond the join
private const val PASS_RUNTIME_MS = BURST_JOIN_TIMEOUT_MS + PASS_OVERHEAD_MS

// Must be >= PASS_RUNTIME_MS: this is what decide() adds to DEEP_RETRY_MS when re-arming the
// pass lock for a retry (see decide() below), so it has to cover the retry pass's OWN worst-case
// join, not just a flat margin that can silently fall short of BURST_JOIN_TIMEOUT_MS again.
internal const val PASS_GRACE_MS = PASS_RUNTIME_MS

// PollAlarmReceiver's initial pass-lock acquisition at alarm-fire: revival overhead (service
// start + kickPoll + poll-loop resume) plus one full pass's worst-case runtime.
private const val REVIVAL_OVERHEAD_MS = 15_000L
internal const val PASS_TIMEOUT_MS = REVIVAL_OVERHEAD_MS + PASS_RUNTIME_MS

/** How the console's background poll cadence backs off the longer it stays silent. */
enum class PollTier { FOREGROUND, MINUTE, HALF_HOUR, HOURLY, TWELVE_HOUR }

/** What the poll loop should do after a pass. */
sealed interface PollWait {
	/** Foreground: chain long-polls (interval 0; a 5s backoff on failure/held-empty is the
	 * caller's own concern). */
	data object Chain : PollWait

	/** A kickable coroutine wait: the MINUTE tier's plain 60s cadence, or a deep tier's one
	 * bounded retry (also 60s). */
	data class Delay(val ms: Long) : PollWait

	/** Deep idle: an AlarmManager wakeup is scheduled at [atMillis] and every lock is released;
	 * the loop parks until the alarm (or a foreground/forget kick) wakes it. */
	data class Alarm(val atMillis: Long) : PollWait
}

/** The service-owned side effects a deep-tier decision drives (alarms + wakelocks). Kept behind
 * an interface so [IdlePushbackManager.decide] stays unit-testable without Android. */
interface DeepIdleScheduler {
	/** Entering a deep tier: schedule the aligned wakeup and release every lock. */
	fun enterDeepSleep(wakeAtMillis: Long)

	/** A deep tier's one retry: keep the CPU up just long enough for the retry pass. */
	fun holdPass(ms: Long)

	/** Foreground or MINUTE: cancel any pending alarm and hold the indefinite active-tier lock. */
	fun exitDeepSleep()
}

/** The idle pushback manager's persistence seam. Narrow on purpose - [AppStateStore] is a
 * final, Context/Keystore-backed class with no mocking library or Robolectric on this project's
 * test classpath, so [IdlePushbackManager] cannot take it directly if its own state-machine
 * tests are to stay pure JUnit. [AppStateStore] implements this; a test fake is a few lines of
 * in-memory storage. */
interface IdleSilenceStore {
	fun loadIdleSilenceStart(): Long?

	fun saveIdleSilenceStart(v: Long)
}

/**
 * Decides the console's background poll wait after each pass, tiered by how long it has been
 * silent (backgrounded with no fresh mailbox activity), and drives the deep-tier alarm/wakelock
 * side effects through [scheduler]. FOREGROUND and MINUTE are a kickable coroutine delay with the
 * wakelock held throughout; HALF_HOUR/HOURLY/TWELVE_HOUR release the wakelock and schedule a
 * wall-clock-aligned `AlarmManager` wakeup instead, so a long silent background stint stops
 * costing continuous CPU wake time. Full design + audit trail: plans/idle-pushback-manager.md.
 */
class IdlePushbackManager(
	private val store: IdleSilenceStore,
	hydrateNow: Long,
	private val zone: () -> ZoneId,
) {
	/** Wired by the owning service, mirroring how `ChatRepository.onInbound` is wired. */
	@Volatile var scheduler: DeepIdleScheduler? = null

	// Absent key -> hydrateNow, not 0L: an unset store would otherwise read as "silent since the
	// epoch" and wedge a fresh install straight into TWELVE_HOUR.
	// A persisted FUTURE value also clamps to hydrateNow - not to guard deep idle, but so a
	// backward clock jump does not strand the app in the expensive MINUTE tier.
	@Volatile private var silenceStartAt = minOf(store.loadIdleSilenceStart() ?: hydrateNow, hydrateNow)
	@Volatile private var deepRetryUsed = false

	fun onBackground(now: Long) = resetSilence(now)

	/** Called with `now` when a poll pass drained at least one genuinely-fresh mailbox entry.
	 * No-ops while `visible`: [onBackground]'s own unconditional reset is always the later write
	 * once backgrounding happens, so skipping the reset (and its disk write) here never loses it. */
	fun onCommsActivity(now: Long, visible: Boolean) {
		if (!visible) resetSilence(now)
	}

	private fun resetSilence(now: Long) {
		silenceStartAt = now
		deepRetryUsed = false
		store.saveIdleSilenceStart(now)
	}

	/** After every poll pass: pick the wait and apply its scheduler side effects. `visible` is
	 * `ChatRepository`'s own foreground flag, passed in rather than duplicated on this manager -
	 * a separate manager-side field written by a second, non-atomic @Volatile store could
	 * transiently disagree with it. */
	fun decide(now: Long, visible: Boolean, lastPassFailed: Boolean): PollWait {
		// Snapshot the tier ONCE: silenceStartAt is @Volatile and can change mid-decide from the
		// main thread (onBackground). Reading it twice risked the deep branch handing
		// nextAlignedMark a tier its own first read never chose.
		val tier = tierFor(visible, now - silenceStartAt)
		val wait = when (tier) {
			PollTier.FOREGROUND -> PollWait.Chain
			PollTier.MINUTE -> PollWait.Delay(MINUTE_MS)
			else ->
				if (lastPassFailed && !deepRetryUsed) {
					deepRetryUsed = true
					PollWait.Delay(DEEP_RETRY_MS)
				} else {
					deepRetryUsed = false
					PollWait.Alarm(nextAlignedMark(now, tier, zone()))
				}
		}
		when (wait) {
			is PollWait.Alarm -> scheduler?.enterDeepSleep(wait.atMillis)
			// A Delay is either MINUTE's plain wait or a deep tier's one retry - tier (captured
			// once above) tells them apart rather than a second flag.
			is PollWait.Delay -> if (tier == PollTier.MINUTE) scheduler?.exitDeepSleep() else scheduler?.holdPass(wait.ms + PASS_GRACE_MS)
			PollWait.Chain -> scheduler?.exitDeepSleep()
		}
		return wait
	}
}

/** Which cadence tier applies right now. Pure, top-level, unit-tested without Android - the
 * `filterTombstoned` pattern. */
internal fun tierFor(foreground: Boolean, silenceMs: Long): PollTier = when {
	foreground -> PollTier.FOREGROUND
	silenceMs < SILENCE_MINUTE_MAX_MS -> PollTier.MINUTE
	silenceMs < SILENCE_HALF_HOUR_MAX_MS -> PollTier.HALF_HOUR
	silenceMs < SILENCE_HOURLY_MAX_MS -> PollTier.HOURLY
	else -> PollTier.TWELVE_HOUR
}

/** The next strictly-future aligned wall-clock mark for a deep tier, in epoch millis
 * (`RTC_WAKEUP` domain). `ZonedDateTime` handles DST gaps/overlaps (java.time is native at
 * minSdk 33): a mark landing in a nonexistent local time resolves to the shifted valid instant,
 * so this never throws or returns a past instant across a transition - only that one mark's
 * wall-clock alignment is cosmetically off, self-correcting at the next mark. */
internal fun nextAlignedMark(nowMillis: Long, tier: PollTier, zone: ZoneId): Long {
	val now = Instant.ofEpochMilli(nowMillis).atZone(zone)
	val top = now.truncatedTo(ChronoUnit.HOURS)
	val candidates = when (tier) {
		PollTier.HALF_HOUR -> listOf(top.plusMinutes(30), top.plusHours(1))
		PollTier.HOURLY -> listOf(top.plusHours(1))
		PollTier.TWELVE_HOUR ->
			listOf(now.toLocalDate(), now.toLocalDate().plusDays(1)).flatMap { day ->
				listOf(8, 20).map { hour -> ZonedDateTime.of(day, LocalTime.of(hour, 0), zone) }
			}
		// Unreachable in practice: decide() snapshots the tier once and only ever calls this
		// from the branch that already excludes FOREGROUND/MINUTE. Kept as a defensive backstop.
		else -> error("no alignment for $tier")
	}
	return candidates.map { it.toInstant().toEpochMilli() }.filter { it > nowMillis }.min()
}
