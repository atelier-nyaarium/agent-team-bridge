# Idle Pushback Manager (console poll cadence)

Battery: the console's background polling never backs off. This adds a tiered idle pushback
ladder to the poll cadence so a silent, backgrounded app polls progressively less often,
aligned to wall-clock marks.

## User spec

- Foreground: current fast behavior is correct for an actively used app.
- Backgrounded (minimized or screen off): poll every minute until comms are dead silent.
- After a minimum of 10 minutes of BOTH not-foreground and comm silence: push to every
  30 minutes, aligned to the wall-clock :00/:30 marks (the 10 may stretch to reach a mark).
- After 10 hours: hourly, aligned to the top of the hour.
- After 2 days: every 12 hours, aligned to 8am and 8pm.

## Current state (facts, from code)

- `ChatRepository.startPolling` (ChatRepository.kt:2761): one loop, cadence at the bottom:
  - Visible: server-held long-poll, `LONG_POLL_HOLD_MS = 40_000` (under the gateway's 45s cap),
    chained back-to-back (interval 0); failure or held-empty backs off to `POLL_INTERVAL_MS = 5_000`.
  - Not visible: plain poll (hold=0), then `AFK_POLL_INTERVAL_MS = 60_000`.
  - The wait is `withTimeoutOrNull(interval) { kick.receive() }` - a CONFLATED `kick` channel
    interrupts it (kicked by `onForeground()` and forget-success).
  - Teams refresh piggybacks on the loop at most every `TEAMS_REFRESH_MS = 30_000`.
- Visibility: Activity ON_START/ON_STOP drive `repo.onForeground()`/`onBackground()`
  (MainActivity.kt:336). ON_STOP covers both minimize and screen-off.
- `SwitchboardService` holds a `PARTIAL_WAKE_LOCK` for the poll loop's entire lifetime
  (SwitchboardService.kt:60) so the loop's sleeps fire through Doze; Doze still gates NETWORK
  unless the battery-optimization exemption is granted (Settings row exists).
- Manifest already has WAKE_LOCK, RECEIVE_BOOT_COMPLETED, REQUEST_IGNORE_BATTERY_OPTIMIZATIONS;
  no exact-alarm permission yet. `BootReceiver` restarts the service on boot.

## Questionaire

**1. How do the deep tiers (30 min / 1 h / 12 h) sleep?**

**A) AlarmManager wakeups, wakelock released in deep tiers.** Foreground + 1-min tiers keep
today's loop and wakelock. Entering the 30-min tier: release the wakelock, schedule an
exact-while-idle alarm at the next aligned mark; alarm fires -> short timeout'd wakelock ->
one poll pass -> reschedule -> CPU back to deep sleep.

Recommendation reason (chosen): held forever, the wakelock keeps the CPU from deep sleep -
over a long idle that costs more than the 1-min radio pings, so lengthening sleeps alone
(option B) saves radio only. Wall-clock-aligned marks are what AlarmManager is for, and
exact-while-idle alarms get a brief network window even without the battery exemption.

**2. What counts as "comms" (resets the silence clock back to the 1-min tier)?**

**A) Any genuinely-fresh mailbox entry** - messages, notices, peer mirrors, own-send mirrors
from other devices, plugin actions. Applies at deep tiers too: a 30-min poll that finds mail
resets silence to now and drops back to per-minute. Status flapping (`teams()` changes) never
counts - only mailbox content.

Recommendation reason (chosen): simplest (one hook where the drain already knows fresh vs
re-delivered), every entry kind is deliberate activity, and faithful to "until the agents stop
talking". Tightening later is a one-line change at the same hook.

**3. Does the ladder survive process death and reboot?**

**A) Persist the silence clock** (one timestamp in the existing app state store, written only
when it changes). Restart resumes the tier; one immediate poll on any restart self-corrects
(mail found resets silence per Q2).

Recommendation reason (chosen), corrected per Audit #5: a REBOOT clears every scheduled alarm
and all in-memory state; `BootReceiver` then starts the service fresh with nothing to resume
from except what was persisted, so without this the ladder would re-climb from MINUTE after
every reboot (and the rarer genuine hard kill) - defeating the feature in its target scenario.
(Not, as first written here, "releasing the wakelock makes the process killable" - a
`PowerManager.WakeLock` gates CPU/SoC suspend, not process eviction; the service's own
foreground-service type is what keeps the process resident regardless of any wakelock, and nothing
in this plan tears it down in any tier. Left as PLAUSIBLE rather than fully confirmed only on the
version-specific claim that this foreground-service type is immune to the newer Android FGS
runtime timeout - the core point, that a wakelock is not what keeps a process alive, is solid.)
The write happens at activity moments, when battery does not matter anyway.

**4. A deep-mark poll fails. Then what?**

**A) One retry 60s later, then wait for the next mark.** A transient blip costs one extra
wakeup; a dead network costs one extra wakeup per mark. Failures never touch the silence
clock (a failed poll is not comms).

Recommendation reason (chosen): bounded and negligible cost, caps the blip penalty at one
tier interval. Retry-until-success would reintroduce the always-on drain exactly when the
radio is weakest (dead zones burn the most power hunting signal).

## Plan

### Tier ladder

silence = `now - silenceStartAt`, where `silenceStartAt` = the later of (last backgrounded,
last genuinely-fresh mailbox entry). Evaluated after every poll pass.

| Tier | Condition | Cadence | Sleep mechanism | CPU lock |
|---|---|---|---|---|
| FOREGROUND | activity visible | chained 40s long-polls (5s backoff on failure/held-empty) - unchanged | coroutine | held |
| MINUTE | silence < 10 min | plain poll every 60s - today's AFK behavior | kickable coroutine delay | held |
| HALF_HOUR | 10 min <= silence < 10 h | next wall-clock :00 / :30 | exact-while-idle alarm | released |
| HOURLY | 10 h <= silence < 48 h | next wall-clock :00 | alarm | released |
| TWELVE_HOUR | silence >= 48 h | next 08:00 / 20:00 local | alarm | released |

Marks are strictly future ("the 10 may be more to reach a mark" falls out naturally: eligible
at 12:13 means the first pushed poll lands at 12:30). Reaching a deeper threshold just changes
which mark family the NEXT schedule picks. Fresh mail found at any mark resets silence to now,
dropping straight back to MINUTE (and notifications fire as today).

### `IdlePushbackManager.kt` (as shipped - this section now documents the real file, not pseudocode)

The trailing `// ...` comments on the constants below are illustrative for this doc; the shipped
source omits them (the names are self-descriptive enough on their own).

