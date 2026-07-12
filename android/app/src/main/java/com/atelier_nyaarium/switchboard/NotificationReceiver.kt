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
		val team = intent.getStringExtra(SwitchboardService.EXTRA_OPEN_TEAM) ?: return
		val at = intent.getLongExtra(SwitchboardService.EXTRA_MESSAGE_AT, -1L)
		when (intent.action) {
			ACTION_MARK_READ -> Repo.get(context).markRead(team)
			ACTION_PLAY_FULL -> if (at > 0) Repo.get(context).playMessage(team, at, SttsPlayer.Tier.FULL)
			ACTION_PLAY_SUMMARY -> if (at > 0) Repo.get(context).playMessage(team, at, SttsPlayer.Tier.SUMMARY)
		}
	}

	companion object {
		const val ACTION_MARK_READ = "com.atelier_nyaarium.switchboard.MARK_READ"
		const val ACTION_PLAY_FULL = "com.atelier_nyaarium.switchboard.PLAY_FULL"
		const val ACTION_PLAY_SUMMARY = "com.atelier_nyaarium.switchboard.PLAY_SUMMARY"
		const val ACTION_STATUS_DISMISSED = "com.atelier_nyaarium.switchboard.STATUS_DISMISSED"
	}
}
