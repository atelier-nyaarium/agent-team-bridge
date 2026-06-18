package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.SyncCursor

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

	/** The connected Switch's id, learned from the register result. Anchors the
	 * composite (switchId, name) key; empty until a federation-aware Switch reports it. */
	fun saveSwitchId(id: String) = prefs.edit().putString(KEY_SWITCH_ID, id).apply()

	fun loadSwitchId(): String = prefs.getString(KEY_SWITCH_ID, "") ?: ""

	/** The console-owned mailbox consumption cursor, durable across app restarts. The console
	 * resumes from its OWN cursor instead of re-adopting a server-dictated one, so the
	 * backlog that piled up while the app was closed is never acked away on the next poll.
	 * Null until the first commit (a fresh install). */
	fun saveSyncCursor(cursor: SyncCursor) {
		prefs.edit()
			.putLong(KEY_SYNC_EPOCH, cursor.epoch)
			.putLong(KEY_SYNC_ACKED, cursor.ackedSeq)
			.putLong(KEY_SYNC_DROPPED, cursor.droppedBaseline)
			.apply()
	}

	fun loadSyncCursor(): SyncCursor? {
		if (!prefs.contains(KEY_SYNC_EPOCH)) return null
		return SyncCursor.of(
			prefs.getLong(KEY_SYNC_EPOCH, 0L),
			prefs.getLong(KEY_SYNC_ACKED, 0L),
			prefs.getLong(KEY_SYNC_DROPPED, 0L),
		)
	}

	/** This Console's member identity (signing + box keypairs), admitted as
	 * kind:console so a Switch trusts its sealed ops. Persisted ONLY under the
	 * Keystore-backed store: if encryption is unavailable this throws rather than write
	 * the private key in cleartext (the caller surfaces the error and retries when the
	 * keystore is healthy). */
	fun saveIdentity(identity: Crypto.Identity) {
		check(encrypted) { "secure storage unavailable; refusing to persist the federation key in cleartext" }
		prefs.edit().putString(KEY_IDENTITY, wireJson.encodeToString(Crypto.Identity.serializer(), identity)).apply()
	}

	fun loadIdentity(): Crypto.Identity? =
		prefs.getString(KEY_IDENTITY, null)?.let { json ->
			runCatching { wireJson.decodeFromString(Crypto.Identity.serializer(), json) }.getOrNull()
		}

	/** The Domain owner root keypair. This device is the trust anchor: the owner
	 * signing key is the sole signer of admissions and revocations, so it is the one
	 * key worth a passphrase-encrypted offline backup. Stored separately from the
	 * console member identity, and only under the Keystore-backed store. */
	fun saveOwnerIdentity(identity: Crypto.Identity) {
		check(encrypted) { "secure storage unavailable; refusing to persist the owner root key in cleartext" }
		prefs.edit()
			.putString(KEY_OWNER_IDENTITY, wireJson.encodeToString(Crypto.Identity.serializer(), identity))
			.apply()
	}

	fun loadOwnerIdentity(): Crypto.Identity? =
		prefs.getString(KEY_OWNER_IDENTITY, null)?.let { json ->
			runCatching { wireJson.decodeFromString(Crypto.Identity.serializer(), json) }.getOrNull()
		}

	/** The mirrored Domain snapshot (the keyring) the Console resolves peers against.
	 * Public material only (admissions + revocations + the owner pubkey), so the
	 * plaintext fallback is acceptable. `version` is evie's keyring hash, persisted
	 * alongside so a poll can skip an unchanged pull. */
	fun saveDomain(json: String, version: String) {
		prefs.edit().putString(KEY_DOMAIN, json).putString(KEY_DOMAIN_VERSION, version).apply()
	}

	fun loadDomain(): String? = prefs.getString(KEY_DOMAIN, null)

	fun loadDomainVersion(): String = prefs.getString(KEY_DOMAIN_VERSION, "") ?: ""

	/** Whether evie has ROOTED the Domain at this device (set only on a successful
	 * enroll_redeem). Distinct from holding a keypair: a minted-but-not-redeemed
	 * identity must not present as an enrolled owner. */
	var federationRooted: Boolean
		get() = prefs.getBoolean(KEY_ROOTED, false)
		set(value) {
			prefs.edit().putBoolean(KEY_ROOTED, value).apply()
		}

	/** Whether this Console's own admission has been submitted to evie. Gates the
	 * one-time submit so connect does not re-issue a fresh-nonce admission each cycle. */
	var consoleAdmitted: Boolean
		get() = prefs.getBoolean(KEY_CONSOLE_ADMITTED, false)
		set(value) {
			prefs.edit().putBoolean(KEY_CONSOLE_ADMITTED, value).apply()
		}

	/** A Switch's signing + box public keys, resolved from the owner-verified keyring at
	 * seal time (the phone-anchored model does not persist per-Switch keys). */
	data class SwitchKeys(val signPub: String, val boxPub: String)

	private companion object {
		const val KEY_BLOB = "provisioning"
		const val KEY_BIO = "biometric_lock"
		const val KEY_THREADS = "threads"
		const val KEY_LABELS = "labels"
		const val KEY_SWITCH_ID = "switch_id"
		const val KEY_IDENTITY = "federation_identity"
		const val KEY_OWNER_IDENTITY = "federation_owner_identity"
		const val KEY_DOMAIN = "federation_domain"
		const val KEY_DOMAIN_VERSION = "federation_domain_version"
		const val KEY_ROOTED = "federation_rooted"
		const val KEY_CONSOLE_ADMITTED = "federation_console_admitted"
		const val KEY_STTS_PROVIDER = "stts_provider"
		const val KEY_STTS_VOICE = "stts_voice"
		const val KEY_STTS_VOICE_PREFIX = "stts_voice."
		const val KEY_AUTO_TTS = "auto_tts"
		const val KEY_AUTO_PLAY_SUMMARY = "auto_play_summary"
		const val KEY_SYNC_EPOCH = "sync_epoch"
		const val KEY_SYNC_ACKED = "sync_acked"
		const val KEY_SYNC_DROPPED = "sync_dropped"
	}
}
