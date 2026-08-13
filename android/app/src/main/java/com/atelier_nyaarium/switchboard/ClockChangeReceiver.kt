package com.atelier_nyaarium.switchboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Re-syncs the scheduled-send alarm against a live system clock or timezone change - a manual
 * clock adjustment, or an NTP correction after a device boots with a stale RTC value. RTC_WAKEUP
 * alarms are wall-clock based (unlike ELAPSED_REALTIME, immune to this) and Android gives no other
 * signal that one might now be mistimed. This is a defensive re-sync, not a fix for the deeper (and
 * genuinely ambiguous) product question of whether a relative scheduling intent - "10 minutes from
 * when I tapped Schedule" - should be preserved across a clock jump at all; it re-derives the next
 * alarm from whatever fireAtMillis is already persisted, the same way ChatRepository.
 * fireDueScheduledSends's own end-of-pass re-arm already does on every fire and every schedule/
 * cancel/reschedule. ACTION_TIME_CHANGED and ACTION_TIMEZONE_CHANGED are both on Android's small
 * manifest-registration exemption
 * list from the Oreo+ implicit-broadcast restrictions, so a static receiver (not a dynamically
 * registered one) is the correct, always-on shape here - verified by simulating both broadcasts on
 * a real emulator and confirming this receiver actually fires. */
class ClockChangeReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		DebugLog.init(context)
		if (intent.action != Intent.ACTION_TIME_CHANGED && intent.action != Intent.ACTION_TIMEZONE_CHANGED) return
		// Defensive around the encrypted store, mirroring BootReceiver's identical guard: skip rather
		// than fall back to or crash on an unreadable store on an unprovisioned device with nothing to
		// re-sync anyway.
		val provisioned = runCatching { AppStateStore(context).load() != null }.getOrDefault(false)
		if (!provisioned) return
		DebugLog.log("ClockChange", "action=${intent.action}, re-syncing scheduled-send alarm")
		// The service may already be running (the mainline case - a clock change happens while the
		// app is alive far more often than while the process is dead) or not; start() is a no-op if
		// it already is, and kickScheduledSendFire() needs a live scheduledSendScheduler wiring either
		// way (see ScheduledSendOps.awaitSchedulerWired), which only a running service provides.
		try {
			SwitchboardService.start(context)
		} catch (e: Exception) {
			DebugLog.log("ClockChange", "service start refused: $e")
		}
		Repo.get(context).scheduled.kickScheduledSendFire()
	}
}
