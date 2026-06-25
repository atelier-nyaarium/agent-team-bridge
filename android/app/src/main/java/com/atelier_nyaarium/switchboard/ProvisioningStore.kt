package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.SyncCursor

/**
 * The outcome of reading a persisted federation identity. Decode-to-null conflated a MISSING
 * key (mint a fresh one is correct) with a CORRUPT key (present bytes that did not decode);
 * minting on the latter silently re-roots the device and orphans the real key, so every
 * admission/revocation it signed becomes unverifiable. The tri-state forces the caller to mint
 * only on [Absent] and fail closed on [Corrupt].
 */
sealed interface IdentityLoad {
	data class Loaded(val identity: Crypto.Identity) : IdentityLoad

	/** Bytes are present but did not decode. Never overwrite; surface the error. */
	data object Corrupt : IdentityLoad

	data object Absent : IdentityLoad

	companion object {
		/** Classify a stored identity blob into the tri-state: null bytes are [Absent], present
		 * bytes that decode are [Loaded], present bytes that do not decode are [Corrupt]. Pure (no
		 * prefs), so the absent-vs-corrupt distinction the fail-closed mint gate rests on is pinned
		 * by a plain JVM unit test. */
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

	/** Reset provisioning + identity + transcript for a re-provision, but KEEP the
	 * settings-owned voice creds + taste (sttsUrl/sttsKey, provider/voice, auto-*) AND the
	 * biometric-lock preference (a device setting), so re-provisioning never wipes voice or
	 * silently disables the app lock. Wipes exactly PROVISIONING_KEYS; everything else is
	 * preserved by omission. `clear()` stays the full factory wipe. */
	fun clearProvisioning() {
		prefs.edit().apply { PROVISIONING_KEYS.forEach { remove(it) } }.apply()
	}

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

	/** Which tier of a new message is spoken aloud the moment it arrives, hands-free.
	 * One of "off", "title", "summary", "full". Independent of autoTts (pre-generate):
	 * a tier not pre-synthesized is synthesized on demand at play time. */
	var autoPlay: String
		get() = prefs.getString(KEY_AUTO_PLAY, "off") ?: "off"
		set(value) {
			prefs.edit().putString(KEY_AUTO_PLAY, value).apply()
		}

	/** How often the terminal view re-captures the pane, in ms. A device setting (not the
	 * blob), default 2s; clamped to the server's floor (the gateway re-uses a capture within
	 * ~300ms regardless, so a smaller value only adds round-trips). */
	var terminalRefreshMs: Long
		get() = prefs.getLong(KEY_TERMINAL_REFRESH_MS, 2000L).coerceAtLeast(TERMINAL_REFRESH_FLOOR_MS)
		set(value) {
			prefs.edit().putLong(KEY_TERMINAL_REFRESH_MS, value.coerceAtLeast(TERMINAL_REFRESH_FLOOR_MS)).apply()
		}

	/** The STTS service URL + API key. These live in app settings (NOT the
	 * provisioning blob) so a re-provision never wipes voice. Stored via plain
	 * putString, which already gets EncryptedSharedPreferences at rest - no
	 * fail-closed gate (that is reserved for the signing keys). The URL defaults to
	 * the VRCSTT endpoint so a fresh install only needs the key pasted. */
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

	fun saveThreads(json: String) = prefs.edit().putString(KEY_THREADS, json).apply()

	fun loadThreads(): String? = prefs.getString(KEY_THREADS, null)

	fun saveLabels(json: String) = prefs.edit().putString(KEY_LABELS, json).apply()

	fun loadLabels(): String? = prefs.getString(KEY_LABELS, null)

	fun saveDrafts(json: String) = prefs.edit().putString(KEY_DRAFTS, json).apply()

	fun loadDrafts(): String? = prefs.getString(KEY_DRAFTS, null)

	/** The connected Gateway's id, learned from the register result. Anchors the
	 * composite (gatewayId, name) key; empty until a federation-aware Gateway reports it. */
	fun saveGatewayId(id: String) = prefs.edit().putString(KEY_GATEWAY_ID, id).apply()

	fun loadGatewayId(): String = prefs.getString(KEY_GATEWAY_ID, "") ?: ""

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
	 * kind:console so a Gateway trusts its sealed ops. Persisted ONLY under the
	 * Keystore-backed store: if encryption is unavailable this throws rather than write
	 * the private key in cleartext (the caller surfaces the error and retries when the
	 * keystore is healthy). */
	fun saveIdentity(identity: Crypto.Identity) {
		check(encrypted) { "secure storage unavailable; refusing to persist the federation key in cleartext" }
		prefs.edit().putString(KEY_IDENTITY, wireJson.encodeToString(Crypto.Identity.serializer(), identity)).apply()
	}

	fun loadIdentity(): IdentityLoad = readIdentity(KEY_IDENTITY)

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

	fun loadOwnerIdentity(): IdentityLoad = readIdentity(KEY_OWNER_IDENTITY)

	/** Read a persisted identity into the [IdentityLoad] tri-state: absent when no bytes are
	 * stored, corrupt when the bytes are present but do not decode, loaded otherwise. The
	 * corrupt case is kept distinct so the caller never mints over an unreadable key. */
	private fun readIdentity(key: String): IdentityLoad = IdentityLoad.classify(prefs.getString(key, null))

	/** The mirrored Domain snapshot (the keyring) the Console resolves peers against.
	 * Public material only (admissions + revocations + the owner pubkey), so the
	 * plaintext fallback is acceptable. `version` is evie's keyring hash, persisted
	 * alongside so a poll can skip an unchanged pull. */
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

	/** Whether this device has already first-rooted the pending Domain from its invite blob.
	 * Gates the one-time first_root so connect does not re-POST it every cycle once the Domain
	 * is rooted (the op is idempotent at evie, but the latch avoids a needless round-trip and
	 * lets the connect path distinguish "still pending" from "rooted, proceed"). Cleared by a
	 * re-import so a fresh invite re-roots. */
	var firstRooted: Boolean
		get() = prefs.getBoolean(KEY_FIRST_ROOTED, false)
		set(value) {
			prefs.edit().putBoolean(KEY_FIRST_ROOTED, value).apply()
		}

	/** Whether this device has completed the FLOW-1 in-person enroll compare for its invite. Gates
	 * the enrollee's "Verify with the admin" prompt so it stops offering once the trust edge is
	 * recorded. Cleared by a re-import (a fresh invite is a fresh ceremony). */
	var enrollCeremonyDone: Boolean
		get() = prefs.getBoolean(KEY_ENROLL_CEREMONY_DONE, false)
		set(value) {
			prefs.edit().putBoolean(KEY_ENROLL_CEREMONY_DONE, value).apply()
		}

	/** This owner's own display name, cached locally so the profile
	 * shows it without a round-trip. The authoritative copy lives on the Domain at evie; this is
	 * refreshed from discovery (the local session's displayName) and updated on a local rename. */
	var displayName: String
		get() = prefs.getString(KEY_PROFILE_NAME, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_PROFILE_NAME, value).apply()
		}