```kotlin
private const val MINUTE_MS = 60_000L
private const val DEEP_RETRY_MS = 60_000L
private const val SILENCE_MINUTE_MAX_MS = 10 * 60_000L   // 10 min -> HALF_HOUR
private const val SILENCE_HALF_HOUR_MAX_MS = 10 * 3_600_000L  // 10 h -> HOURLY
private const val SILENCE_HOURLY_MAX_MS = 48 * 3_600_000L     // 2 d -> TWELVE_HOUR
private const val PASS_GRACE_MS = 30_000L

enum class PollTier { FOREGROUND, MINUTE, HALF_HOUR, HOURLY, TWELVE_HOUR }

/** What the poll loop should do after a pass. */
sealed interface PollWait {
	data object Chain : PollWait
	data class Delay(val ms: Long) : PollWait
	data class Alarm(val atMillis: Long) : PollWait
}

/** Service-owned side effects (alarms + wakelocks). The manager drives it from decide(). */
interface DeepIdleScheduler {
	fun enterDeepSleep(wakeAtMillis: Long)
	fun holdPass(ms: Long)
	fun exitDeepSleep()
}

/** The persistence seam - narrow so a test fake needs no Context/Robolectric. AppStateStore
 * implements this; ChatRepository wires the real store in. */
interface IdleSilenceStore {
	fun loadIdleSilenceStart(): Long?
	fun saveIdleSilenceStart(v: Long)
}

class IdlePushbackManager(
	private val store: IdleSilenceStore,
	hydrateNow: Long,
	private val zone: () -> ZoneId,
) {
	@Volatile var scheduler: DeepIdleScheduler? = null   // wired by the service, like onInbound

	// Absent key -> hydrateNow, not 0L: an unset store would otherwise read as "silent since the
	// epoch" and wedge a fresh install straight into TWELVE_HOUR (Audit #1). A persisted FUTURE
	// value also clamps to hydrateNow - not to guard deep idle, but so a backward clock jump does
	// not strand the app in the expensive MINUTE tier (Audit #6). A value genuinely far in the
	// past is preserved as-is (minOf is then a no-op): a long real absence resumes the deep tier
	// it earned, per Q3.
	@Volatile private var silenceStartAt = minOf(store.loadIdleSilenceStart() ?: hydrateNow, hydrateNow)
	@Volatile private var deepRetryUsed = false           // one retry budget per mark (Q4)

	fun onBackground(now: Long) = resetSilence(now)

	/** Q2: called with now when a poll pass drained >=1 genuinely-fresh mailbox entry. No-ops
	 * while `visible`: onBackground's own unconditional reset is always the later write once
	 * backgrounding happens, so skipping the reset (and its disk write) here never loses it. */
	fun onCommsActivity(now: Long, visible: Boolean) {
		if (!visible) resetSilence(now)
	}

	private fun resetSilence(now: Long) {
		silenceStartAt = now
		deepRetryUsed = false
		store.saveIdleSilenceStart(now)                  // Q3: persisted on change only
	}

	/** After every poll pass: pick the wait AND apply its scheduler side effects. `visible` is
	 * ChatRepository's own foreground flag, passed in rather than duplicated on the manager - a
	 * separate manager-side field written by a second, non-atomic @Volatile store could
	 * transiently disagree with it (Audit #11). */
	fun decide(now: Long, visible: Boolean, lastPassFailed: Boolean): PollWait {
		// Snapshot the tier ONCE: silenceStartAt is @Volatile and can change mid-decide from the
		// main thread (onBackground). Reading it twice risked the deep branch handing
		// nextAlignedMark a tier its own first read never chose (Audit #4).
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

// Pure, top-level, unit-tested without Android (the filterTombstoned pattern). The tier/timing
// constants above are file-private top-level rather than a class companion object: the earlier
// draft put them in IdlePushbackManager's companion, which these top-level functions could not
// have referenced unqualified - this placement is what actually compiles.

internal fun tierFor(foreground: Boolean, silenceMs: Long): PollTier = when {
	foreground -> PollTier.FOREGROUND
	silenceMs < SILENCE_MINUTE_MAX_MS -> PollTier.MINUTE
	silenceMs < SILENCE_HALF_HOUR_MAX_MS -> PollTier.HALF_HOUR
	silenceMs < SILENCE_HOURLY_MAX_MS -> PollTier.HOURLY
	else -> PollTier.TWELVE_HOUR
}

/** Next strictly-future aligned mark for a deep tier, in epoch millis (RTC_WAKEUP domain).
 * `ZonedDateTime` handles DST gaps/overlaps (java.time is native at minSdk 33): a mark landing in
 * a nonexistent local time resolves to the shifted valid instant, so this never throws or returns
 * a past instant across a transition - only that one mark's wall-clock alignment is cosmetically
 * off, self-correcting at the next mark. */
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
		// from the branch that already excludes FOREGROUND/MINUTE (Audit #4). A defensive backstop.
		else -> error("no alignment for $tier")
	}
	return candidates.map { it.toInstant().toEpochMilli() }.filter { it > nowMillis }.min()
}
```

### `ChatRepository.kt` changes

- Own an `IdlePushbackManager` (hydrated from `AppStateStore`, which implements `IdleSilenceStore`);
  expose it to the service as a public `val`:
  `val pushback = IdlePushbackManager(store, System.currentTimeMillis()) { ZoneId.systemDefault() }`.
