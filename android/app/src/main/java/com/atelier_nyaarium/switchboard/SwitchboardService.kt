package com.atelier_nyaarium.switchboard

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.text.format.DateFormat
import androidx.core.app.NotificationCompat
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

/** Whether a team's burst should get full notification treatment (banner + TTS). The
 * burst still bumps unread/mailbox state in the drain loop regardless of this decision - it only
 * gates `notifyBurst`'s banner/TTS path. False while the Activity is visible (the user is already
 * looking at the app), notifications are otherwise unavailable, or the team's tab is muted
 * (explicitly Closed and not yet reopened; a never-opened team is not muted). */
internal fun shouldNotifyBurst(isVisible: Boolean, canNotify: Boolean, closedTeams: Set<String>, team: String): Boolean =
	!isVisible && canNotify && team !in closedTeams

/** A peer-mirror row's notification/TTS text, framed as "from -> to: text" so it never reads as
 * if addressed to this console - neither party in a peer-mirror row is this console's own team,
 * unlike every other row this is applied to. */
internal fun peerFramed(state: ChatState, m: Message, text: String): String {
	if (!m.isPeer) return text
	val fromLabel = m.from?.let { state.label(it, state.localGatewayId) } ?: "?"
	val toLabel = m.to?.let { state.label(it, state.localGatewayId) }
	return if (toLabel != null) "$fromLabel → $toLabel: $text" else "$fromLabel: $text"
}

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

	// Nulling pushback.scheduler in onDestroy closes the DOMINANT race (a poll pass that reaches
	// decide() only after onDestroy has already returned). The poll loop's transport is cancellable,
	// but that does not close this race: Kotlin cancellation is cooperative, and a cancel arriving in
	// the loop's non-suspend tail (drain bookkeeping, the try-exit gap, after the last suspension
	// point) still lets that pass complete normally, decide() included - permanent, not something a
	// rethrow discipline can fix (see console-hardening.md Phase D). This flag closes the narrower
	// residual: decide() can still latch this instance as the scheduler a few instructions before
	// that null-write lands, then invoke a method on it after onDestroy has already cancelled the
	// alarm and released both locks. Checked first in every DeepIdleScheduler method, so that stale
	// call can no longer re-acquire an un-timed wakelock nothing would ever release, or re-arm an
	// alarm this instance just cancelled.
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
		if (!canNotify() || statusDismissed) return
		val at = DateFormat.format("HH:mm", wakeAtMillis)
		val unread = Repo.get(this).state.value.unread.values.sum()
		NotificationManagerCompat.from(this).notify(STATUS_NOTIFICATION_ID, buildStatusNotification("Idle - next check $at", unread))
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
	 * pending record across every team (see ChatRepository.rearmScheduledSendAlarm), never a
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
		createChannels()
		startInForeground()

		val repo = Repo.get(this)
		if (!repo.state.value.provisioned) {
			stopSelf()
			return
		}
		repo.onInbound = { team, messages -> notifyBurst(repo, team, messages) }
		repo.onScheduledSendFailed = { team, opId -> notifyScheduledSendFailed(repo, team, opId) }
		repo.pushback.scheduler = this
		repo.scheduledSendScheduler = this
		// Boot the plugin framework BEFORE the poll loop starts: booting wires the data-plane bridge
		// onto the repo (once per process), so no inbound message is drained-and-committed before a
		// subscriber exists (the cursor never re-delivers). Idempotent - the Activity may also boot it.
		com.atelier_nyaarium.switchboard.plugins.Plugins.get(this)
		// Keep the CPU awake for the poll loop while the bridge runs (background delivery).
		acquireWakeLock()
		// connect() runs register (setting the Gateway id, cursor, epoch) and the
		// gateway-id migration; start the poll loop only after it, so the loop never
		// qualifies an inbound team under an unknown Gateway id and strands a bare-keyed
		// thread beside its migrated twin. connect() never throws, so polling starts.
		// sweepOrphanAttachments() must finish strictly before startPolling: concurrently with a
		// drain it could delete a bucket a crash re-drain is about to re-reference (see its doc).
		// fireDueScheduledSends() is its own unconditional step, same reason: connect() swallows its
		// own failures internally, so gating the fire on it succeeding would starve the bounded-retry
		// policy exactly when firing offline is the whole point of checking. This same call is what
		// re-arms the alarm after a reboot (BootReceiver -> SwitchboardService.start() -> onCreate()
		// -> this chain) - no separate re-arm step needed there.
		scope.launch(Dispatchers.IO) {
			repo.connect()
			repo.reconcilePending()
			repo.sweepOrphanAttachments()
			repo.fireDueScheduledSends()
			repo.startPolling(scope)
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
					updateStatusNotification(health, unread.values.sum())
					reconcileTeamNotifications(repo, unread)
				}
		}
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

	override fun onDestroy() {
		destroyed = true
		val repo = Repo.get(this)
		repo.onInbound = null
		repo.onScheduledSendFailed = null
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
		repo.scheduledSendScheduler = null
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

	private fun startInForeground() {
		val notification = buildStatusNotification("Connecting...", 0)
		startForeground(STATUS_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
	}

	private fun createChannels() {
		val nm = getSystemService(NotificationManager::class.java)
		nm.createNotificationChannel(
			NotificationChannel(CHANNEL_STATUS, "Bridge status", NotificationManager.IMPORTANCE_MIN).apply {
				description = "Persistent connection state"
				setShowBadge(false)
			},
		)
		// Channels are immutable after creation; the original "messages" channel
		// shipped without an explicit sound, so audible alerts need this v2 id.
		nm.deleteNotificationChannel("messages")
		nm.createNotificationChannel(
			NotificationChannel(CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
				description = "New messages from agent sessions"
				setSound(
					android.provider.Settings.System.DEFAULT_NOTIFICATION_URI,
					android.media.AudioAttributes.Builder()
						.setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
						.setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
						.build(),
				)
				enableVibration(true)
			},
		)
		nm.createNotificationChannel(
			NotificationChannel(CHANNEL_SCHEDULED_SEND_FAILED, "Scheduled send failed", NotificationManager.IMPORTANCE_HIGH).apply {
				description = "A scheduled message could not be sent after its automatic retry"
				// Matches CHANNEL_MESSAGES: an unattended-failure alert is at least as consequential as
				// an ordinary new message, so a vibrate-only ringer must not leave it with zero physical
				// cue the way an unset (default-off) vibration would.
				enableVibration(true)
			},
		)
	}

	private fun contentIntent(team: String?): PendingIntent {
		val intent = Intent(this, MainActivity::class.java)
			.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
		if (team != null) intent.putExtra(EXTRA_OPEN_TEAM, team)
		return PendingIntent.getActivity(
			this,
			team?.hashCode() ?: 0,
			intent,
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)
	}

	/** Broadcast to NotificationReceiver for swipe/action handling. The request code
	 * mixes team and action so per-team intents never collide; the message `at` rides
	 * as an extra, and FLAG_UPDATE_CURRENT keeps it on the burst-last message. */
	private fun actionIntent(team: String, action: String, at: Long? = null): PendingIntent {
		val intent = Intent(this, NotificationReceiver::class.java).setAction(action).putExtra(EXTRA_OPEN_TEAM, team)
		if (at != null) intent.putExtra(EXTRA_MESSAGE_AT, at)
		return PendingIntent.getBroadcast(
			this,
			(team.hashCode() * 31) xor action.hashCode(),
			intent,
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)
	}

	private fun buildStatusNotification(stateLine: String, unread: Int): Notification =
		NotificationCompat.Builder(this, CHANNEL_STATUS)
			.setSmallIcon(android.R.drawable.stat_notify_chat)
			.setContentTitle("Switchboard")
			.setContentText(if (unread > 0) "$stateLine - $unread unread" else stateLine)
			.setOngoing(true)
			.setOnlyAlertOnce(true)
			.setContentIntent(contentIntent(null))
			// Android 13+ lets the user swipe a foreground-service notification
			// away (the service keeps running); this records the dismissal.
			.setDeleteIntent(
				PendingIntent.getBroadcast(
					this,
					0,
					Intent(this, NotificationReceiver::class.java).setAction(NotificationReceiver.ACTION_STATUS_DISMISSED),
					PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
				),
			)
			.build()

	private fun updateStatusNotification(health: ChatState.Health, unread: Int) {
		val line = when (health) {
			ChatState.Health.ONLINE -> "Bridge online"
			ChatState.Health.SYNCING -> "Finishing up enrollment..."
			ChatState.Health.DEGRADED -> "Reconnecting..."
			ChatState.Health.OFFLINE -> "Offline"
		}
		if (!canNotify()) return
		// Respect a swipe-dismissal: once the user clears the status entry, state
		// changes must not resurrect it. It returns on the next service start.
		if (statusDismissed) return
		NotificationManagerCompat.from(this).notify(STATUS_NOTIFICATION_ID, buildStatusNotification(line, unread))
	}

	/** Build a team's message notification from its CURRENT unread rows in `state` - shared by a
	 * fresh burst and a mid-drain count refresh, so the shade's preview lines, content text, and
	 * Play actions always reflect the team's real trailing unread rows, never a stale burst list.
	 * Null when the team has nothing unread (nothing to show). */
	private fun teamNotificationBuilder(repo: ChatRepository, state: ChatState, team: String): NotificationCompat.Builder? {
		val thread = state.threads[team].orEmpty()
		val rows = unreadRows(thread, state.readAnchors[team])
		val last = rows.lastOrNull() ?: return null
		val label = state.label(team, state.localGatewayId)
		val style = NotificationCompat.InboxStyle()
		for (m in rows.takeLast(5)) {
			// A notice carries a purpose-written notification line; its body may be
			// a long report that would truncate uselessly here.
			val line = peerFramed(state, m, (m.title ?: m.text).replace(Regex("\\s+"), " ").trim())
			style.addLine(if (line.isEmpty()) "(attachment)" else line.take(120))
		}
		val builder = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
			.setSmallIcon(android.R.drawable.stat_notify_chat)
			.setContentTitle(label)
			.setContentText(if (rows.size > 1) "${rows.size} messages" else peerFramed(state, last, (last.title ?: last.text)).take(120))
			.setStyle(style)
			.setAutoCancel(true)
			.setContentIntent(contentIntent(team))
			// Swiping the notification away reads the burst without opening the app.
			.setDeleteIntent(actionIntent(team, NotificationReceiver.ACTION_MARK_READ))
		// Play actions speak the burst-last message; omitted entirely when STTS
		// is unprovisioned so unconfigured installs see no dead buttons.
		if (repo.sttsReady()) {
			builder.addAction(0, "Play Full", actionIntent(team, NotificationReceiver.ACTION_PLAY_FULL, last.at))
			builder.addAction(0, "Play Summary", actionIntent(team, NotificationReceiver.ACTION_PLAY_SUMMARY, last.at))
		}
		return builder
	}

	/** A fresh unread burst arriving while backgrounded. See [shouldNotifyBurst] for the gating
	 * decision - the caller has already confirmed genuinely new content, so this always alerts (no
	 * setOnlyAlertOnce), unlike the mid-drain refresh in [reconcileTeamNotifications], which must
	 * never re-alert. */
	private fun notifyBurst(repo: ChatRepository, team: String, messages: List<Message>) {
		val state = repo.state.value
		if (!shouldNotifyBurst(repo.isVisible, canNotify(), state.closedTeams, team)) return
		val builder = teamNotificationBuilder(repo, state, team) ?: return
		NotificationManagerCompat.from(this).notify(teamNotificationId(team), builder.build())
	}

	/** A scheduled send's bounded one-shot retry also failed (see ChatRepository.
	 * kickScheduledSendRetry) - the error row is tap-to-retry forever, but unattended failure must
	 * never be silent. Per-team id (scheduledSendFailedNotificationId, its own range outside BOTH the
	 * per-team MESSAGE range and STATUS_NOTIFICATION_ID) rather than one shared slot: a single fixed
	 * id was tried first, but a red-team pass found that two teams failing close together (exactly
	 * the scenario the retry alarm's own per-team request-code hashing already exists to handle)
	 * would have the second team's post silently overwrite the first's still-unread content under
	 * NotificationManagerCompat's replace-in-place semantics - "unattended failure is never silent"
	 * failing for every team but whichever failed last. Per-team ids also make
	 * reconcileTeamNotifications's own level-based sweep (keyed on teamNotificationId, a DIFFERENT
	 * range) unable to touch this one, same protection the single shared id had, without needing any
	 * lock/tracking-field machinery to keep a "which team is showing" pointer in sync. Deliberately
	 * NOT gated on state.closedTeams either: a user who closed the tab after scheduling still needs
	 * to hear that it failed. */
	private fun notifyScheduledSendFailed(repo: ChatRepository, team: String, opId: String) {
		if (!canNotify()) return
		val state = repo.state.value
		val label = state.label(team, state.localGatewayId)
		val notification = NotificationCompat.Builder(this, CHANNEL_SCHEDULED_SEND_FAILED)
			.setSmallIcon(android.R.drawable.stat_notify_error)
			.setContentTitle("Scheduled send failed")
			.setContentText("Could not send to $label")
			.setAutoCancel(true)
			.setContentIntent(contentIntent(team))
			.build()
		NotificationManagerCompat.from(this).notify(scheduledSendFailedNotificationId(team), notification)
	}

	/** Reconcile every team's bar notification against the live unread map, LEVEL-based (judged
	 * fresh each emission against the actual shade contents, never against a remembered prior
	 * emission - so a process restart's first emission converges cleanly and conflation/
	 * cancellation of the collector can never skip a state). Only a team with a notification
	 * CURRENTLY SHOWING is touched: cancel it once its count reaches 0 (the scroll-driven read
	 * model's own bar-clear signal, replacing the old cancel-on-open sites), or silently refresh
	 * its content while draining. A tap-consumed (autoCancel) or never-posted (visible-arrival,
	 * muted) team is presence-checked out, so this can never fabricate a notification the burst
	 * path itself would not have posted, nor re-alert one the user already dismissed by tapping. */
	private fun reconcileTeamNotifications(repo: ChatRepository, unread: Map<String, Int>) {
		if (!canNotify()) return
		val active = getSystemService(NotificationManager::class.java).activeNotifications.mapTo(HashSet()) { it.id }
		if (active.isEmpty()) return
		val state = repo.state.value
		val nmc = NotificationManagerCompat.from(this)
		for (team in state.threads.keys) {
			val id = teamNotificationId(team)
			if (id !in active) continue
			// A team muted via Close Tab must not have its already-showing notification silently
			// updated with new content - shouldNotifyBurst already refuses to POST for a muted team;
			// this is the same gate applied to an existing entry instead of a fresh one.
			if (team in state.closedTeams || (unread[team] ?: 0) <= 0) {
				nmc.cancel(id)
			} else {
				teamNotificationBuilder(repo, state, team)?.let { nmc.notify(id, it.setOnlyAlertOnce(true).build()) }
			}
		}
	}

	private fun canNotify(): Boolean =
		checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

	companion object {
		const val CHANNEL_STATUS = "status"
		const val CHANNEL_MESSAGES = "messages_v2"
		const val CHANNEL_SCHEDULED_SEND_FAILED = "scheduled_send_failed"
		const val STATUS_NOTIFICATION_ID = 1
		const val EXTRA_OPEN_TEAM = "open_team"
		const val EXTRA_MESSAGE_AT = "message_at"

		/** The user swiped the status entry away this process; stop re-posting it.
		 * Reset on service start so it returns with the next boot/launch. */
		@Volatile var statusDismissed = false

		private const val TEAM_ID_RANGE_START = 1000
		private const val TEAM_ID_RANGE_SIZE = 1_000_000

		/** Team notification ids live in their own range so a team name can never
		 * hash onto the persistent status notification's id - the init check below
		 * enforces it instead of leaving it as a comment-only claim. */
		private fun teamNotificationId(team: String): Int =
			TEAM_ID_RANGE_START + (team.hashCode() and 0x7FFFFFFF) % TEAM_ID_RANGE_SIZE

		// A scheduled send's failure notification, one PER TEAM - a single shared id was tried first
		// but let two teams failing close together silently overwrite each other's still-unread
		// content (NotificationManagerCompat.notify replaces in place). Its own range, disjoint from
		// TEAM_ID_RANGE, so reconcileTeamNotifications (which only ever computes teamNotificationId)
		// can never touch it - the same immunity the old single fixed id had, without needing a
		// lock/tracking-field to keep "which team is showing" in sync with reality.
		internal const val SCHEDULED_SEND_FAILED_ID_RANGE_START = 2_000_000
		internal const val SCHEDULED_SEND_FAILED_ID_RANGE_SIZE = 1_000_000

		// Internal (not private): a pure Int-hash function, unit-tested without Android or a live
		// Service instance the same way IdlePushbackManager's own pure functions are.
		internal fun scheduledSendFailedNotificationId(team: String): Int =
			SCHEDULED_SEND_FAILED_ID_RANGE_START + (team.hashCode() and 0x7FFFFFFF) % SCHEDULED_SEND_FAILED_ID_RANGE_SIZE

		init {
			require(STATUS_NOTIFICATION_ID < TEAM_ID_RANGE_START) {
				"STATUS_NOTIFICATION_ID must fall outside the team notification id range"
			}
			require(SCHEDULED_SEND_FAILED_ID_RANGE_START >= TEAM_ID_RANGE_START + TEAM_ID_RANGE_SIZE) {
				"SCHEDULED_SEND_FAILED_ID_RANGE must fall entirely outside the team notification id range"
			}
		}

		/** Dismiss a team's message notification. Forgetting a team drops its thread from
		 * `state.threads` entirely, so [reconcileTeamNotifications]'s own reconcile loop (keyed on
		 * that map) can never visit it again to cancel a still-showing entry - the forget call site
		 * must do it directly instead. */
		fun cancelTeamNotification(context: Context, team: String) {
			NotificationManagerCompat.from(context).cancel(teamNotificationId(team))
		}

		/** Dismiss team's scheduled-send failure notification (if any is showing) - same reason
		 * cancelTeamNotification above exists: forgetting drops the team from every state map
		 * reconcileTeamNotifications/reconcile logic could otherwise use to notice and clean it up. */
		fun cancelScheduledSendFailedNotification(context: Context, team: String) {
			NotificationManagerCompat.from(context).cancel(scheduledSendFailedNotificationId(team))
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
