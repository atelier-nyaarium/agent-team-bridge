package com.atelier_nyaarium.switchboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Fires the idle pushback ladder's deep-tier wakeup, scheduled by
 * [SwitchboardService.enterDeepSleep]. Bridges AlarmManager's own onReceive-scoped wakeup into
 * the pass that follows, including a dead-process revival where the service instance does not
 * exist yet. */
class PollAlarmReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		// The crash-log hook is otherwise only installed by MainActivity.onCreate; a deep-tier
		// revival (no Activity ever launched this process lifetime) would crash with no
		// ring/ingest trace.
		DebugLog.init(context)
		// AlarmManager's own implicit wakelock only spans this call; the pass runs async in the
		// service process. Bridge with the timeout'd pass lock BEFORE returning - the SAME
		// companion-object lock SwitchboardService.holdPass/enterDeepSleep operate on, not a
		// second one (a distinct instance here would never be released by the service side).
		SwitchboardService.acquirePassLock(context, PassOwner.POLL, PASS_TIMEOUT_MS) // see IdlePushbackManager.kt
		// A dead-process revival's startForegroundService can be refused (ForegroundServiceStart-
		// NotAllowedException, API 31+) if this alarm ever fired inexactly - only reachable on an
		// OEM that revokes USE_EXACT_ALARM despite it being auto-granted at minSdk 33. Caught so a
		// refusal degrades to the ladder staying dormant (recovered by the user next opening the
		// app, or a reboot) instead of crashing this broadcast on top of it.
		try {
			SwitchboardService.start(context) // revive after process death - the alarm PI survives
		} catch (e: Exception) {
			DebugLog.log("Idle", "poll alarm revival refused: $e")
		}
		Repo.get(context).kickPoll()
	}
}
