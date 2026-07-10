package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.SyncCursor

/**
 * The outcome of reading a persisted federation identity. Decode-to-null would conflate a MISSING
 * key (minting a fresh one is correct) with a CORRUPT key (present bytes that did not decode);
 * minting on a corrupt key silently re-roots the device and orphans the real key, leaving every
 * admission it signed unverifiable. So mint only on [Absent], fail closed on [Corrupt].
 */
sealed interface IdentityLoad {
	data class Loaded(val identity: Crypto.Identity) : IdentityLoad

	/** Bytes are present but did not decode. Never overwrite; surface the error. */
	data object Corrupt : IdentityLoad

	data object Absent : IdentityLoad

	companion object {
		/** Classify a stored identity blob: null is [Absent], decodable bytes are [Loaded], present
		 * bytes that fail to decode are [Corrupt]. Pure (no prefs) so a JVM unit test can pin the
		 * absent-vs-corrupt distinction the fail-closed mint gate rests on. */
		fun classify(raw: String?): IdentityLoad {
			if (raw == null) return Absent
			return runCatching { wireJson.decodeFromString(Crypto.Identity.serializer(), raw) }
				.fold({ Loaded(it) }, { Corrupt })
		}
	}
}

/**
 * Encrypted-at-rest storage for the provisioning blob (which holds the SA + app
 * tokens), the biometric-lock flag, and the serialized chat transcript. Falls back
 * to plain prefs only if the device keystore is unavailable.
 */
class AppStateStore(context: Context) {
	// True when the Keystore-backed store initialized. Federation private keys are persisted ONLY
	// when encrypted, keeping the Domain root signing key off disk in cleartext (fail closed).
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

	/** Reset provisioning + identity + transcript for a re-provision, keeping the settings-owned
	 * voice creds + taste and the biometric-lock preference so re-provisioning never wipes voice
	 * or disables the app lock. Wipes exactly PROVISIONING_KEYS; everything else survives by
	 * omission. `clear()` is the full factory wipe. */
	fun clearProvisioning() {
		prefs.edit().apply { PROVISIONING_KEYS.forEach { remove(it) } }.apply()
	}

	var biometricLock: Boolean
		get() = prefs.getBoolean(KEY_BIO, false)
		set(value) {
			prefs.edit().putBoolean(KEY_BIO, value).apply()
		}

	/** TTS voice settings live in prefs, not the blob, so a re-provision does not reset this user
	 * taste. The provider is stored by descriptor id; voice is per-provider. */
	var sttsProvider: String
		get() = prefs.getString(KEY_STTS_PROVIDER, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_STTS_PROVIDER, value).apply()
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

	/** Which tier of a new message is spoken aloud on arrival, hands-free: "off", "title",
	 * "summary", or "full". Independent of autoTts; a tier not pre-synthesized is synthesized on
	 * demand at play time. */
	var autoPlay: String
		get() = prefs.getString(KEY_AUTO_PLAY, "off") ?: "off"
		set(value) {
			prefs.edit().putString(KEY_AUTO_PLAY, value).apply()
		}

	/** TTS playback volume as a percentage, 0-200 (100 = unchanged, above 100 needs a gain stage
	 * on top of MediaPlayer's own 0-100 range). */
	var sttsVolume: Int
		get() = prefs.getInt(KEY_STTS_VOLUME, 100).coerceIn(0, 200)
		set(value) {
			prefs.edit().putInt(KEY_STTS_VOLUME, value.coerceIn(0, 200)).apply()
		}

	/** How often the terminal view re-captures the pane, in ms. A device setting (not the
	 * blob), default 2s; clamped to the server's floor (the gateway re-uses a capture within
	 * ~300ms regardless, so a smaller value only adds round-trips). */
	var terminalRefreshMs: Long
		get() = prefs.getLong(KEY_TERMINAL_REFRESH_MS, 2000L).coerceAtLeast(TERMINAL_REFRESH_FLOOR_MS)
		set(value) {
			prefs.edit().putLong(KEY_TERMINAL_REFRESH_MS, value.coerceAtLeast(TERMINAL_REFRESH_FLOOR_MS)).apply()
		}

	/** The STTS service URL + API key, in app settings (not the provisioning blob) so a re-provision
	 * never wipes voice. Stored via plain putString, which still gets EncryptedSharedPreferences at
	 * rest; no fail-closed gate (that is reserved for the signing keys). The URL defaults to the
	 * VRCSTT endpoint so a fresh install only needs the key pasted. */
	var sttsUrl: String
		get() = prefs.getString(KEY_STTS_URL, null) ?: DEFAULT_STTS_URL
		set(value) {
			prefs.edit().putString(KEY_STTS_URL, value).apply()
		}