- `onBackground()` additionally calls `pushback.onBackground(now)` (it already exists).
  `onForeground()` needs NO manager call: `decide()` now reads the existing `visible` field
  directly (Audit #11), so there is nothing for the manager to separately track on the way back
  to foreground - `visible = true` already kicks the poll loop today, unchanged.
- Drain hook (Q2): in the poll pass, after `mailboxSync.advance(...)`:
  `if (adv.fresh.isNotEmpty()) pushback.onCommsActivity(System.currentTimeMillis(), visible)`.
- Burst-loop fix (Audit #3, required by this plan, not optional) - **shipped as `joinAll()`, not
  the "move onInbound out" mechanism originally drafted here**: `onInbound?.invoke(t, ms)` stays
  inside the STTS branch's `scope.launch(Dispatchers.IO) { ... }` exactly as before; each launched
  `Job` is instead collected into a `burstJobs` list, and `burstJobs.joinAll()` runs after
  `mailboxSync.commit(adv.next)` and before the tail `decide()` call. This closes the SAME race
  (a deep-tier pass releasing its lock can no longer cut the launched work off mid-flight) while
  ALSO protecting the STTS preload/auto-play path, not just the notification POST - the safer
  choice once the STTS product decision below was resolved to "keep unchanged, no staleness gate"
  rather than gate it away. Trade-off accepted deliberately: for a followed, STTS-eligible team,
  the poll loop's tail (including the decide() that computes the next wait) now waits on that
  team's synthesis/playback before proceeding, instead of firing it fully fire-and-forget. Most
  passes have an empty burst and skip this entirely; the rare one with real content is exactly the
  case worth waiting for.
- Product decision (Audit #3's second half), resolved: keep auto-play firing unchanged at every
  tier, no staleness gate. Deliberately not adding a subjective "too old to speak" cutoff; a
  deep-tier wakeup draining a genuinely out-of-nowhere message after real hours of silence is
  itself an unusual event, not a routine one this needs to guard against. The multi-team
  overlap case (SttsPlayer serializes on one executor, so several teams auto-playing from the
  same rare wakeup would cut each other off) is accepted on the same reasoning - equally rare,
  not worth solving for v1.
- Replace the tail interval computation:

```kotlin
// Superseded the old flat `interval = when { !visible -> AFK_POLL_INTERVAL_MS; ... }`.
when (val wait = pushback.decide(System.currentTimeMillis(), visible, failed)) {
	PollWait.Chain -> if (failed || heldEmpty) withTimeoutOrNull(POLL_INTERVAL_MS) { kick.receive() }
	is PollWait.Delay -> withTimeoutOrNull(wait.ms) { kick.receive() }
	// The alarm (or a foreground/forget kick) is the real wakeup - the timeout below
	// is only a backstop against a lost alarm. Floored at 0 so a pass finishing near
	// the mark never hands withTimeoutOrNull a negative duration.
	is PollWait.Alarm ->
		withTimeoutOrNull((wait.atMillis - System.currentTimeMillis() + PARK_SLACK_MS).coerceAtLeast(0)) { kick.receive() }
}
```

- Expose `fun kickPoll() { kick.trySend(Unit) }` for the alarm receiver.
- Add `private const val PARK_SLACK_MS = 5_000L` to the existing private companion alongside
  `POLL_INTERVAL_MS`/`TEAMS_REFRESH_MS` (Audit #7 - referenced by the loop above but never
  declared; only `ChatRepository`'s own companion can see it there).
- Delete `AFK_POLL_INTERVAL_MS` (superseded by `MINUTE_MS`). `POLL_INTERVAL_MS`,
  `LONG_POLL_HOLD_MS`, `TEAMS_REFRESH_MS` unchanged. `hold = if (visible) ...` unchanged.
- Teams refresh piggyback unchanged: at deep marks its 30s gate always passes, so each wakeup
  is one `teams()` + one `poll()` - keeps the board fresh on rare wakeups, deliberate.

### `SwitchboardService.kt` changes (implements `DeepIdleScheduler`)

- **Two wakelocks, never one - and the pass lock is ONE shared object, not per-instance
  (Audit #2).** The existing indefinite lock stays the ACTIVE-TIER lock (FOREGROUND + MINUTE:
  exactly today's behavior), a plain instance field as it is today. The PASS lock is different:
  the alarm receiver must be able to bridge a wakeup BEFORE a live `SwitchboardService` instance
  necessarily exists (dead-process revival is the entire point of the receiver acquiring it), so
  it cannot be a service-instance field the way the pseudocode first sketched it - it has to be
  the SAME object the receiver, `holdPass`, and `enterDeepSleep` all touch. Make it a lazily-created
  companion-object `WakeLock` built from `applicationContext`
  (`PowerManager.PARTIAL_WAKE_LOCK, "switchboard:poll-pass"`, distinct tag from the active lock's
  `"switchboard:poll-loop"` for battery-attribution), `setReferenceCounted(false)` to match the
  active lock's own pattern (`SwitchboardService.kt:67`) - only ever `acquire(timeoutMs)`'d, never
  a plain `acquire()`. Mixing the plain-acquire and timeout-acquire patterns on ONE lock is the
  original footgun this split avoids: with reference counting off, a stale pass-timeout release
  firing later would silently drop a shared lock's indefinite active-tier hold.
- `exitDeepSleep()`: cancel the alarm PendingIntent, acquire the active lock (idempotent).
- `enterDeepSleep(at)`: `alarmManager.setExactAndAllowWhileIdle(RTC_WAKEUP, at, pollAlarmPi())`,
  release BOTH locks (the shared pass lock null-safe/isHeld-guarded exactly like the existing
  `releaseWakeLock()` already does at `SwitchboardService.kt:72-74` - the very first
  MINUTE->deep transition reaches here with the pass lock never having been acquired at all),
  update the status notification line ("Idle - next check HH:mm" - lowercase `mm` for minutes;
  a capital `MM` is the month token). Shipped as a small `postIdleStatus(wakeAtMillis)` helper
  with its own `if (!canNotify() || statusDismissed) return` guard, the same combined condition
  `updateStatusNotification`'s two sequential guards already enforce.
- `holdPass(ms)`: the shared pass lock's `acquire(ms)` (timeout is the release; no explicit
  release path).
- `onDestroy()`: cancel the alarm + release both locks. Deliberate stops (unprovision) kill the
  alarm; a system process kill skips onDestroy, so the alarm survives and revives the service -
  exactly the wanted split.
- Guard: `if (!alarmManager.canScheduleExactAlarms()) setAndAllowWhileIdle(...)` - defensive
  only; USE_EXACT_ALARM is auto-granted at minSdk 33.
- `pollAlarmPi()` (Audit #7 - referenced but never given a body): mirror the existing
  `actionIntent`/`contentIntent` construction (`SwitchboardService.kt:168-192`), which both use
  `this` (the Service) as the Context, not `applicationContext` - `applicationContext` is reserved
  for the companion pass lock below, which genuinely must survive past any one Service instance -
  `PendingIntent.getBroadcast(this, POLL_ALARM_RC, Intent(this,
  PollAlarmReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or
  PendingIntent.FLAG_IMMUTABLE)`. `FLAG_IMMUTABLE` is mandatory at API 31+ (minSdk is 33, so this
  is every device) and is the right choice regardless - AlarmManager never mutates the intent it
  fires. Explicitly NOT `FLAG_ONE_SHOT`: the schedule/cancel/reschedule cycle needs the same PI
  identity to stay stable across every mark. One `POLL_ALARM_RC` constant is enough - the target
  component (`PollAlarmReceiver`, new and otherwise unused) already rules out any collision with
  the existing notification PendingIntents.

### New file: `PollAlarmReceiver.kt`

```kotlin
class PollAlarmReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		// AlarmManager's own lock only spans onReceive; the pass runs async in the service
		// process. Bridge with the timeout'd pass lock BEFORE returning - the SAME companion-
		// object lock enterDeepSleep/holdPass operate on (see the wakelock section above), not a
		// second one: a distinct instance here would never be released by the service side.
		SwitchboardService.acquirePassLock(context, PASS_TIMEOUT_MS)
		SwitchboardService.start(context)   // revive after process death (the alarm PI survives)
		Repo.get(context).kickPoll()
	}
}
// PASS_TIMEOUT_MS = 90_000: pass + decide + margin; decide()'s enterDeepSleep releases early,
// holdPass extends for the one retry. The timeout is the wedge backstop.
```

### `AppStateStore.kt`

`saveIdleSilenceStart(Long)` / `loadIdleSilenceStart(): Long?` - nullable getter (Audit #1),
following the existing `loadSyncCursor` precedent (`if (!prefs.contains(KEY)) return null`)
rather than the `getLong(key, 0L)` idiom used elsewhere in this file: an absent key must read as
"nothing persisted yet" so the manager's hydrate clamp can default it to `now()`, not to `0L`
(which reads as "silent since the epoch" and lands a fresh install straight in TWELVE_HOUR).

### `AndroidManifest.xml`

- `<uses-permission android:name="android.permission.USE_EXACT_ALARM" />` (API 33+, auto-granted,
  non-revocable; fine for a sideloaded non-Play app. minSdk is 33, so no SCHEDULE_EXACT_ALARM dance.)
- `<receiver android:name=".PollAlarmReceiver" android:exported="false" />`

### Doze/network honesty

Without the battery-optimization exemption, Doze normally defers background network access to
the OS's own periodic maintenance windows. `setExactAndAllowWhileIdle` bypasses the DEFERRAL
(the alarm still fires exactly on schedule); for a brief stretch right after it fires, the OS
treats that firing like one of its own maintenance-window exits, so the process can actually
open a socket.

That window's length is not a documented Android constant. Google does not publish a fixed
number of seconds for it. It is only understood to be short: enough for one quick plain poll,
not a long-poll hold. If the poll's first packet is slow (the radio has to come back from deep
sleep and re-associate with the tower) and the request runs past whatever the real window turns
out to be, the socket can get cut mid-request. This is also why the Q4 retry is bounded rather
than spin-until-success: the retry 60s later gets the same brief treatment, not a fresh
guaranteed grant, so if the window already closed once, a second attempt inside the same
wakelock hold is not guaranteed to fare better. Hence one retry, then wait for the next mark.

With the exemption (existing Settings row) the app is Doze-whitelisted outright and none of this
applies; every mark's poll behaves like a normal request. Keep the row and its recommendation
unchanged.

**OEM caveat (Audit #10).** Everything above is AOSP behavior. Aggressive OEM skins (Samsung,
Xiaomi/MIUI, Huawei, OnePlus) impose their OWN separate autostart/protected-app/sleeping-app
gates that the existing exemption row never reaches - alarm-survives-kill, fires-on-schedule, and
`BOOT_COMPLETED`-revival can all be broken by those gates even with the row showing "Allowed", so
that copy should not be read (or written) as a guarantee once granted. No data loss either way -
the same mailbox-durability argument below holds regardless of which OS layer caused the delay -
so the honest framing is "no data loss; background-notification timeliness in deep tiers is
best-effort and OS/OEM-dependent," not an unconditional promise. Whether to also soften the
Settings row's own copy or add a manufacturer-aware hint is a follow-up decision, not applied
here.

A cycle that misses (both the pass and its retry fail) is deferred, not retried early: it just
waits for the NEXT regularly aligned mark, same as a clean success would. No data is lost either
way - the gateway's mailbox holds every entry server-side regardless of when the console next
polls, so a missed cycle only delays notification, never drops it; the very next poll to
succeed (the next mark, or simply the user opening the app, which always kicks an immediate
foreground poll) drains everything that accumulated in one pass. Tier deepening is also
unaffected by poll success/failure (silence is purely wall-clock, per Q4), so a sustained outage
(dead zone, airplane mode) still naturally deepens the ladder to less-frequent marks instead of
retry-storming a gate that stays shut.

### Non-goals

- Foreground behavior, the gateway, and the TS side: untouched (Android-only; no twins).
- TIMEZONE_CHANGED and DST (spring-forward/fall-back): both genuinely self-correct in one odd
  interval - both are epoch-continuous (the alarm's underlying instant never moves), so the
  RTC_WAKEUP fire time is unaffected; only the cosmetic wall-clock alignment of that one mark can
  drift, and `nextAlignedMark`'s strictly-future filter can never go empty for any tier even
  inside a DST gap. No receiver needed for either.
- `TIME_SET` (a backward wall-clock step) is a NARROWER, distinct non-goal, corrected per
  Audit #9: it does NOT self-correct in one odd interval the way DST/timezone do. AlarmManager
  rebatches the alarm's target to the new wall-clock reading rather than dropping or
  immediately firing it, and with both wakelocks released in a deep tier there is nothing left to
  wake the CPU through Doze before then - the stall is bounded by the jump's magnitude, not by
  one interval. No data is lost (the mailbox holds everything server-side; opening the app resets
  silence immediately), so this is a notification-latency gap, not a correctness one, and it is
  accepted as out of scope for v1 on that basis - not because a fix would be expensive (a
  dedicated `TIME_SET` receiver would be cheap, reusing the existing `kickPoll()` plumbing with no
  DST/alignment math of its own, since `decide()` always recomputes from the current instant).
  Revisit if a backward-step blackout turns out to matter in practice.
- The MCP-side kick/long-poll architecture gap (can't interrupt a held long-poll): pre-existing,
  out of scope.

### Tests (`IdlePushbackManagerTest.kt`, pure JUnit - the ForgetTombstoneTest pattern)

- `tierFor` boundaries, asserted at the EXACT constant, not an approximate "10m" (Audit #8 - only
  the exact-equal millisecond distinguishes a `<` off-by-one from `<=`): `silenceMs` of
  `599_999`/`600_000`, `35_999_999`/`36_000_000`, `172_799_999`/`172_800_000`; foreground always
  wins regardless of silence.
- `nextAlignedMark`: 12:03 -> 12:30; exactly 12:30:00.000 -> 13:00 (strictly future); hourly
  12:59 -> 13:00 AND exactly 13:00:00.000 -> 14:00 (Audit #8 - an exact-on-mark case, the state a
  deep wakeup actually re-enters `decide()` at); twelve-hour 07:00 -> 08:00, 09:00 -> 20:00,
  21:00 -> next-day 08:00, AND exactly 08:00:00.000 -> 20:00 / exactly 20:00:00.000 -> next-day
  08:00; a DST spring-forward night (strictly-future) AND a second spring-forward case where the
  WINNING candidate itself is the one nominally landing in the gap, asserted against its exact
  resolved instant, not just strictly-future - the first case alone can construct a gap-adjacent
  candidate without ever selecting it, so it never actually exercises the shift; a fall-back/
  overlap night (strictly-future); one non-integer-offset zone (e.g. Asia/Kolkata) for a
  TWELVE_HOUR mark.
- Manager state machine (inject `hydrateNow`, fake store via the `IdleSilenceStore` seam - see
  Testability below, recording scheduler): foreground -> Chain + exitDeepSleep; background fresh
  -> MINUTE; 10 min silence -> Alarm at mark + enterDeepSleep; 10h/48h silence -> Alarm lands on
  a top-of-hour / 8-or-20 mark specifically (Audit #8 - proves `decide()` hands `nextAlignedMark`
  the RIGHT tier, not just that a plausible mark comes back); deep failure -> one Delay(60s) +
  holdPass then Alarm (budget resets per mark), THEN a third decide with a fresh failure ->
  another Delay(60s) (Audit #8 - proves the budget actually resets for the NEXT mark, not just
  that it was consumed once); comms at a deep mark -> reset to MINUTE; hydrate clamps a future
  persisted timestamp, checked well past the MINUTE boundary so the clamped and unclamped paths
  land in different tiers (checking at `now == hydrateNow` cannot tell them apart - both round to
  MINUTE either way, which would silently pass even with the clamp removed or reversed); hydrate
  from an absent/never-persisted store -> MINUTE, not TWELVE_HOUR (Audit #1/#8 - the case a fresh
  install and a headless post-reboot revival both hit).

### Testability seam (Audit #7 dimension - closes the gap the pure-function split leaves open)

`AppStateStore` is a final, Context/Keystore-backed class (no Robolectric or mocking library is
on this project's test classpath), so `IdlePushbackManager` cannot take it directly if the
manager-state-machine tests above are to stay pure JUnit. Add a narrow interface the same way
`zone: () -> ZoneId` is already injected instead of a raw `ZoneId`:

```kotlin
interface IdleSilenceStore {
	fun loadIdleSilenceStart(): Long?
	fun saveIdleSilenceStart(v: Long)
}
```

`AppStateStore` implements it (its two new methods already match this shape); `ChatRepository`
wires the real store in. A test fake is then a few lines of in-memory storage (one nullable
`var`, since the seam persists exactly one key) - no Context, no Robolectric, no new dependency,
consistent with how `wake.ts`'s `decideWakeCreate` and this codebase's other pure-core/
injected-side-effect splits are already structured.

The manager's own hydrate clock is injected the same way: the constructor takes a plain
`hydrateNow: Long` (not an ambient `now()` call) so both the fresh-install/absent-store case and
the future-clamp case can be pinned to a deterministic value in a test - `ChatRepository` wires
the real clock, `IdlePushbackManager(store, System.currentTimeMillis()) { ZoneId.systemDefault() }`.

## Audit

14 independent Opus agents (one per dimension), fan-out only, each pointed at the plan plus the
real source. Triaged below by me against the actual code (own re-reads of the pseudocode and of
ChatRepository.kt/SwitchboardService.kt already in hand) - not accepted on tone alone. Ranked
most significant first; verdicts are CONFIRMED (I independently re-derived or re-read the same
fact) or PLAUSIBLE (well-evidenced, resting on platform behavior I did not independently pull
primary sources for).

**1. CONFIRMED - hydrate default lands a fresh install/reboot in the DEEPEST tier, not the
shallowest.** `loadIdleSilenceStart(): Long` (non-nullable) can only be implemented as
`getLong(key, 0L)`. Unset -> 0L -> `min(0L, now()) = 0L` -> `silence = now() - 0` (~55 years) ->
`tierFor` falls through to TWELVE_HOUR. Every fresh install, and per finding 5 every headless
post-reboot revival before the first background transition, starts in the least attentive tier
instead of the most - backwards from intent. I re-derived this directly from the pseudocode, no
agent authority needed; independently flagged by both the persistence and test-adequacy
dimensions. Fix: `loadIdleSilenceStart(): Long?`, following the existing `loadSyncCursor`
precedent (`if (!prefs.contains(...)) return null`); hydrate as
`min(store.loadIdleSilenceStart() ?: now(), now())`.

**2. CONFIRMED - the pass lock's object identity is inconsistent in my own pseudocode.** The
receiver's `SwitchboardService.acquirePassLock(context, ...)` is written as a static/companion
call (my own comment says so); `holdPass`/`enterDeepSleep` are written as instance methods on a
`passLock` field. The receiver must be able to bridge a wakeup BEFORE a live service instance
necessarily exists (that is the entire point of reviving a dead process) - so these have to be
the same object. As written, they are not. Fix: pin the pass lock to ONE lazily-created
companion-object `WakeLock` (`applicationContext`-backed, `setReferenceCounted(false)` matching
the existing active lock's own pattern at `SwitchboardService.kt:67`); all three sites
(acquirePassLock, holdPass, enterDeepSleep) operate on that single object. Guard its release the
same null-safe/isHeld way `releaseWakeLock()` already does, since the very first MINUTE->deep
transition reaches `enterDeepSleep` with the pass lock never having been acquired at all.

**3. CONFIRMED (verified against code already read this session) - the deep-sleep wakelock
release can race the drain's own fire-and-forget notification/STTS coroutines.** The burst loop
(`ChatRepository.kt:2907-2918`) launches `onInbound?.invoke(...)` (the actual notification post)
and STTS synth/playback inside an un-joined `scope.launch(Dispatchers.IO) { ... }`, then the loop
falls straight through to `mailboxSync.commit(...)` and (under this plan) `decide()` ->
`enterDeepSleep`'s synchronous lock release. Today this is masked because the service holds its
wakelock for the whole loop lifetime regardless. Under the ladder, a deep-tier pass could release
the CPU mid-synth, silently dropping that cycle's banner/sound/auto-play while leaving the unread
badge correct (it updates synchronously, so no data is lost - only the alert). Fix: join the
launched burst coroutines before calling `decide()`, or move the notification POST out of the
`launch` (keep only STTS async), or don't early-release the pass lock on a successful pass and
let its timeout cover the tail.

**4. CONFIRMED (my own pseudocode) - `decide()` reads volatile tier state twice and can throw
outside the loop's try/catch.** `tierFor(foreground, now - silenceStartAt)` is computed once for
the `when`, then again inside the deep branch's `nextAlignedMark(now, tierFor(...), zone())`.
`foreground`/`silenceStartAt` are `@Volatile`, written from the main thread
(`onForeground`/`onBackground`); a transition landing between the two reads can disagree, and
`nextAlignedMark`'s `else -> error(...)` fallback would throw for a tier the first read chose but
the second didn't recognize. The replacement `when` sits at the loop's tail, after the existing
try/catch closes (verified against the real `ChatRepository.kt:2933-2968` structure) - an
escaped throw kills the poll coroutine outright (no handler on that scope), not just one pass.
Fix: snapshot the tier into a single local once at `decide()` entry and reuse it; make
`nextAlignedMark` total for every tier `decide()` can actually reach instead of relying on an
unreachable-in-practice `error()`.

**5. Rationale fix, not a decision change - Q3's stated reason is wrong, the decision is right.**
Q3 justifies persisting the silence clock on "releasing the wakelock makes the process killable."
A `PowerManager.WakeLock` gates CPU/SoC suspend, not process eviction; the service's own
`FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING` foreground service is what keeps the process resident
(its own class doc already says "the service only guarantees process lifetime" -
`SwitchboardService.kt:44-52`), independent of any wakelock, and is not torn down in any tier this
plan touches. What actually demands persistence is REBOOT: it clears every scheduled alarm and
all in-memory state, and `BootReceiver` starts the service fresh with nothing to resume from
except what was persisted - plus the rarer case of a genuine hard kill. PLAUSIBLE rather than
fully confirmed only on the specific claim that this foreground-service type is exempt from the
newer Android FGS runtime timeout (version-specific platform behavior I did not pull a primary
source for); the core mechanism (wakelock is not what keeps a process alive) is solid. Fix:
reword Q3's rationale to cite reboot (+ rare hard kill) instead of wakelock-release-enables-kill,
so a future maintainer is not misled into e.g. stopping the foreground service in deep tiers to
"achieve" a killability the current rationale merely assumes.

**6. CONFIRMED (my own comment, re-checked) - the clamp-direction comment names the wrong failure
mode.** The plan's comment reads "a persisted future value (clock rollback) must not wedge deep
idle." Tracing `min(persisted, now)` when `persisted > now`: `silenceStartAt` clamps to `now`, so
`silence = 0`, landing in MINUTE - the SHALLOWEST tier, not a deep-idle wedge. The clamp's real
job is preventing the app from being stuck paying the EXPENSIVE per-minute tier for the entire
duration of a backward jump, not preventing a deep-idle stall. The clamp direction (`min`, not
`max`) is correct; only the comment misdescribes which failure it prevents - worth fixing since a
future maintainer "correcting" it toward `max` on the wrong mental model would silently break the
Q3 resume-into-deep-tier behavior with no test catching it.

**7. CONFIRMED (pseudocode completeness gaps).** `PARK_SLACK_MS` is referenced in the loop
replacement but never declared anywhere (needs a home in `ChatRepository`'s private companion,
the only scope that can see it). `pollAlarmPi()` is referenced but its body was never written
out; needs `FLAG_IMMUTABLE` (API 31+ hard requirement, matches this file's own existing
convention at `SwitchboardService.kt:186-191`) and must explicitly NOT be `FLAG_ONE_SHOT` (the
schedule/cancel/reschedule cycle depends on it being stable across marks).

**8. CONFIRMED (traced against the pseudocode) - the named test list has real coverage gaps,**
not just nice-to-haves: the exact-equal boundary millisecond at each rung (only the exact value
distinguishes a `<` off-by-one from `<=`); an exact-ON-mark reschedule case for HOURLY and
TWELVE_HOUR specifically through `decide()` (the named cases only exercise HALF_HOUR through
`decide()` - a wrong-tier bug inside `decide()` itself would still schedule a plausible mark and
pass every other named test, while a 2-day-silent device wrongly wakes every 30 min); a
retry-budget-resets-on-the-NEXT-mark case (the named sequence proves the budget is consumed, not
that it resets for a later failure); a DST fall-back/overlap case (only spring-forward is named,
despite the prose claiming both are handled); and the cold/unset-persist hydrate case from
finding 1, which the named cases don't cover at all (only a future-persisted-value case is
named).

**9. Judgment call, not a fix - a backward wall-clock step (`TIME_SET`) stalls the deep ladder by
the jump's magnitude, contradicting the "self-corrects in one odd interval" non-goal.** DST and
timezone changes genuinely do self-correct in one interval (both are epoch-continuous; verified
against the `nextAlignedMark` pseudocode's strictly-future filter, which can never go empty for
any tier). A `TIME_SET` backward step is different: `AlarmManager` rebatches the alarm's target
to the new wall-clock reading rather than dropping or immediately firing it, and with both
wakelocks released in deep tiers there is nothing left to wake the CPU through Doze before then -
the coroutine backstop only "ticks while the CPU is otherwise awake" (the plan's own words,
written before this was traced through to a concrete failure mode). No data loss either way (the
mailbox holds everything server-side; opening the app resets silence on the spot) - this is a
notification-latency question, not a correctness one. A dedicated `TIME_SET` receiver would be
cheap (reuses the existing `kickPoll()` plumbing, no DST/alignment math since `decide()` always
recomputes from the current instant) - your call whether it's worth building now or just stating
honestly as a bounded, self-healing-on-open gap.

**10. Judgment call - the plan and the existing battery-exemption Settings row state AOSP
guarantees as unconditional facts.** Alarm-survives-kill, fires-on-schedule, and
`BOOT_COMPLETED`-revival are all AOSP behavior that aggressive OEM skins (Samsung, Xiaomi/MIUI,
Huawei, OnePlus) routinely break via their own separate autostart/protected-app/sleeping-app
gates that the existing `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` row never reaches - so
"Allowed" on those devices can read as a promise the OS does not keep. No data loss in any case
(same mailbox-durability argument as finding 9); this is the same class of honesty gap I already
corrected once this session for the "~10s" Doze-window figure. Recommend folding an explicit OEM
caveat into the Doze-honesty section alongside it, and softening the Settings row's copy so it
doesn't read as a guarantee once granted.

**11. CONFIRMED, low-cost polish (fold in alongside the fixes above):** `deepRetryUsed` should be
`@Volatile` for the same cross-thread-visibility reason its sibling fields already are (it is a
visibility gap, not an atomicity one - no mutex needed, the compound is single-coroutine). The
manager's own `foreground` field duplicates `ChatRepository`'s existing `visible` and can go
transiently out of sync since the two `@Volatile` writes in `onForeground`/`onBackground` aren't
atomic with each other; simplest fix is passing the existing `visible` straight into
`decide(now, visible, failed)` instead of maintaining a second field.

**Explicitly rejected / confirmed non-issues** (real dimensions checked, nothing survived):
the 9-minute `allow-while-idle` throttle floor never threatens any tier (all three deep intervals
clear it by >=3.3x, and the retry is a wakelock-held coroutine delay, never a second alarm, so it
can't consume that budget either); request-code collision between the new alarm PendingIntent and
existing notification ones is structurally impossible (different target component); the
two-separate-wakelock-instances decision itself (as opposed to the identity/refcount specifics in
finding 2) is sound and not a duplicate of anything already in the codebase; the persistence
key's schema-wipe/re-provision partition placement is already correct by omission from both
allow-lists; the RTC-vs-monotonic clock source choice is right (only `currentTimeMillis` can
survive the reboot this feature is built around); the core `startPolling` loop integration matches
the real code appropriately (bar the two completeness gaps in finding 7); nothing in the codebase
already solves this problem, so the two-wakelock design is new work, not reinvention.

### Verification

1. `bun run lint && bun run test` (unchanged TS should stay green - no TS edits expected).
2. Android gate (the real one): `JAVA_HOME=... ANDROID_HOME=... ./gradlew :app:testDebugUnitTest`.
3. On-device evidence (debug build): `DebugLog` already stamps every `[Poll] firing` to evie
   ingest; add one `[Idle]` line per tier transition (`tier=HALF_HOUR nextWake=12:30`). Watch:
   60s cadence for 10 min after backgrounding, then fires landing on :00/:30 marks, then a
   message resetting to 60s. That log trail is the acceptance evidence for cadence - it says
   nothing about lock state, which the pure tests cannot see either (the two-wakelock split is
   real-device-only coverage). Also log each lock's `isHeld` at every `enterDeepSleep`/
   `exitDeepSleep`/`holdPass` call and confirm across one full foreground -> MINUTE -> deep ->
   retry -> deep sequence: the active lock is held only in FOREGROUND/MINUTE, the pass lock is
   held only during an actual pass (never both released with a pass in flight, never the active
   lock silently dropped by a pass-lock release).

## Red team

9 independent Opus agents, adversarial (not plan-comparison - the align pass already covered
that). Verified two of the plan's own confidence claims against real platform behavior along the
way. Fixed below; each re-verified with a real build (`testDebugUnitTest` and `assembleRelease`,
both green) before committing.

**Fixed:**

- **`onDestroy` never nulled `pushback.scheduler`.** `ConsoleClient.poll()` is a plain blocking
  call, not `suspend` - `scope.cancel()` in `onDestroy` cannot interrupt an in-flight call, so the
  poll loop can run one more full pass (including `decide()`) after teardown, against a
  now-destroyed service instance. That trailing `decide()` could re-acquire the active wakelock
  with nothing left to ever release it (a leak: `releaseWakeLock()` already ran and nulled the
  field, so the later `isHeld` guard never fires), or re-arm the alarm `onDestroy` just cancelled.
  Fixed by nulling `pushback.scheduler` in `onDestroy`, guarded by an identity check
  (`if (repo.pushback.scheduler === this)`) so a fresh instance's own registration - set by its
  own `onCreate` racing a moment earlier - can never be wiped out by an older instance's delayed
  teardown.
- **`burstJobs.joinAll()` had no timeout - a stalled TTS synth could wedge the poll loop
  permanently.** The STTS OkHttp client sets a per-read timeout on the streamed response, not an
  end-to-end call timeout, so a server that keeps trickling bytes can hold the read open
  indefinitely; `joinAll()` with nothing bounding it meant the WHOLE poll loop - not just that
  team's synthesis - could never reach the tail wait, and the `kick` channel is only read there,
  so neither a foreground open nor anything else could unstick it. This escalated the fire-and-
  forget-vs-joined tradeoff already accepted in the ChatRepository.kt changes section from
  "waits a bit longer" to "can hang forever." Fixed with `withTimeoutOrNull(BURST_JOIN_TIMEOUT_MS)
  { burstJobs.joinAll() }` (90s, matching the pass-lock's own budget) - a stalled synth now leaks
  that one coroutine exactly as it did before this join existed, instead of blocking every future
  pass.
- **`PollAlarmReceiver.onReceive` had no guard around `SwitchboardService.start()`.** On the
  (normally unreachable at minSdk 33, since `USE_EXACT_ALARM` is auto-granted/non-revocable)
  inexact-alarm fallback path, a dead-process revival's `startForegroundService` loses the exact-
  alarm FGS-start exemption and can throw `ForegroundServiceStartNotAllowedException` - uncaught,
  that crashes the revival broadcast itself, before it could ever re-arm the next alarm, silently
  stranding the ladder with nothing left to revive it. Wrapped in try/catch, logged via
  `DebugLog`; a refusal now degrades to one missed wakeup (the next mark still fires) instead of a
  permanent strand.

**Confirmed correct, not a bug (verified against real platform behavior, not just the code's own
comments):**

- The wakelock re-arm/release semantics the whole two-lock design rests on - a second
  timeout-`acquire()` under `setReferenceCounted(false)` genuinely resets the deadline rather than
  stacking or no-op'ing, and `release()` genuinely frees the lock immediately rather than waiting
  out the original timeout - were traced against the actual AOSP `PowerManager.WakeLock`
  implementation and confirmed correct with high confidence. This resolves as CONFIRMED what the
  plan's own audit trail had left as PLAUSIBLE.
- The companion pass-lock's double-checked-locking (`@Volatile` + `synchronized(this)`) is
  textbook JMM-correct: the volatile publish happens after full construction, `synchronized(this)`
  locks the one stable companion singleton, and no contention path can create two lock instances.
- `postIdleStatus` reading `state.value.unread` from the poll loop's IO coroutine has no
  staleness or cross-thread visibility risk (same-coroutine program order covers it), and posting
  a notification from that thread matches every other notification call site in the file.
- A fresh-eyes sweep of `IdlePushbackManager.kt` and `PollAlarmReceiver.kt` for off-by-ones, sign
  errors, or swapped parameters found none.

**Deliberately not fixed - documented, real, but out of scope for this feature:**

- **Neither the wakelock semantics above nor the `burstJobs.joinAll()` ordering have any automated
  test coverage**, and structurally cannot with what's on this project's test classpath today (no
  Robolectric, no `androidTest`/instrumentation runner, no coroutines-test). The wakelock claims
  are the kind only a real `PowerManager` can prove; the join ordering is two sequential
  statements in one coroutine body with no concurrency between them, so it is correct by
  construction rather than by anything a unit test would meaningfully exercise. Both are now
  bounded even if wrong in the future (a timeout backstop either way), which is why this is left
  as a documented gap rather than a blocking one. Building the instrumented-test infrastructure
  this would need is a real, separate investment, not a fix that belongs in this feature's diff.
- **`SttsClient`'s OkHttp client has no `callTimeout`, only a per-read `readTimeout`** - a
  pre-existing gap (predates this feature; the fire-and-forget STTS call already had it, just
  with a smaller blast radius since nothing was joining on it). This feature's `joinAll()` bound
  now caps the damage regardless, so the root cause is left as a follow-up rather than pulled into
  this diff.

### Round 2 (verifying the three fixes above closed cleanly)

5 targeted Opus agents, re-verifying only the three fixes and their blast radius (round 1's other
six dimensions - wakelock semantics, DCL correctness, manifest surface, StateFlow staleness, the
fresh-eyes sweep - were already confirmed clean and did not need re-checking). All three verdicts:
**closes-the-bug**. Two small residuals surfaced and were hardened rather than left open, since
both were cheap:

- **A narrow TOCTOU remained in the scheduler-null fix**: `decide()` reads the scheduler and
  invokes a method on it as two separate steps, so a read landing a few instructions before
  `onDestroy`'s null-write could still invoke a method after teardown had already cancelled the
  alarm and released both locks - re-acquiring an un-timed wakelock nothing would ever release.
  Added a `@Volatile destroyed` flag, set first in `onDestroy`, checked at the top of all three
  `DeepIdleScheduler` methods - closes the specific bad outcome even though the underlying
  read-then-invoke race is not fully atomic.
- **`BURST_JOIN_TIMEOUT_MS` claimed exact parity with the pass lock's own budget, but the two
  clocks start at different moments** (the pass lock from the alarm receiver; the join only once
  the pass is actually running), so an equal 90s budget could let the join still be waiting after
  the pass lock had already timed out. Lowered to 60s with margin, comment corrected to explain
  the skew instead of asserting parity.

Also fixed on the same pass: one comment anchored to the pre-fix code state ("exactly like before
this join existed" - a Comments-Must-Be-Timeless violation caught by a dedicated code-quality
dimension), and one comment overstating the alarm receiver's crash-guard self-healing (a refusal
does not auto-schedule a next mark; recovery is the next app open or a reboot).

Re-verified with a full real build (`testDebugUnitTest` + `assembleRelease`, both green) after
every change in this section.

## Framework-first

5 Opus agents, applying the ownership test (would this survive as shared infrastructure if the
app were rebuilt on the same foundation?) plus the "no magic" / "bugs impossible by design"
lenses to what actually shipped. Independently re-verified the one high-value finding's math
myself before touching anything.

**Fixed:**

- **The deep-tier pass-lock budget was three independently-edited literals across three files,
  related only by prose comments cross-referencing each other by name - and that split already
  let the relationship drift once (the round 2 fix above).** Tracing the actual numbers found a
  SECOND, narrower live instance of the exact same drift, on the retry path specifically:
  `holdPass(DEEP_RETRY_MS + PASS_GRACE_MS)` re-arms the pass lock for 90s, but the `DEEP_RETRY_MS`
  wait itself (60s) consumes two-thirds of that before the retry pass even starts, leaving only
  the old `PASS_GRACE_MS` (30s) to cover the retry pass's own `burstJobs.joinAll()` - which can
  still run up to `BURST_JOIN_TIMEOUT_MS` (60s). 30 < 60: a retry pass draining a fresh followed
  thread's STTS burst with a stalled synth could still release the CPU mid-join, the exact hazard
  the round 2 fix exists to prevent, just recurring one level deeper. Fixed structurally, not
  numerically: `BURST_JOIN_TIMEOUT_MS` is now the one root quantity in `IdlePushbackManager.kt`
  that `PASS_GRACE_MS` and `PollAlarmReceiver`'s `PASS_TIMEOUT_MS` both derive from by compile-time
  arithmetic, so a future edit to any one of them propagates automatically instead of silently
  invalidating a comment. `ChatRepository.kt` and `PollAlarmReceiver.kt` deleted their own copies
  and reference the shared constants directly (same package). Backed by two ordering assertions in
  `IdlePushbackManagerTest.kt` (`PASS_GRACE_MS >= BURST_JOIN_TIMEOUT_MS`,
  `PASS_TIMEOUT_MS >= BURST_JOIN_TIMEOUT_MS`) and the retry-hold assertion now checks the
  derivation expression instead of a hand-computed literal, so this specific drift class fails a
  test instead of passing silently. Honest cost: the retry-tier pass-lock hold grows from 90s to
  135s (60s wait + 75s grace, up from 30s) - the correct price of actually covering the join the
  old margin silently under-budgeted.
- **`SwitchboardService.onDestroy`'s scheduler-null guard and its `onInbound`-null one line above
  it rested on contradictory premises about Service lifecycle ordering, stated one sentence
  apart.** The `=== this` identity guard's own comment argued a newer instance's `onCreate` could
  already be live when an older instance's `onDestroy` runs late; the very next clause argued the
  opposite (Android serializes Service lifecycle callbacks, so that overlap cannot happen) to
  justify `onInbound` needing no such guard. Both premises cannot hold. Simplified to match:
  `scheduler = null` is now unconditional, exactly like `onInbound`, with one accurate comment
  explaining why (destroy-before-create serialization) and noting the `destroyed` flag - not the
  identity check - is what actually defends against the real hazard (a trailing `decide()` that
  reads the scheduler before this method nulls it, executing after teardown has already run).

**Confirmed not warranted (real dimensions checked, nothing survived the ownership test):**

- **A `SharedTimeoutWakeLock` extraction for the companion pass-lock.** Exactly one owner, zero
  second consumers, and the pass-lock is deliberately the OPPOSITE of the active lock on every
  axis (timeout vs indefinite, process-scoped singleton vs instance field, lazy DCL vs eager) -
  a shared type would have exactly one instance. The DCL itself is already the codebase's own
  established lazy-singleton idiom (matches `Plugins.get`, `DesignStore`), not something the code
  is straining against. The one plausible benefit (making "never plain-acquire this lock"
  structural) is already true today: `passLock()` is private, the sole public entry
  (`acquirePassLock`) only offers the timeout form.
- **A `ScheduledWake`/`AlarmScheduler` abstraction for the alarm-scheduling dance.** This feature
  is the app's first and only `AlarmManager` use; there is nothing to unify with zero other
  callers, and the one genuine benefit a "testable unit" framing would offer is unavailable on
  this project's classpath regardless (no Robolectric/instrumentation, so an extracted class would
  add an indirection layer with no new test seam). The existing `DeepIdleScheduler`/
  `IdleSilenceStore` split already isolates the pure, tested decision core from every Android side
  effect - the correctly-sized abstraction for a single-caller feature.
- **Generalizing `PollTier`/`tierFor`/`nextAlignedMark` into a domain-agnostic backoff-ladder
  utility.** No second consumer anywhere in the codebase (the only other "poll less when quiet"
  logic, `TerminalView.kt`'s failure-count backoff, shares none of the shape: no wall-clock
  alignment, no persistence, a continuous multiplier instead of discrete tiers). The functions are
  already pure, top-level, and Android-free - the exact form an extraction would produce, so there
  is no coupling to fix. Renaming to something generic would make the name less honest about what
  the code actually does today.
- **An `InstanceGuard`/`ServiceLifecycleToken` helper for the destroyed-flag pattern.** Exactly one
  side-effecting registered callback (`scheduler`) exists; `onInbound` is deliberately undefended
  because its trailing invocation is harmless (posts a notification through a still-valid
  singleton), not because the codebase forgot to guard it. A generic wrapper would either
  over-apply ceremony to the harmless callback or under-defend a hypothetical future harmful one -
  designed against an audience of one. The real root cause (`ConsoleClient.poll()` being a plain
  blocking call, not `suspend`, which is WHY `scope.cancel()` cannot stop a trailing pass) is
  already named as a pre-existing, deliberately out-of-scope gap in this plan's Non-goals section;
  fixing that would make the whole hazard class impossible by design rather than defended against
  per-callback, but it is a real, separate investment into the network client's architecture, not
  something to fold into this feature.
