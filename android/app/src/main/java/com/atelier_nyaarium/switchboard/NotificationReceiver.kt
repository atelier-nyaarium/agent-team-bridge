package com.atelier_nyaarium.switchboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles the message-notification actions that must work without opening the
 * Activity: swiping a team's notification away marks that team read, and the
 * Play action is a stub for an upcoming feature (it will consume the notice
 * `summary` tier). Unread is process-local state, so after a process death
 * there is nothing to clear and mark-read degrades to a no-op.
 */
class NotificationReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		val team = intent.getStringExtra(SwitchboardService.EXTRA_OPEN_TEAM) ?: return
		when (intent.action) {
			ACTION_MARK_READ -> Repo.get(context).markRead(team)
			ACTION_PLAY -> {
				// Stub: reserved for the upcoming play feature (reads the message's
				// summary tier). Intentionally no user-visible effect yet.
				android.util.Log.i("NotificationReceiver", "Play tapped for $team (stub)")
			}
		}
	}

	companion object {
		const val ACTION_MARK_READ = "com.atelier_nyaarium.switchboard.MARK_READ"
		const val ACTION_PLAY = "com.atelier_nyaarium.switchboard.PLAY"
	}
}