	var sttsKey: String
		get() = prefs.getString(KEY_STTS_KEY, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_STTS_KEY, value).apply()
		}

	/** One-shot grammar-version wipe. The network-addressing migration changed the store-key grammar
	 * (`gateway/name` -> `domain.gateway.spawn.session`), so old-grammar persisted thread/label/draft
	 * keys and the mailbox sync cursor are cleared on upgrade rather than migrated (clean break). Runs
	 * only when the stored version differs from [CURRENT_SCHEMA_VERSION]; idempotent thereafter. Must
	 * be called BEFORE the first thread/label load-parse so a stale-grammar key never reaches a parser.
	 * Returns true on the one-shot transition that ran the wipe (false when already current) so the
	 * caller purges the matching filesDir caches (stranded attachment bytes + TTS audio) on the same
	 * latch. */
	fun migrateSchemaIfNeeded(): Boolean {
		if (prefs.getInt(KEY_SCHEMA_VERSION, 0) == CURRENT_SCHEMA_VERSION) return false
		prefs.edit().apply {
			SCHEMA_WIPE_KEYS.forEach { remove(it) }
			putInt(KEY_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION)
		}.apply()
		return true
	}

	fun saveThreads(json: String) = prefs.edit().putString(KEY_THREADS, json).apply()

	fun loadThreads(): String? = prefs.getString(KEY_THREADS, null)

	fun saveLabels(json: String) = prefs.edit().putString(KEY_LABELS, json).apply()

	fun loadLabels(): String? = prefs.getString(KEY_LABELS, null)

	/** How many consecutive fresh-teams observations each locally-labeled team has been missing
	 * entirely from. Persisted alongside labels (unlike pollFailStreak, which deliberately resets on
	 * a fresh start): it accumulates evidence against an already-durable label across restarts, and a
	 * device that goes a long stretch unforegrounded is also the one most likely to have its process
	 * killed between observations. */
	fun saveAbsenceStreaks(json: String) = prefs.edit().putString(KEY_ABSENCE_STREAKS, json).apply()

	fun loadAbsenceStreaks(): String? = prefs.getString(KEY_ABSENCE_STREAKS, null)

	fun saveDrafts(json: String) = prefs.edit().putString(KEY_DRAFTS, json).apply()

	fun loadDrafts(): String? = prefs.getString(KEY_DRAFTS, null)

	/** The connected Gateway's id, learned from the register result. Anchors the
	 * composite (gatewayId, name) key; empty until a federation-aware Gateway reports it. */
	fun saveGatewayId(id: String) = prefs.edit().putString(KEY_GATEWAY_ID, id).apply()

	fun loadGatewayId(): String = prefs.getString(KEY_GATEWAY_ID, "") ?: ""

	/** The console-owned mailbox consumption cursor, durable across restarts. Resuming from its OWN
	 * cursor instead of a server-dictated one means backlog piled up while the app was closed is
	 * never acked away on the next poll. Null until the first commit. */
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

	/** This Console's member identity (signing + box keypairs), admitted as kind:console so a
	 * Gateway trusts its sealed ops. Persisted ONLY under the Keystore-backed store: if encryption
	 * is unavailable this throws rather than write the private key in cleartext. */
	fun saveIdentity(identity: Crypto.Identity) {
		check(encrypted) { "secure storage unavailable; refusing to persist the federation key in cleartext" }
		prefs.edit().putString(KEY_IDENTITY, wireJson.encodeToString(Crypto.Identity.serializer(), identity)).apply()
	}

	fun loadIdentity(): IdentityLoad = readIdentity(KEY_IDENTITY)

	/** The Domain owner root keypair. This device is the trust anchor: the owner signing key is the
	 * sole signer of admissions and revocations. Stored separately from the console member identity,
	 * and only under the Keystore-backed store. */
	fun saveOwnerIdentity(identity: Crypto.Identity) {
		check(encrypted) { "secure storage unavailable; refusing to persist the owner root key in cleartext" }
		prefs.edit()
			.putString(KEY_OWNER_IDENTITY, wireJson.encodeToString(Crypto.Identity.serializer(), identity))
			.apply()
	}

	fun loadOwnerIdentity(): IdentityLoad = readIdentity(KEY_OWNER_IDENTITY)

	/** Read a persisted identity into the [IdentityLoad] tri-state, keeping the corrupt case
	 * distinct so the caller never mints over an unreadable key. */
	private fun readIdentity(key: String): IdentityLoad = IdentityLoad.classify(prefs.getString(key, null))

	/** The mirrored Domain snapshot (keyring) the Console resolves peers against. Public material
	 * only (admissions + revocations + owner pubkey), so the plaintext fallback is acceptable.
	 * `version` is evie's keyring hash, stored alongside so a poll can skip an unchanged pull. */
	fun saveDomain(json: String, version: String) {
		prefs.edit().putString(KEY_DOMAIN, json).putString(KEY_DOMAIN_VERSION, version).apply()
	}

	fun loadDomain(): String? = prefs.getString(KEY_DOMAIN, null)

	fun loadDomainVersion(): String = prefs.getString(KEY_DOMAIN_VERSION, "") ?: ""

	/** Whether this Console's own admission has been submitted to evie. Gates the
	 * one-time submit so connect does not re-issue a fresh-nonce admission each cycle. */
	var consoleAdmitted: Boolean
		get() = prefs.getBoolean(KEY_CONSOLE_ADMITTED, false)
		set(value) {
			prefs.edit().putBoolean(KEY_CONSOLE_ADMITTED, value).apply()
		}

	/** Whether this device has already first-rooted the pending Domain from its invite blob. Gates
	 * the one-time first_root: the op is idempotent at evie, but the latch avoids a needless
	 * round-trip and lets connect tell "still pending" from "rooted, proceed". Cleared by a
	 * re-import so a fresh invite re-roots. */
	var firstRooted: Boolean
		get() = prefs.getBoolean(KEY_FIRST_ROOTED, false)
		set(value) {
			prefs.edit().putBoolean(KEY_FIRST_ROOTED, value).apply()
		}

	/** Whether this device has completed the in-person enroll compare for its invite. Gates the
	 * enrollee's "Verify with the admin" prompt so it stops offering once the trust edge is
	 * recorded. Cleared by a re-import (a fresh invite is a fresh ceremony). */
	var enrollCeremonyDone: Boolean
		get() = prefs.getBoolean(KEY_ENROLL_CEREMONY_DONE, false)
		set(value) {
			prefs.edit().putBoolean(KEY_ENROLL_CEREMONY_DONE, value).apply()
		}

	/** This owner's display name, cached locally so the profile shows it without a round-trip. The
	 * authoritative copy lives on the Domain at evie; this is refreshed from discovery and updated
	 * on a local rename. */
	var displayName: String
		get() = prefs.getString(KEY_PROFILE_NAME, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_PROFILE_NAME, value).apply()
		}

	/** The guest tenants this owner has staged (the "Networks you host" list), a JSON array of
	 * {domainId, displayName, nonce}. Persisted locally so the list and each row's invite QR survive
	 * restarts: evie holds the canonical pending/rooted state, but only the host remembers the label
	 * and current invite nonce needed to re-render the QR. */
	fun saveHostedTenants(json: String) = prefs.edit().putString(KEY_HOSTED_TENANTS, json).apply()

	fun loadHostedTenants(): String? = prefs.getString(KEY_HOSTED_TENANTS, null)

	/** The OWNER signing keys this owner trusts (the friend graph, keyed by ownerSignPub), as a JSON
	 * array of base64 owner keys. Written on every completed trust ceremony (enroll or link) and on
	 * untrust. This friend edge is recorded even for a gateway-less person, distinct from the
	 * gateway-side relay-affinity edges that carry actual cross-Domain traffic. */
	fun saveTrustedOwners(json: String) = prefs.edit().putString(KEY_TRUSTED_OWNERS, json).apply()

	fun loadTrustedOwners(): String? = prefs.getString(KEY_TRUSTED_OWNERS, null)

	/** Per-plugin opt-in flag, keyed by the plugin's composite id (see `plugins/`). Settings-owned
	 * taste like the voice creds: survives a re-provision by omission from PROVISIONING_KEYS, and
	 * is not address-keyed so it never joins SCHEMA_WIPE_KEYS. Default off - a baked-in plugin is
	 * INSTALLED and the user opts in. */
	fun pluginEnabled(id: String): Boolean = prefs.getBoolean(KEY_PLUGIN_ENABLED_PREFIX + id, false)

	fun setPluginEnabled(id: String, on: Boolean) {
		prefs.edit().putBoolean(KEY_PLUGIN_ENABLED_PREFIX + id, on).apply()
	}

	/** A Gateway's signing + box public keys, resolved from the owner-verified keyring at
	 * seal time (the phone-anchored model does not persist per-Gateway keys). */
	data class GatewayKeys(val signPub: String, val boxPub: String)

	internal companion object {
		const val KEY_BLOB = "provisioning"
		const val KEY_BIO = "biometric_lock"
		const val KEY_THREADS = "threads"
		const val KEY_LABELS = "labels"
		const val KEY_ABSENCE_STREAKS = "team_absence_streak"
		const val KEY_DRAFTS = "drafts"
		const val KEY_GATEWAY_ID = "gateway_id"
		const val KEY_IDENTITY = "federation_identity"
		const val KEY_OWNER_IDENTITY = "federation_owner_identity"
		const val KEY_DOMAIN = "federation_domain"
		const val KEY_DOMAIN_VERSION = "federation_domain_version"
		const val KEY_CONSOLE_ADMITTED = "federation_console_admitted"
		const val KEY_FIRST_ROOTED = "federation_first_rooted"
		const val KEY_ENROLL_CEREMONY_DONE = "federation_enroll_ceremony_done"
		const val KEY_PROFILE_NAME = "federation_profile_name"
		const val KEY_HOSTED_TENANTS = "federation_hosted_tenants"
		const val KEY_TRUSTED_OWNERS = "federation_trusted_owners"
		const val KEY_STTS_URL = "stts_url"
		const val KEY_STTS_KEY = "stts_key"
		const val DEFAULT_STTS_URL = "https://vrcsttapi.azurewebsites.net"
		const val KEY_STTS_PROVIDER = "stts_provider"
		const val KEY_STTS_VOICE_PREFIX = "stts_voice."
		const val KEY_PLUGIN_ENABLED_PREFIX = "plugin_enabled."
		const val KEY_AUTO_TTS = "auto_tts"
		const val KEY_AUTO_PLAY = "auto_play_tier"
		const val KEY_STTS_VOLUME = "stts_volume"
		const val KEY_TERMINAL_REFRESH_MS = "terminal_refresh_ms"
		const val TERMINAL_REFRESH_FLOOR_MS = 300L
		const val KEY_SYNC_EPOCH = "sync_epoch"
		const val KEY_SYNC_ACKED = "sync_acked"
		const val KEY_SYNC_DROPPED = "sync_dropped"

		/** Persisted grammar-schema version. The unified address grammar wiped grammar-bearing prefs at
		 * v2; v3 re-runs the one-shot wipe so the caller also purges the filesDir caches (attachment
		 * bytes + TTS audio) that v2 left stranded. A stored value below this triggers the wipe in
		 * [migrateSchemaIfNeeded]. */
		const val KEY_SCHEMA_VERSION = "schema_version"
		const val CURRENT_SCHEMA_VERSION = 3

		/** The keys a re-provision wipes. Everything else is preserved by omission (voice creds +
		 * taste, the biometric lock), so any new provisioning/identity/transcript key MUST be added
		 * here or it silently survives a Clear (a privacy/correctness regression). The partition is
		 * pinned by a unit test. */
		/** The grammar-bearing keys the one-shot schema wipe clears (thread/label/draft/absence-streak
		 * store keys plus the mailbox sync cursor). Any NEW address-keyed pref MUST be added here or it
		 * survives the grammar migration carrying a stale-grammar key. The set is pinned by a unit test. */
		val SCHEMA_WIPE_KEYS = listOf(
			KEY_THREADS, KEY_LABELS, KEY_DRAFTS, KEY_ABSENCE_STREAKS, KEY_SYNC_EPOCH, KEY_SYNC_ACKED, KEY_SYNC_DROPPED,
		)

		val PROVISIONING_KEYS = listOf(
			KEY_BLOB, KEY_IDENTITY, KEY_OWNER_IDENTITY, KEY_DOMAIN, KEY_DOMAIN_VERSION,
			KEY_CONSOLE_ADMITTED, KEY_FIRST_ROOTED, KEY_ENROLL_CEREMONY_DONE, KEY_PROFILE_NAME, KEY_HOSTED_TENANTS,
			KEY_TRUSTED_OWNERS,
			KEY_THREADS, KEY_LABELS, KEY_DRAFTS, KEY_GATEWAY_ID, KEY_SYNC_EPOCH, KEY_SYNC_ACKED,
			KEY_SYNC_DROPPED,
		)
	}
}
