package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.atelier_nyaarium.switchboard.crypto.Crypto

/**
 * Encrypted-at-rest storage for the provisioning blob (which holds the SA + app
 * tokens), the biometric-lock flag, and the serialized chat transcript. Falls back
 * to plain prefs only if the device keystore is unavailable.
 */
class ProvisioningStore(context: Context) {
	// True when the Keystore-backed store initialized. The federation private keys
	// are persisted ONLY when encrypted: refusing the plaintext fallback keeps the
	// Domain root signing key off disk in cleartext (fail closed).
	private var encrypted = false
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
			).also { encrypted = true }
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

	/** When on, an incoming message for a followed (open) thread is
	 * pre-synthesized before its notification, so Play is an instant cache hit. */
	var autoTts: Boolean
		get() = prefs.getBoolean(KEY_AUTO_TTS, false)
		set(value) {
			prefs.edit().putBoolean(KEY_AUTO_TTS, value).apply()
		}

	/** When on (with autoTts), the summary is played aloud automatically once it
	 * is synthesized, hands-free. */
	var autoPlaySummary: Boolean
		get() = prefs.getBoolean(KEY_AUTO_PLAY_SUMMARY, false)
		set(value) {
			prefs.edit().putBoolean(KEY_AUTO_PLAY_SUMMARY, value).apply()
		}

	fun saveThreads(json: String) = prefs.edit().putString(KEY_THREADS, json).apply()

	fun loadThreads(): String? = prefs.getString(KEY_THREADS, null)

	fun saveLabels(json: String) = prefs.edit().putString(KEY_LABELS, json).apply()

	fun loadLabels(): String? = prefs.getString(KEY_LABELS, null)

	/** The connected Host's id, learned from the register result. Anchors the
	 * composite (host, name) key; empty until a federation-aware arbiter reports it. */
	fun saveHostId(id: String) = prefs.edit().putString(KEY_HOST_ID, id).apply()

	fun loadHostId(): String = prefs.getString(KEY_HOST_ID, "") ?: ""

	/** This device's federation identity (the owner device's signing + box
	 * keypairs). Minted once at enroll-owner and reused to sign admissions. Persisted
	 * ONLY under the Keystore-backed store: if encryption is unavailable this throws
	 * rather than write the Domain root private key in cleartext (the caller surfaces
	 * the error and the owner retries when the keystore is healthy). */
	fun saveIdentity(identity: Crypto.Identity) {
		check(encrypted) { "secure storage unavailable; refusing to persist the federation key in cleartext" }
		prefs.edit().putString(KEY_IDENTITY, wireJson.encodeToString(Crypto.Identity.serializer(), identity)).apply()
	}

	fun loadIdentity(): Crypto.Identity? =
		prefs.getString(KEY_IDENTITY, null)?.let { json ->
			runCatching { wireJson.decodeFromString(Crypto.Identity.serializer(), json) }.getOrNull()
		}

	/** Whether evie has ROOTED the Domain at this device (set only on a successful
	 * enroll_redeem). Distinct from holding a keypair: a minted-but-not-redeemed
	 * identity must not present as an enrolled owner. */
	var federationRooted: Boolean
		get() = prefs.getBoolean(KEY_ROOTED, false)
		set(value) {
			prefs.edit().putBoolean(KEY_ROOTED, value).apply()
		}

	private companion object {
		const val KEY_BLOB = "provisioning"
		const val KEY_BIO = "biometric_lock"
		const val KEY_THREADS = "threads"
		const val KEY_LABELS = "labels"
		const val KEY_HOST_ID = "host_id"
		const val KEY_IDENTITY = "federation_identity"
		const val KEY_ROOTED = "federation_rooted"
		const val KEY_STTS_PROVIDER = "stts_provider"
		const val KEY_STTS_VOICE = "stts_voice"
		const val KEY_STTS_VOICE_PREFIX = "stts_voice."
		const val KEY_AUTO_TTS = "auto_tts"
		const val KEY_AUTO_PLAY_SUMMARY = "auto_play_summary"
	}
}
