package com.atelier_nyaarium.switchboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Cold-revival worst case for a scheduled-send fire: service start + repo entry (15s, matching
// PollAlarmReceiver's own identical revival cost) + connect()'s FOUR sequential round trips
// (apiReachable, submitConsoleAdmission, register, teams - each up to the default client's 15s
// connect + 20s read, i.e. 35s x 4 = 140s) + the send itself (ConsoleClient.
// PINNED_CONNECT_TIMEOUT_MS 15s + PINNED_READ_TIMEOUT_MS 35s = 50s). That sums to 15 + 140 + 50 =
// 205s; rounded up to 240s (not tightly to 205s) for real margin rather than none. An attachment
// upload is uncapped by design (600s per-write inactivity floor) and can outlive this lock on a
// slow link regardless; that is an accepted, recoverable corner (the row settles error/pending and
// the bounded retry or reconcilePending picks it up), not a case this constant tries to cover.
internal const val SCHEDULED_SEND_PASS_TIMEOUT_MS = 240_000L

/** Fires the scheduled-send alarm - either the single shared "next-due" wakeup (ACTION_FIRE_DUE,
 * see ChatRepository.fireDueScheduledSends) or one team's bounded one-shot retry after a failed
 * fire (ACTION_RETRY, carrying team/opId/targetDomainId as extras - see ChatRepository.
 * kickScheduledSendRetry). The service is usually already running (a persistent START_STICKY
 * foreground service), so this is primarily the WARM kick; the dead-process revival below mirrors
 * PollAlarmReceiver's own dual shape for the same reason (a corner, not the mainline). */
class ScheduledSendAlarmReceiver : BroadcastReceiver() {
	companion object {
		const val ACTION_FIRE_DUE = "com.atelier_nyaarium.switchboard.SCHEDULED_SEND_FIRE_DUE"
		const val ACTION_RETRY = "com.atelier_nyaarium.switchboard.SCHEDULED_SEND_RETRY"
		const val EXTRA_TEAM = "team"
		const val EXTRA_OP_ID = "op_id"
		const val EXTRA_TARGET_DOMAIN = "target_domain"
	}

	override fun onReceive(context: Context, intent: Intent) {
		// The crash-log hook is otherwise only installed by MainActivity.onCreate; a deep-tier
		// revival (no Activity ever launched this process lifetime) would crash with no ring/ingest
		// trace - mirrors PollAlarmReceiver's identical concern.
		DebugLog.init(context)
		// AlarmManager's own implicit wakelock only spans this call; the fire (and any network it
		// drives) runs async in the service process. Bridge with the SAME timeout'd pass lock
		// PollAlarmReceiver/SwitchboardService already share - a generic "keep the CPU up for a
		// bounded async pass" primitive, not something this feature needs its own copy of - just
		// with a larger timeout sized for this caller's own worst case (see the constant above).
		SwitchboardService.acquirePassLock(context, SCHEDULED_SEND_PASS_TIMEOUT_MS)
		// A dead-process revival's startForegroundService can be refused (ForegroundServiceStart-
		// NotAllowedException, API 31+) if this alarm ever fired inexactly - only reachable on an
		// OEM that revokes USE_EXACT_ALARM despite it being auto-granted at minSdk 33. Caught so a
		// refusal degrades to the schedule staying dormant (recovered by the user next opening the
		// app, or a reboot) instead of crashing this broadcast on top of it.
		try {
			SwitchboardService.start(context) // revive after process death - the alarm PI survives
		} catch (e: Exception) {
			DebugLog.log("ScheduledSend", "alarm revival refused: $e")
		}
		when (intent.action) {
			ACTION_RETRY -> {
				val team = intent.getStringExtra(EXTRA_TEAM) ?: return
				val opId = intent.getStringExtra(EXTRA_OP_ID) ?: return
				Repo.get(context).kickScheduledSendRetry(team, opId, intent.getStringExtra(EXTRA_TARGET_DOMAIN))
			}
			else -> Repo.get(context).kickScheduledSendFire()
		}
	}
}
