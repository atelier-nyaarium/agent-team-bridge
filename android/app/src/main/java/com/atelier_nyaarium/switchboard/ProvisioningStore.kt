package com.atelier_nyaarium.switchboard

import android.content.Context

/**
 * Persists the provisioning blob. Plain SharedPreferences for now; the biometric
 * lock + EncryptedSharedPreferences move is a later phase.
 */
class ProvisioningStore(context: Context) {
	private val prefs = context.getSharedPreferences("switchboard", Context.MODE_PRIVATE)

	fun save(blob: String) = prefs.edit().putString(KEY, blob).apply()

	fun load(): String? = prefs.getString(KEY, null)

	fun clear() = prefs.edit().remove(KEY).apply()

	private companion object {
		const val KEY = "provisioning"
	}
}
