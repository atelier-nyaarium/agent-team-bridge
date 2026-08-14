package com.atelier_nyaarium.switchboard

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.text.format.DateFormat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Foreground service owning the bridge connection and poll loop, so messages keep
 * arriving while the Activity is backgrounded or the screen is off. The Activity
 * only observes shared Repo state. The poll cadence is governed by [IdlePushbackManager]:
 * fast while the Activity is visible or recently backgrounded, backing off to
 * wall-clock-aligned wakeups the longer it stays silent.
 *
 * Deep doze still gates network unless the user grants the battery-optimization
 * exemption (Settings row); the service only guarantees process lifetime.
 */
class SwitchboardService : Service(), DeepIdleScheduler, ScheduledSendAlarmScheduler {
	// Without this, an uncaught throw in any coroutine launched on this scope (e.g. notifyBurst's
	// oversized-notification RuntimeException, or the state-collect notification reconciler) has
	// no handler in its context and crashes the whole foreground-service process. SupervisorJob
	// already stops a sibling's failure from cancelling this scope; this stops it from taking the
	// process down too.
	private val exceptionHandler = CoroutineExceptionHandler { _, e ->
		DebugLog.log("Service", "uncaught in background scope: ${e.javaClass.simpleName}: ${e.message}")
	}
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + exceptionHandler)

	// Constructed with the instance rather than lazily: onCreate's createChannels() and
	// startInForeground's buildStatusNotification() both run before anything else could reach it.
	private val notifications = ServiceNotifications(this)

	// Nulling pushback.scheduler in onDestroy closes the DOMINANT race (a poll pass that reaches
	// decide() only after onDestroy has already returned). The poll loop's transport is cancellable,
	// but that does not close this race: Kotlin cancellation is cooperative, and a cancel arriving in
	// the loop's non-suspend tail (drain bookkeeping, the try-exit gap, after the last suspension
	// point) still lets that pass complete normally, decide() included - permanent, not something a
	// rethrow discipline can fix (see console-hardening.md Phase D). This flag closes the narrower
	// residual: decide() can still latch this instance as the scheduler a few instructions before
	// that null-write lands, then invoke a method on it after onDestroy has already cancelled the
	// alarm and released both locks. Checked first in every DeepIdleScheduler AND
	// ScheduledSendAlarmScheduler method (both interfaces this Service implements have the identical
	// stale-scheduler exposure), so that stale call can no longer re-acquire an un-timed wakelock
	// nothing would ever release, or re-arm an alarm this instance just cancelled.
	@Volatile private var destroyed = false

	// Held for the FOREGROUND/MINUTE tiers so the poll loop's wall-clock sleep resumes through
	// Doze, which otherwise parks the CPU. Doze can still defer the NETWORK unless the
	// battery-optimization exemption is granted (Settings -> Background delivery). Released in a
	// deep tier (see DeepIdleScheduler below) - the companion `passLock` covers a deep pass
	// instead, so the CPU can actually suspend between alarm wakeups.
	private var wakeLock: PowerManager.WakeLock? = null

	private fun acquireWakeLock() {
		if (wakeLock?.isHeld == true) return
		wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
			.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "switchboard:poll-loop")
			.apply {
				setReferenceCounted(false)
				acquire()
			}
	}

	private fun releaseWakeLock() {
		wakeLock?.let { if (it.isHeld) it.release() }
		wakeLock = null
	}

	private fun alarmManager(): AlarmManager = getSystemService(ALARM_SERVICE) as AlarmManager

	private fun pollAlarmPi(): PendingIntent =
		PendingIntent.getBroadcast(
			this,
			POLL_ALARM_RC,
			Intent(this, PollAlarmReceiver::class.java),
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)

	/** Entering a deep tier: schedule the wall-clock-aligned wakeup and release EVERY lock - the
	 * active one and the companion pass lock (a no-op if this is the first MINUTE->deep
	 * transition, which reaches here with the pass lock never having been acquired). */
	override fun enterDeepSleep(wakeAtMillis: Long) {
		if (destroyed) return
		val am = alarmManager()
		// canScheduleExactAlarms() is API 31+; minSdk is 33, so this is every device, but the
		// guard is defensive against an OEM that revokes the auto-granted USE_EXACT_ALARM.
		if (am.canScheduleExactAlarms()) {
			am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, wakeAtMillis, pollAlarmPi())
		} else {
			am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, wakeAtMillis, pollAlarmPi())
		}
		releaseWakeLock()
		releasePassLock()
		postIdleStatus(wakeAtMillis)
	}

	/** A deep tier's one retry: extend the companion pass lock so the CPU stays up just long
	 * enough for the retry pass (a fresh acquire(ms) with reference counting off resets the
	 * deadline rather than stacking). */
	override fun holdPass(ms: Long) {
		if (destroyed) return
		acquirePassLock(this, ms)
	}

	/** Foreground or MINUTE: cancel any pending alarm and re-acquire the active lock (idempotent -
	 * a no-op if it is already held). */
	override fun exitDeepSleep() {
		if (destroyed) return
		alarmManager().cancel(pollAlarmPi())
		acquireWakeLock()
	}

	private fun postIdleStatus(wakeAtMillis: Long) {
		if (!notifications.canNotify() || statusDismissed) return
		val at = DateFormat.format("HH:mm", wakeAtMillis)
		val unread = Repo.get(this).state.value.unread.values.sum()
		NotificationManagerCompat.from(this)
			.notify(STATUS_NOTIFICATION_ID, notifications.buildStatusNotification("Idle - next check $at", unread))
	}

	private fun scheduledSendAlarmPi(): PendingIntent =
		PendingIntent.getBroadcast(
			this,
			SCHEDULED_SEND_ALARM_RC,
			Intent(this, ScheduledSendAlarmReceiver::class.java).setAction(ScheduledSendAlarmReceiver.ACTION_FIRE_DUE),
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)

	/** Each (team, opId) pair's bounded retry gets its OWN request code (never a single shared slot,
	 * and never team-only) - two DIFFERENT teams failing around the same time must not clobber each
	 * other's retry, and neither must two SEQUENTIAL failures for the SAME team: a record is cleared
	 * at fire time regardless of outcome, so a fresh schedule (and fresh opId) for a team already
	 * mid-retry-window is possible, and hashing on team alone would let the second retry's arm
	 * silently replace the first's still-pending one via FLAG_UPDATE_CURRENT (extras are not part of
	 * PendingIntent identity). Mirrors teamNotificationId's own per-key hashed range, offset well
	 * past every other request code here. */
	private fun scheduledSendRetryPi(team: String, opId: String, targetDomainId: String?): PendingIntent =
		PendingIntent.getBroadcast(
			this,
			scheduledSendRetryRc(team, opId),
			Intent(this, ScheduledSendAlarmReceiver::class.java)
				.setAction(ScheduledSendAlarmReceiver.ACTION_RETRY)
				.putExtra(ScheduledSendAlarmReceiver.EXTRA_TEAM, team)
				.putExtra(ScheduledSendAlarmReceiver.EXTRA_OP_ID, opId)
				.putExtra(ScheduledSendAlarmReceiver.EXTRA_TARGET_DOMAIN, targetDomainId),
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)

	private fun setScheduledSendAlarm(pi: PendingIntent, atMillis: Long) {
		val am = alarmManager()
		if (am.canScheduleExactAlarms()) {
			am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pi)
		} else {
			am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pi)
		}
	}

	/** Arm the single shared "next-due" scheduled-send alarm - always re-armed to the earliest
	 * pending record across every team (see ScheduledSendOps.rearmScheduledSendAlarm), never a
	 * per-team alarm the way the retry below is. */
	override fun scheduleNext(atMillis: Long) {
		if (destroyed) return
		setScheduledSendAlarm(scheduledSendAlarmPi(), atMillis)
	}

	override fun cancelNext() {
		if (destroyed) return
		alarmManager().cancel(scheduledSendAlarmPi())
	}

	override fun scheduleRetry(atMillis: Long, team: String, opId: String, targetDomainId: String?) {
		if (destroyed) return
		setScheduledSendAlarm(scheduledSendRetryPi(team, opId, targetDomainId), atMillis)
	}

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onCreate() {
		super.onCreate()
		statusDismissed = false
		notifications.createChannels()
		startInForeground()
		// The queue and the failures list are in-memory, so a process kill takes them and leaves any
		// transport or alert behind - ongoing, so unswipeable, with dead buttons and an empty sheet
		// behind it. Nothing else reconciles it, because the settled-state hook only fires when
		// playback CHANGES and a fresh process has no playback to change. Cleared unconditionally
		// here: whatever it was describing did not survive.
		getSystemService(NotificationManager::class.java).cancel(TRANSPORT_NOTIFICATION_ID)

		val repo = Repo.get(this)
		if (!repo.state.value.provisioned) {
			stopSelf()
			return
		}
		repo.onInbound = { team, messages -> notifications.notifyBurst(repo, team, messages) }
		repo.scheduled.onScheduledSendFailed = { team, opId -> notifications.notifyScheduledSendFailed(repo, team, opId) }
		repo.playback.chimeSource = { resolveChime() }
		// Transport surfaces send commands and show state; they never hold state of their own, so the
		// lockscreen and the in-thread row cannot disagree about what is playing.
		transport = SttsTransport(
			this,
			CHANNEL_STATUS,
			onPlay = { repo.command { playback.resumePlayback() } },
			onPause = { repo.command { playback.pausePlayback() } },
			onSkip = { repo.command { playback.skipPlayback() } },
		)
		// Driven by the repository's settled-state hook rather than raw playback events: an event fires
		// before the queue has been advanced for it, so at the last terminal a transport built from it
		// would show a run that is already over, with no later event to correct it.
		bubble = QueueBubble(
			this,
			onTap = { startActivity(openQueueIntent().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) },
			// A swipe means "move past this". With a run that is a skip; with only an alert left there
			// is nothing to skip, so it dismisses the bubble instead of firing a command that cannot
			// act. The failures themselves stay - they are still in the list and still in the shade,
			// and there is deliberately no gesture that discards several of them at once.
			onSwipeAway = {
				if (repo.playback.transportState().first) {
					repo.command { playback.skipPlayback() }
				} else {
					mainHandler.post { bubble?.dismiss() }
				}
			},
		)
		repo.playback.onTransportChanged = { publishTransport() }
		repo.pushback.scheduler = this
		repo.scheduled.scheduledSendScheduler = this
		// Boot the plugin framework BEFORE the poll loop starts: booting wires the data-plane bridge
		// onto the repo (once per process), so no inbound message is drained-and-committed before a
		// subscriber exists (the cursor never re-delivers). Idempotent - the Activity may also boot it.
		val plugins = com.atelier_nyaarium.switchboard.plugins.Plugins.get(this)
		// Wired before connect() below, so this device's very first register already states what it
		// can render rather than leaving the gateway a register behind.
		repo.enabledPlugins = { plugins.reportable() }
		// Keep the CPU awake for the poll loop while the bridge runs (background delivery).
		acquireWakeLock()
		// connect() runs register (setting the Gateway id, cursor, epoch) and the
		// gateway-id migration; start the poll loop only after it, so the loop never
		// qualifies an inbound team under an unknown Gateway id and strands a bare-keyed
		// thread beside its migrated twin. connect() never throws, so polling starts.
		// sweepOrphanAttachments() must finish strictly before the drain starts: concurrently with a
		// drain it could delete a bucket a crash re-drain is about to re-reference (see its doc).
		// fireDueScheduledSends() is its own unconditional step, same reason: connect() swallows its
		// own failures internally, so gating the fire on it succeeding would starve the bounded-retry
		// policy exactly when firing offline is the whole point of checking. This same call is what
		// re-arms the alarm after a reboot (BootReceiver -> SwitchboardService.start() -> onCreate()
		// -> this chain) - no separate re-arm step needed there.
		scope.launch(Dispatchers.IO) {
			repo.connect()
			repo.reconcilePending()
			repo.attachments.sweepOrphanAttachments()
			repo.scheduled.fireDueScheduledSends()
			repo.drain.start(scope)
		}

		// Keep the persistent notification's state line current, reconcile every team's bar
		// notification against the live unread map, and stop the service entirely if the user
		// clears provisioning. `collect` (not collectLatest): a reconcile must never be cancelled
		// mid-flight by the next emission, or a cancel/refresh it was about to issue is silently
		// dropped. The map (not just its sum) rides the distinctUntilChanged key so a same-sum
		// cross-team change (e.g. forget's re-anchor) still reconciles.
		scope.launch {
			repo.state
				.map { Triple(it.provisioned, it.health, it.unread) }
				.distinctUntilChanged()
				.collect { (provisioned, health, unread) ->
					if (!provisioned) {
						stopSelf()
						return@collect
					}
					notifications.updateStatusNotification(health, unread.values.sum())
					notifications.reconcileTeamNotifications(repo, unread)
				}
		}
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

	private var transport: SttsTransport? = null
	private var bubble: QueueBubble? = null

	/** Held for as long as a run has anything to say. Lives here rather than in the repository, which
	 * holds no Context by construction, and is driven off the same settled state every other surface
	 * reads so it cannot disagree with them about whether a run is going. */
	private val focus by lazy {
		SpeechFocus(
			this,
			alreadyPaused = { Repo.get(this).playback.transportState().second },
			onPause = { Repo.get(this).command { playback.pausePlayback() } },
			onResume = { Repo.get(this).command { playback.resumePlayback() } },
		)
	}

	/** Mirror the run onto the lockscreen and shade. Called on every playback event, since that is
	 * exactly when what a transport should show has changed. */
	private fun publishTransport() {
		val repo = Repo.get(this)
		val (active, paused) = repo.playback.transportState()
		// Held while the app intends to make sound, which is what makes a hand pause give the user's
		// music back. A pause the FOCUS system caused keeps it instead - see focusHold.
		//
		// A refusal does NOT pause. It cannot: a refused request registers no listener, so no GAIN can
		// ever arrive to lift the pause, and the queue sits there full and silent with a play button the
		// user never pressed. Speaking without focus for a moment is recoverable; a run that can never
		// start is not. This retries on every event instead, so focus and its listener are picked up the
		// moment they are grantable.
		when (focusHold(active, paused, focus.holdingForResume)) {
			FocusHold.ACQUIRE -> focus.acquire()
			FocusHold.KEEP -> Unit
			FocusHold.RELEASE -> focus.release()
		}
		transport?.publish(active, paused, null)
		val manager = getSystemService(NotificationManager::class.java)
		val counts = repo.playback.queueCounts()
		// Three states, not two. A run gets the media notification; a finished run that dropped
		// something gets an ALERT, because the transport's controls have nothing left to act on and an
		// entry titled "Speaking" over silence is a lie with two dead buttons on it. The alert still
		// has to exist: this is the only route into the queue list that needs no permission, so
		// cancelling on "run over" left anyone without the overlay grant no way to see what was lost.
		transport?.let {
			when {
				active -> manager.notify(TRANSPORT_NOTIFICATION_ID, it.notification(paused, null, openQueuePending()))
				counts.third > 0 ->
					manager.notify(TRANSPORT_NOTIFICATION_ID, it.alert(counts.third, CHANNEL_SPEECH_FAILED, openQueuePending()))
				else -> manager.cancel(TRANSPORT_NOTIFICATION_ID)
			}
		}
		// The bubble draws on the same settled state, so it cannot disagree with the shade about how
		// much is left. Touching views needs main; playback settles on the player's lanes.
		//
		// It OUTLIVES the run when something failed. Hiding on `active` alone took the alert away at the
		// exact moment it was supposed to start standing on its own: the last entry to fail is also the
		// one that drains the queue, so the dot appeared and vanished in the same breath and the user
		// was never told anything had been dropped.
		mainHandler.post {
			// A live run clears a hand dismissal: the swipe said "not this alert", not "never again".
			if (active) bubble?.undismiss()
			if (active || counts.third > 0) {
				bubble?.show(counts.first, counts.second, counts.third)
			} else {
				bubble?.hide()
			}
		}
	}

	private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

	/** The one way into the queue list, used by both the bubble and the transport notification's body,
	 * so the two cannot drift into opening different things. */
	private fun openQueueIntent(): Intent =
		Intent(this, MainActivity::class.java).putExtra(EXTRA_OPEN_QUEUE, true)

	private fun openQueuePending(): PendingIntent =
		PendingIntent.getActivity(
			this,
			REQUEST_OPEN_QUEUE,
			openQueueIntent(),
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)

	/**
	 * The chime as a playable file: the user's chosen system sound, or the bundled asset.
	 *
	 * Copied out rather than handed over as a Uri, because a raw resource has no path a MediaPlayer
	 * can open and the player deliberately deals only in files. Cached per source, so switching sounds
	 * and switching back does not re-copy, and a stale copy of a sound no longer chosen is simply never
	 * read again.
	 *
	 * A chosen sound that cannot be read falls back to the bundled asset. A revoked grant or a deleted
	 * ringtone should cost the boundary marker, not the run.
	 */
	private fun resolveChime(): java.io.File? {
		val repo = Repo.get(this)
		val chosen = repo.sttsChimeUri
		if (chosen == ChatRepository.CHIME_SILENT) return null
		if (chosen.isNotEmpty()) {
			copyChime("chime-${chosen.hashCode()}.audio") { contentResolver.openInputStream(Uri.parse(chosen)) }
				?.let { return it }
		}
		return copyChime("chime.audio") { resources.openRawResource(R.raw.stts_chime) }
	}

	/** Copied through a temp file and renamed, so a copy interrupted by a kill leaves no half-written
	 * file behind. A partial one would pass the exists-and-non-empty check forever after and play as a
	 * clipped chime that nothing would ever repair. */
	private fun copyChime(name: String, open: () -> java.io.InputStream?): java.io.File? {
		val dest = java.io.File(java.io.File(filesDir, "stts/${SttsPlayer.MARKER_TEAM}"), name)
		if (dest.isFile && dest.length() > 0L) return dest
		val tmp = java.io.File(dest.parentFile, "$name.tmp")
		return runCatching {
			dest.parentFile?.mkdirs()
			open().use { input -> tmp.outputStream().use { requireNotNull(input).copyTo(it) } }
			if (tmp.length() > 0L && tmp.renameTo(dest)) dest else null
		}.getOrNull().also { if (it == null) tmp.delete() }
	}

	override fun onDestroy() {
		destroyed = true
		val repo = Repo.get(this)
		repo.onInbound = null
		repo.scheduled.onScheduledSendFailed = null
		repo.playback.chimeSource = null
		repo.playback.onTransportChanged = null
		// Captured into a local first: the field is cleared below, and a lambda referencing the FIELD
		// would find it null by the time main ran it, leaking the window.
		focus.release()
		val leaving = bubble
		bubble = null
		mainHandler.post { leaving?.release() }
		transport?.release()
		transport = null
		getSystemService(NotificationManager::class.java).cancel(TRANSPORT_NOTIFICATION_ID)
		// The poll loop's transport is cancellable, but Kotlin cancellation is cooperative: a cancel
		// arriving in the loop's non-suspend tail still lets that pass finish normally - the loop can
		// still run one more decide() after this method returns, and scope.cancel() below cannot close
		// that window (see console-hardening.md Phase D). Nulling the scheduler makes that trailing
		// call a safe no-op instead of driving wakelock/alarm state through a destroyed instance; the
		// destroyed flag above (checked by
		// every DeepIdleScheduler method) is the real defense, since Android serializes Service
		// lifecycle callbacks - a newer instance's onCreate can never run concurrently with this
		// one's onDestroy, so an unconditional null here can never race a live registration either.
		repo.pushback.scheduler = null
		repo.scheduled.scheduledSendScheduler = null
		// A deliberate stop (unprovision) kills the pending alarm; a system process kill skips
		// onDestroy entirely, so the alarm PendingIntent survives and revives the service on its
		// own - the split this design relies on. Same story for the scheduled-send alarm: a
		// subsequent onCreate's own unconditional fireDueScheduledSends() re-arms it from whatever is
		// still persisted, exactly like the poll ladder re-arms itself once polling resumes. A stray
		// per-team retry alarm is deliberately left alone here (no live registry of which teams
		// currently have one outstanding) - it re-checks state fresh at fire time and no-ops
		// harmlessly if nothing still matches, so it is safe, not just unhandled.
		alarmManager().cancel(pollAlarmPi())
		alarmManager().cancel(scheduledSendAlarmPi())
		releaseWakeLock()
		releasePassLock()
		scope.cancel()
		super.onDestroy()
	}

	/**
	 * Both types are declared for the service's whole life, never toggled. API 34 enforces per-type,
	 * and a service that dropped mediaPlayback while idle would have to re-acquire it at the moment
	 * playback starts - from a background poll, which is exactly when the platform can refuse. The
	 * cost of holding it is a manifest declaration; the cost of toggling is a class of failure that
	 * only appears on someone else's device.
	 */
	private fun startInForeground() {
		val notification = notifications.buildStatusNotification("Connecting...", 0)
		startForeground(
			STATUS_NOTIFICATION_ID,
			notification,
			ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
		)
	}

	companion object {
		const val TRANSPORT_NOTIFICATION_ID = 4271

		const val CHANNEL_STATUS = "status"
		const val CHANNEL_SPEECH_FAILED = "speech_failed"
		const val STATUS_NOTIFICATION_ID = 1
		const val EXTRA_OPEN_TEAM = "open_team"
		const val EXTRA_MESSAGE_AT = "message_at"
		const val EXTRA_OPEN_QUEUE = "open_queue"

		/** Its own request code, so the queue's PendingIntent cannot collapse into a team's. */
		private const val REQUEST_OPEN_QUEUE = 4272

		/** The user swiped the status entry away this process; stop re-posting it.
		 * Reset on service start so it returns with the next boot/launch. */
		@Volatile var statusDismissed = false

		// Forwarders onto [ServiceNotifications], which owns the notification surface. Kept because
		// ScheduledSendTest and MainActivity reach these names through SwitchboardService.
		internal const val SCHEDULED_SEND_FAILED_ID_RANGE_START = ServiceNotifications.SCHEDULED_SEND_FAILED_ID_RANGE_START
		internal const val SCHEDULED_SEND_FAILED_ID_RANGE_SIZE = ServiceNotifications.SCHEDULED_SEND_FAILED_ID_RANGE_SIZE

		internal fun scheduledSendFailedNotificationId(team: String): Int =
			ServiceNotifications.scheduledSendFailedNotificationId(team)

		fun cancelTeamNotification(context: Context, team: String) {
			ServiceNotifications.cancelTeamNotification(context, team)
		}

		fun cancelScheduledSendFailedNotification(context: Context, team: String) {
			ServiceNotifications.cancelScheduledSendFailedNotification(context, team)
		}

		/** Start (or no-op if already running) once the app is provisioned. */
		fun start(context: Context) {
			ContextCompat.startForegroundService(context, Intent(context, SwitchboardService::class.java))
		}

		/** Request code for the poll alarm's PendingIntent. The target component
		 * (PollAlarmReceiver, otherwise unused) already rules out any collision with an existing
		 * notification PendingIntent, so a single fixed code is enough. */
		private const val POLL_ALARM_RC = 1

		/** Request code for the single shared "next-due" scheduled-send alarm's PendingIntent -
		 * distinct component (ScheduledSendAlarmReceiver) AND action (ACTION_FIRE_DUE) from every
		 * other PendingIntent in this file, so the numeric value only needs to avoid other codes on
		 * the SAME component/action pairing (none exist), not the whole file's codes. */
		private const val SCHEDULED_SEND_ALARM_RC = 2

		/** Each (team, opId) pair's bounded retry gets its own request code, hashed into a range well
		 * clear of every fixed code above - hashing on team ALONE would let two sequential failures
		 * for the SAME team (a fresh schedule reuses the team the moment the prior one fires, cleared
		 * regardless of outcome) silently replace each other's still-pending retry via
		 * FLAG_UPDATE_CURRENT, since extras are not part of PendingIntent identity. opId is unique per
		 * schedule, so folding it into the hash disambiguates both that case and two different teams
		 * failing together. Mirrors teamNotificationId's own hashed-range shape. */
		internal const val SCHEDULED_SEND_RETRY_RC_START = 10_000
		internal const val SCHEDULED_SEND_RETRY_RC_SIZE = 1_000_000

		// Internal (not private): a pure Int-hash function, unit-tested without Android or a live
		// Service instance the same way IdlePushbackManager's own pure functions are.
		internal fun scheduledSendRetryRc(team: String, opId: String): Int =
			SCHEDULED_SEND_RETRY_RC_START + ("$team $opId".hashCode() and 0x7FFFFFFF) % SCHEDULED_SEND_RETRY_RC_SIZE

		// Deep-tier PASS wakelock, shared by the receiver, holdPass, and enterDeepSleep/
		// exitDeepSleep as ONE companion-object lock, never a service-instance field:
		// PollAlarmReceiver must be able to bridge a wakeup BEFORE a live SwitchboardService
		// instance necessarily exists (a dead-process revival is the entire point of it acquiring
		// this).
		@Volatile private var passLock: PowerManager.WakeLock? = null

		private fun passLock(context: Context): PowerManager.WakeLock =
			passLock ?: synchronized(this) {
				passLock ?: (context.applicationContext.getSystemService(POWER_SERVICE) as PowerManager)
					// Distinct tag from the active lock's "switchboard:poll-loop", for battery attribution.
					.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "switchboard:poll-pass")
					// Timeout-only acquisition, matching the active lock's own setReferenceCounted(false)
					// - the two footgun patterns (plain acquire + timeout acquire on one lock) never mix.
					.apply { setReferenceCounted(false) }
					.also { passLock = it }
			}

		/** Acquired by the alarm receiver BEFORE it returns, bridging AlarmManager's own
		 * onReceive-scoped wakeup into the async pass that follows - possibly before a live
		 * service instance exists at all. */
		fun acquirePassLock(context: Context, timeoutMs: Long) {
			passLock(context).acquire(timeoutMs)
		}

		private fun releasePassLock() {
			passLock?.let { if (it.isHeld) it.release() }
		}
	}
}
