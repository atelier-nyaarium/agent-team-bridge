package com.atelier_nyaarium.switchboard

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.atelier_nyaarium.switchboard.SwitchboardService.Companion.CHANNEL_SPEECH_FAILED
import com.atelier_nyaarium.switchboard.SwitchboardService.Companion.CHANNEL_STATUS
import com.atelier_nyaarium.switchboard.SwitchboardService.Companion.EXTRA_MESSAGE_AT
import com.atelier_nyaarium.switchboard.SwitchboardService.Companion.EXTRA_OPEN_TEAM
import com.atelier_nyaarium.switchboard.SwitchboardService.Companion.STATUS_NOTIFICATION_ID
import com.atelier_nyaarium.switchboard.SwitchboardService.Companion.TRANSPORT_NOTIFICATION_ID
import com.atelier_nyaarium.switchboard.SwitchboardService.Companion.statusDismissed

/**
 * [SwitchboardService]'s notification surface: the channels, the persistent status entry, each
 * team's message notification, and the scheduled-send failure alert.
 */
internal class ServiceNotifications(private val context: Context) {
	internal fun createChannels() {
		val nm = context.getSystemService(NotificationManager::class.java)
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
		// NOT the status channel. That one is MIN with no badge, which is right for "the bridge is
		// connected" and wrong for the only notice that a message was never spoken - it would have been
		// silent, badgeless, and absent from the status bar, which is indistinguishable from never
		// telling the user at all. DEFAULT rather than HIGH: nothing was lost, only unsaid.
		nm.createNotificationChannel(
			NotificationChannel(CHANNEL_SPEECH_FAILED, "Unspoken messages", NotificationManager.IMPORTANCE_DEFAULT).apply {
				description = "A message could not be read aloud"
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
		val intent = Intent(context, MainActivity::class.java)
			.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
		if (team != null) intent.putExtra(EXTRA_OPEN_TEAM, team)
		return PendingIntent.getActivity(
			context,
			team?.hashCode() ?: 0,
			intent,
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)
	}

	/** Broadcast to NotificationReceiver for swipe/action handling. The request code
	 * mixes team and action so per-team intents never collide; the message `at` rides
	 * as an extra, and FLAG_UPDATE_CURRENT keeps it on the burst-last message. */
	private fun actionIntent(team: String, action: String, at: Long? = null): PendingIntent {
		val intent = Intent(context, NotificationReceiver::class.java).setAction(action).putExtra(EXTRA_OPEN_TEAM, team)
		if (at != null) intent.putExtra(EXTRA_MESSAGE_AT, at)
		return PendingIntent.getBroadcast(
			context,
			(team.hashCode() * 31) xor action.hashCode(),
			intent,
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)
	}

	internal fun buildStatusNotification(stateLine: String, unread: Int): Notification =
		NotificationCompat.Builder(context, CHANNEL_STATUS)
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
					context,
					0,
					Intent(context, NotificationReceiver::class.java).setAction(NotificationReceiver.ACTION_STATUS_DISMISSED),
					PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
				),
			)
			.build()

	internal fun updateStatusNotification(health: ChatState.Health, unread: Int) {
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
		NotificationManagerCompat.from(context).notify(STATUS_NOTIFICATION_ID, buildStatusNotification(line, unread))
	}

