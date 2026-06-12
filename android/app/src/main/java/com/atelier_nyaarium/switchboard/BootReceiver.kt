package com.atelier_nyaarium.switchboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restart the bridge service after a reboot, but only if the app is provisioned
 * (an unprovisioned service immediately stops itself anyway; this just avoids the
 * notification flash). BOOT_COMPLETED is an allowed background-start exemption
 * for foreground services. */
class BootReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
		// Defensive around the encrypted store: BOOT_COMPLETED fires post-unlock on
		// modern Android, but if the keystore is somehow unavailable we skip rather
		// than fall back to (or crash on) an unreadable store. The app launch will
		// start the service normally later.
		val provisioned = runCatching { ProvisioningStore(context).load() != null }.getOrDefault(false)
		if (!provisioned) return
		SwitchboardService.start(context)
	}
}
