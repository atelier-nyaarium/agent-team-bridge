package com.atelier_nyaarium.switchboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles the message-notification actions that must work without opening the
 * Activity: swiping a team's notification away marks that team read, and the
 * Play actions speak the burst-last message through SttsPlayer. playMessage
 * hands the entire resolution (credential decrypt included) to the player's
 * daemon thread, so this receiver does zero disk or crypto work on main and
 * needs no goAsync; single-flight dedupes multi-taps. Unread is derived from a
 * persisted read anchor, so mark-read survives a process death instead of
 * degrading to a no-op.
 */
class NotificationReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		if (intent.action == ACTION_STATUS_DISMISSED) {
			SwitchboardService.statusDismissed = true
			return
		}
		// Transport buttons act on the RUN, not on a message, so they carry no team or `at` and must
		// be handled before the extras below are required.
		val repo = Repo.get(context)
		when (intent.action) {
			SttsTransport.ACTION_PLAY -> return repo.command { resumePlayback() }
			SttsTransport.ACTION_PAUSE -> return repo.command { pausePlayback() }
			SttsTransport.ACTION_SKIP -> return repo.command { skipPlayback() }
		}
		val team = intent.getStringExtra(SwitchboardService.EXTRA_OPEN_TEAM) ?: return
		val at = intent.getLongExtra(SwitchboardService.EXTRA_MESSAGE_AT, -1L)
		when (intent.action) {
			ACTION_MARK_READ -> repo.markRead(team)
			// Queued rather than played directly, like the in-thread tap: a playback outside the queue
			// is invisible to the row, the bubble and the lockscreen, all three of which report what the
			// queue is doing. It also stops a notification tap racing a run already in progress.
			ACTION_PLAY_FULL ->
				if (at > 0) repo.command { enqueueForPlay(team, at, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false) }
			ACTION_PLAY_SUMMARY ->
				if (at > 0) repo.command { enqueueForPlay(team, at, SttsPlayer.Tier.SUMMARY, announceRun = false, requireFollowed = false) }
		}
	}

	companion object {
		const val ACTION_MARK_READ = "com.atelier_nyaarium.switchboard.MARK_READ"
		const val ACTION_PLAY_FULL = "com.atelier_nyaarium.switchboard.PLAY_FULL"
		const val ACTION_PLAY_SUMMARY = "com.atelier_nyaarium.switchboard.PLAY_SUMMARY"
		const val ACTION_STATUS_DISMISSED = "com.atelier_nyaarium.switchboard.STATUS_DISMISSED"
	}
}