	/** Build a team's message notification from its CURRENT unread rows in `state` - shared by a
	 * fresh burst and a mid-drain count refresh, so the shade's preview lines, content text, and
	 * Play actions always reflect the team's real trailing unread rows, never a stale burst list.
	 * Null when the team has nothing unread (nothing to show). */
	private fun teamNotificationBuilder(repo: ChatRepository, state: ChatState, team: String): NotificationCompat.Builder? {
		val thread = state.threads[team].orEmpty()
		val rows = unreadRows(thread, state.readAnchors[team])
		val last = rows.lastOrNull() ?: return null
		val label = state.label(team)
		val style = NotificationCompat.InboxStyle()
		for (m in rows.takeLast(5)) {
			// A notice carries a purpose-written notification line; its body may be
			// a long report that would truncate uselessly here.
			val line = peerFramed(state, m, oneLine(m.title) ?: oneLine(m.text) ?: "")
			style.addLine(if (line.isEmpty()) ATTACHMENT_STANDIN else line.take(120))
		}
		val builder = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
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
	internal fun notifyBurst(repo: ChatRepository, team: String, messages: List<Message>) {
		val state = repo.state.value
		if (!shouldNotifyBurst(repo.isVisible, canNotify(), state.closedTeams, team)) return
		val builder = teamNotificationBuilder(repo, state, team) ?: return
		NotificationManagerCompat.from(context).notify(teamNotificationId(team), builder.build())
	}

	/** A scheduled send's bounded one-shot retry also failed (see ChatRepository.
	 * kickScheduledSendRetry) - the error row is tap-to-retry forever, but unattended failure must
	 * never be silent. Uses its own PER-TEAM id (scheduledSendFailedNotificationId - see its own doc
	 * for why a single shared slot is not enough) so two teams failing close together each keep their
	 * own notification instead of the later one silently overwriting the earlier one's still-unread
	 * content under NotificationManagerCompat's replace-in-place semantics. Deliberately NOT gated on
	 * state.closedTeams either: a user who closed the tab after scheduling still needs to hear that
	 * it failed. */
	internal fun notifyScheduledSendFailed(repo: ChatRepository, team: String, opId: String) {
		if (!canNotify()) return
		val state = repo.state.value
		val label = state.label(team)
		val notification = NotificationCompat.Builder(context, CHANNEL_SCHEDULED_SEND_FAILED)
			.setSmallIcon(android.R.drawable.stat_notify_error)
			.setContentTitle("Scheduled send failed")
			.setContentText("Could not send to $label")
			.setAutoCancel(true)
			.setContentIntent(contentIntent(team))
			.build()
		NotificationManagerCompat.from(context).notify(scheduledSendFailedNotificationId(team), notification)
	}

	/** Reconcile every team's bar notification against the live unread map, LEVEL-based (judged
	 * fresh each emission against the actual shade contents, never against a remembered prior
	 * emission - so a process restart's first emission converges cleanly and conflation/
	 * cancellation of the collector can never skip a state). Only a team with a notification
	 * CURRENTLY SHOWING is touched: cancel it once its count reaches 0 (the scroll-driven read
	 * model's own bar-clear signal), or silently refresh
	 * its content while draining. A tap-consumed (autoCancel) or never-posted (visible-arrival,
	 * muted) team is presence-checked out, so this can never fabricate a notification the burst
	 * path itself would not have posted, nor re-alert one the user already dismissed by tapping. */
	internal fun reconcileTeamNotifications(repo: ChatRepository, unread: Map<String, Int>) {
		if (!canNotify()) return
		val active = context.getSystemService(NotificationManager::class.java).activeNotifications.mapTo(HashSet()) { it.id }
		if (active.isEmpty()) return
		val state = repo.state.value
		val nmc = NotificationManagerCompat.from(context)
		val liveIds = HashSet<Int>(state.threads.size)
		for (team in state.threads.keys) {
			val id = teamNotificationId(team)
			liveIds += id
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
		// A showing entry whose thread is gone: the loop above is keyed on live threads, so nothing
		// else can reach it. Identifiable because team ids occupy their own disjoint range, and safe
		// because a thread's absence is the same fact the loop cancels on when unread reaches 0.
		for (id in active) {
			if (id >= TEAM_ID_RANGE_START && id < TEAM_ID_RANGE_START + TEAM_ID_RANGE_SIZE && id !in liveIds) {
				nmc.cancel(id)
			}
		}
	}

	internal fun canNotify(): Boolean =
		context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

	companion object {
		const val CHANNEL_MESSAGES = "messages_v2"
		const val CHANNEL_SCHEDULED_SEND_FAILED = "scheduled_send_failed"

		private const val TEAM_ID_RANGE_START = 1000
		private const val TEAM_ID_RANGE_SIZE = 1_000_000

		/** Team notification ids live in their own range so a team name can never
		 * hash onto the persistent status notification's id - the init check below
		 * enforces it instead of leaving it as a comment-only claim. */
		private fun teamNotificationId(team: String): Int =
			TEAM_ID_RANGE_START + (team.hashCode() and 0x7FFFFFFF) % TEAM_ID_RANGE_SIZE

		// One PER TEAM (see notifyScheduledSendFailed's own doc for why a single shared slot is not
		// enough). Its own range, disjoint from TEAM_ID_RANGE, so reconcileTeamNotifications (which
		// only ever computes teamNotificationId) can never touch it.
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
			// The transport is the other notification that is NOT a thread's, and the range sweep in
			// reconcileTeamNotifications (and the wipe's cancel) cannot tell it apart by anything but id.
			require(TRANSPORT_NOTIFICATION_ID < TEAM_ID_RANGE_START) {
				"TRANSPORT_NOTIFICATION_ID must fall outside the team notification id range"
			}
			require(SCHEDULED_SEND_FAILED_ID_RANGE_START >= TEAM_ID_RANGE_START + TEAM_ID_RANGE_SIZE) {
				"SCHEDULED_SEND_FAILED_ID_RANGE must fall entirely outside the team notification id range"
			}
		}

		/** Dismiss a team's message notification, immediately. Forgetting drops the thread from
		 * `state.threads`, and [reconcileTeamNotifications] sweeps such orphans, but only on its next
		 * emission - a forget call site calls this so the entry goes at the moment of the gesture. */
		fun cancelTeamNotification(context: Context, team: String) {
			NotificationManagerCompat.from(context).cancel(teamNotificationId(team))
		}

		/** Dismiss team's scheduled-send failure notification (if any is showing) - same reason
		 * cancelTeamNotification above exists: forgetting drops the team from every state map
		 * reconcileTeamNotifications/reconcile logic could otherwise use to notice and clean it up. */
		fun cancelScheduledSendFailedNotification(context: Context, team: String) {
			NotificationManagerCompat.from(context).cancel(scheduledSendFailedNotificationId(team))
		}

		/** Dismiss every message and scheduled-send-failure notification at once, for a wipe. The
		 * service's own reconcile cannot: on `!provisioned` it stops itself BEFORE reconciling, and a
		 * wipe with the service already dead has nothing reconciling at all, so a wiped phone kept
		 * notifications that opened threads it no longer had. Scoped by id range, never `cancelAll()`:
		 * the foreground status notification and the playback transport live outside both ranges (the
		 * init check above is what keeps them there) and are the service's own to end. */
		fun cancelProvisioningNotifications(context: Context) {
			val manager = context.getSystemService(NotificationManager::class.java) ?: return
			val nmc = NotificationManagerCompat.from(context)
			for (shown in manager.activeNotifications) {
				val id = shown.id
				val message = id >= TEAM_ID_RANGE_START && id < TEAM_ID_RANGE_START + TEAM_ID_RANGE_SIZE
				val failed = id >= SCHEDULED_SEND_FAILED_ID_RANGE_START &&
					id < SCHEDULED_SEND_FAILED_ID_RANGE_START + SCHEDULED_SEND_FAILED_ID_RANGE_SIZE
				if (message || failed) nmc.cancel(id)
			}
		}
	}
}