	/** The guest tenants this owner has staged (the "Networks you host" list), as a JSON array of
	 * {domainId, displayName, nonce}. Persisted locally so the list + each row's invite QR survive
	 * restarts (evie holds the canonical pending/rooted state, but only the host remembers the label
	 * + the current invite nonce for re-rendering the QR). */
	fun saveHostedTenants(json: String) = prefs.edit().putString(KEY_HOSTED_TENANTS, json).apply()

	fun loadHostedTenants(): String? = prefs.getString(KEY_HOSTED_TENANTS, null)

	/** The set of OWNER signing keys this owner trusts (the friend graph, keyed by ownerSignPub - the
	 * owner-keyed trust the Users surface reads). Written on every completed trust ceremony (enroll or
	 * link) and on untrust; persisted as a JSON array of base64 owner keys. This is the friend edge
	 * (recorded even for a gateway-less person, per the design), distinct from the gateway-side
	 * relay-affinity edges that enable actual cross-Domain traffic. */
	fun saveTrustedOwners(json: String) = prefs.edit().putString(KEY_TRUSTED_OWNERS, json).apply()

	fun loadTrustedOwners(): String? = prefs.getString(KEY_TRUSTED_OWNERS, null)

	/** A Gateway's signing + box public keys, resolved from the owner-verified keyring at
	 * seal time (the phone-anchored model does not persist per-Gateway keys). */
	data class GatewayKeys(val signPub: String, val boxPub: String)

	internal companion object {
		const val KEY_BLOB = "provisioning"
		const val KEY_BIO = "biometric_lock"
		const val KEY_THREADS = "threads"
		const val KEY_LABELS = "labels"
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
		const val KEY_AUTO_TTS = "auto_tts"
		const val KEY_AUTO_PLAY = "auto_play_tier"
		const val KEY_TERMINAL_REFRESH_MS = "terminal_refresh_ms"
		const val TERMINAL_REFRESH_FLOOR_MS = 300L
		const val KEY_SYNC_EPOCH = "sync_epoch"
		const val KEY_SYNC_ACKED = "sync_acked"
		const val KEY_SYNC_DROPPED = "sync_dropped"

		/** The keys a re-provision (Clear & re-provision) wipes. EVERYTHING ELSE is preserved
		 * by omission - voice creds + taste, the biometric lock - so any
		 * NEW provisioning/identity/transcript key MUST be added here or it silently survives a
		 * Clear (a privacy/correctness regression). The partition is pinned by a unit test. */
		val PROVISIONING_KEYS = listOf(
			KEY_BLOB, KEY_IDENTITY, KEY_OWNER_IDENTITY, KEY_DOMAIN, KEY_DOMAIN_VERSION,
			KEY_CONSOLE_ADMITTED, KEY_FIRST_ROOTED, KEY_ENROLL_CEREMONY_DONE, KEY_PROFILE_NAME, KEY_HOSTED_TENANTS,
			KEY_TRUSTED_OWNERS,
			KEY_THREADS, KEY_LABELS, KEY_DRAFTS, KEY_GATEWAY_ID, KEY_SYNC_EPOCH, KEY_SYNC_ACKED,
			KEY_SYNC_DROPPED,
		)
	}
}
