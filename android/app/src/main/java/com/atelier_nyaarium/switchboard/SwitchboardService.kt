package com.atelier_nyaarium.switchboard

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
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
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
 * only observes shared Repo state. The repository polls fast while the Activity is
 * visible and once a minute otherwise.
 *
 * Deep doze still gates network unless the user grants the battery-optimization
 * exemption (Settings row); the service only guarantees process lifetime.
 */
class SwitchboardService : Service() {
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

	// Held for the poll loop's lifetime so its wall-clock sleep resumes through Doze,
	// which otherwise parks the CPU. Keeps the CPU partially awake while the bridge
	// runs. Doze can still defer the NETWORK unless the battery-optimization exemption
	// is granted (Settings -> Background delivery).
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
		scope.launch(Dispatchers.IO) {
			repo.connect()
			repo.reconcilePending()
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
		Repo.get(this).onInbound = null
		releaseWakeLock()
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
			if ((unread[team] ?: 0) <= 0) {
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
		const val STATUS_NOTIFICATION_ID = 1
		const val EXTRA_OPEN_TEAM = "open_team"
		const val EXTRA_MESSAGE_AT = "message_at"

		/** The user swiped the status entry away this process; stop re-posting it.
		 * Reset on service start so it returns with the next boot/launch. */
		@Volatile var statusDismissed = false

		/** Team notification ids live in their own range so a team name can never
		 * hash onto the persistent status notification's id. */
		private fun teamNotificationId(team: String): Int = 1000 + (team.hashCode() and 0x7FFFFFFF) % 1_000_000

		/** Start (or no-op if already running) once the app is provisioned. */
		fun start(context: Context) {
			ContextCompat.startForegroundService(context, Intent(context, SwitchboardService::class.java))
		}
	}
}
