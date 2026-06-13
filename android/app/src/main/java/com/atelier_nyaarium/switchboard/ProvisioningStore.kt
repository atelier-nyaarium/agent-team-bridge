package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Encrypted-at-rest storage for the provisioning blob (which holds the SA + app
 * tokens), the biometric-lock flag, and the serialized chat transcript. Falls back
 * to plain prefs only if the device keystore is unavailable.
 */
class ProvisioningStore(context: Context) {
	private val prefs: SharedPreferences = run {
		val ctx = context.applicationContext
		runCatching {
			val key = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
			EncryptedSharedPreferences.create(
				ctx,
				"switchboard-secure",
				key,
				EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
				EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
			)
		}.getOrElse { ctx.getSharedPreferences("switchboard", Context.MODE_PRIVATE) }
	}

	fun save(blob: String) = prefs.edit().putString(KEY_BLOB, blob).apply()

	fun load(): String? = prefs.getString(KEY_BLOB, null)

	fun clear() = prefs.edit().clear().apply()

	var biometricLock: Boolean
		get() = prefs.getBoolean(KEY_BIO, false)
		set(value) {
			prefs.edit().putBoolean(KEY_BIO, value).apply()
		}

	/** TTS voice settings live in prefs, not the blob: the blob carries only
	 * credentials, and these are user taste a re-provision should not reset.
	 * The provider is stored by descriptor id; voice is per-provider. */
	var sttsProvider: String
		get() = prefs.getString(KEY_STTS_PROVIDER, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_STTS_PROVIDER, value).apply()
		}

	/** Legacy single global voice (pre per-provider). Seeded into the current
	 * provider's per-provider key once, then unused. */
	var sttsVoice: String
		get() = prefs.getString(KEY_STTS_VOICE, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_STTS_VOICE, value).apply()
		}

	fun sttsVoiceFor(providerId: String): String = prefs.getString(KEY_STTS_VOICE_PREFIX + providerId, "") ?: ""

	fun setSttsVoiceFor(providerId: String, voice: String) {
		prefs.edit().putString(KEY_STTS_VOICE_PREFIX + providerId, voice).apply()
	}

	fun saveThreads(json: String) = prefs.edit().putString(KEY_THREADS, json).apply()

	fun loadThreads(): String? = prefs.getString(KEY_THREADS, null)

	fun saveLabels(json: String) = prefs.edit().putString(KEY_LABELS, json).apply()

	fun loadLabels(): String? = prefs.getString(KEY_LABELS, null)

	private companion object {
		const val KEY_BLOB = "provisioning"
		const val KEY_BIO = "biometric_lock"
		const val KEY_THREADS = "threads"
		const val KEY_LABELS = "labels"
		const val KEY_STTS_PROVIDER = "stts_provider"
		const val KEY_STTS_VOICE = "stts_voice"
		const val KEY_STTS_VOICE_PREFIX = "stts_voice."
	}
}
