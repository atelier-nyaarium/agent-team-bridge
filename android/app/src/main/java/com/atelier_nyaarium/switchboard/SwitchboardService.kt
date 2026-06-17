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
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Foreground service that owns the bridge connection and poll loop, so messages
 * keep arriving (and become notifications) while the Activity is backgrounded or
 * the screen is off. The Activity only observes the shared Repo state. Cadence is
 * adaptive: the repository polls fast while the Activity is visible and once a
 * minute otherwise, draining accumulated bursts.
 *
 * Deep doze still gates network unless the user grants the battery-optimization
 * exemption (Settings row); the service itself only guarantees process lifetime.
 */
class SwitchboardService : Service() {
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

	// Held for the service's polling lifetime so the poll loop's wall-clock sleep
	// resumes through Doze (which otherwise parks the CPU, the "stops polling when
	// backgrounded" bug). This keeps the CPU partially awake while the bridge runs -
	// the deliberate battery cost of background delivery without a push service. Doze
	// can still defer the NETWORK unless the battery-optimization exemption is granted
	// (Settings -> Background delivery), so the two work together.
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
		// Keep the CPU awake for the poll loop while the bridge runs (background delivery).
		acquireWakeLock()
		// connect() runs register (which sets the Host id, cursor, epoch) and the
		// on-device host-id migration; start the poll loop only after it, so the
		// loop never qualifies an inbound team under an as-yet-unknown Host id and
		// strands a bare-keyed thread beside its migrated, qualified twin. connect()
		// never throws (it catches internally), so the poll loop always starts.
		scope.launch(Dispatchers.IO) {
			repo.connect()
			repo.reconcilePending()
			repo.startPolling(scope)
		}

		// Keep the persistent notification's state line current, and stop the
		// service entirely if the user clears provisioning.
		scope.launch {
			repo.state
				.map { Triple(it.provisioned, it.health, it.unread.values.sum()) }
				.distinctUntilChanged()
				.collectLatest { (provisioned, health, unread) ->
					if (!provisioned) {
						stopSelf()
						return@collectLatest
					}
					updateStatusNotification(health, unread)
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
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
			startForeground(STATUS_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
		} else {
			startForeground(STATUS_NOTIFICATION_ID, notification)
		}
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

	/** Broadcast to NotificationReceiver for swipe/action handling. The request
	 * code mixes team and action so per-team intents never collide; the message
	 * `at` rides as an extra and FLAG_UPDATE_CURRENT keeps it on the burst-last
	 * message, which is what the notification summarizes. */
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
			ChatState.Health.DEGRADED -> "Reconnecting..."
			ChatState.Health.OFFLINE -> "Offline"
		}
		if (!canNotify()) return
		// Respect a swipe-dismissal: once the user clears the status entry, state
		// changes must not resurrect it. It returns on the next service start.
		if (statusDismissed) return
		NotificationManagerCompat.from(this).notify(STATUS_NOTIFICATION_ID, buildStatusNotification(line, unread))
	}

	/** One notification per team, summarizing that team's unread burst. Suppressed
	 * while the Activity is visible (the user is already looking at the app). */
	private fun notifyBurst(repo: ChatRepository, team: String, messages: List<Message>) {
		if (repo.isVisible || !canNotify()) return
		val state = repo.state.value
		val label = state.label(team, state.localSwitchId)
		val unread = state.unread[team] ?: messages.size
		val style = NotificationCompat.InboxStyle()
		for (m in messages.takeLast(5)) {
			// A notice carries a purpose-written notification line; its body may be
			// a long report that would truncate uselessly here.
			val line = (m.title ?: m.text).replace(Regex("\\s+"), " ").trim()
			style.addLine(if (line.isEmpty()) "(attachment)" else line.take(120))
		}
		val last = messages.last()
		val builder = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
			.setSmallIcon(android.R.drawable.stat_notify_chat)
			.setContentTitle(label)
			.setContentText(if (unread > 1) "$unread messages" else (last.title ?: last.text).take(120))
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
		val notification = builder.build()
		NotificationManagerCompat.from(this).notify(teamNotificationId(team), notification)
	}

	private fun canNotify(): Boolean =
		Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
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

		fun cancelTeamNotification(context: Context, team: String) {
			NotificationManagerCompat.from(context).cancel(teamNotificationId(team))
		}
	}
}
