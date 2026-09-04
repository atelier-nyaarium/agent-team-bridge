package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.SyncCursor
import java.io.File
import java.util.Base64
import kotlinx.serialization.json.JsonObject
import org.json.JSONObject

/** Distinguishes absent from corrupt identities. */
sealed interface IdentityLoad {
	data class Loaded(val identity: Crypto.Identity) : IdentityLoad

	/** Never overwrite. */
	data object Corrupt : IdentityLoad

	data object Absent : IdentityLoad

	companion object {
		/** Classifies absent, loaded, and corrupt blobs. */
		fun classify(raw: String?): IdentityLoad {
			if (raw == null) return Absent
			return runCatching { wireJson.decodeFromString(Crypto.Identity.serializer(), raw) }
				.fold({ Loaded(it) }, { Corrupt })
		}
	}
}

/** Encrypted storage with a keystore fallback. */
sealed interface ContentKeysLoad {
	data object Absent : ContentKeysLoad
	data class Loaded(val keys: Map<Int, ByteArray>) : ContentKeysLoad
	data class Corrupt(val raw: String) : ContentKeysLoad
}

private fun securePreferences(context: Context): Pair<SharedPreferences, Boolean> = runCatching {
		val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
		EncryptedSharedPreferences.create(
			context,
			"switchboard-secure",
			key,
			EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
			EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
		) to true
	}.getOrElse { context.getSharedPreferences("switchboard", Context.MODE_PRIVATE) to false }

class AppStateStore internal constructor(
	val filesDir: File,
	private val prefs: SharedPreferences,
	val encrypted: Boolean,
) :
	IdleSilenceStore, ChatPersistenceStore, com.atelier_nyaarium.switchboard.board.BoardStore {
	private constructor(context: Context, secure: Pair<SharedPreferences, Boolean>) : this(
		context.filesDir,
		secure.first,
		secure.second,
	)

	constructor(context: Context) : this(context.applicationContext, securePreferences(context.applicationContext))

	/** Durable state directory. */
	fun save(blob: String) = prefs.edit().putString(KEY_BLOB, blob).apply()

	fun load(): String? = prefs.getString(KEY_BLOB, null)

	/** A new blob, with nothing remembered from the old one. */
	fun replaceProvisioning(blob: String): Boolean = prefs.edit().apply {
		putString(KEY_BLOB, blob)
		putString(KEY_GATEWAY_ID, "")
		putString(KEY_DOMAIN_ID, "")
		putBoolean(KEY_CONSOLE_ADMITTED, false)
		putBoolean(KEY_FIRST_ROOTED, false)
		putBoolean(KEY_ENROLL_CEREMONY_DONE, false)
	}.commit()

	fun installApprovedDevice(
		blob: String,
		domainJson: String?,
		domainVersion: String?,
		gatewayId: String?,
		contentKeys: Map<Int, ByteArray>,
	): Boolean {
		check(encrypted) { "secure storage unavailable; refusing to persist content keys in cleartext" }
		return prefs.edit().apply {
			putString(KEY_BLOB, blob)
			putBoolean(KEY_CONSOLE_ADMITTED, true)
			putBoolean(KEY_FIRST_ROOTED, true)
			putBoolean(KEY_ENROLL_CEREMONY_DONE, true)
			if (domainJson != null) {
				putString(KEY_DOMAIN, domainJson)
				if (domainVersion != null) putString(KEY_DOMAIN_VERSION, domainVersion)
			}
			if (gatewayId != null) putString(KEY_GATEWAY_ID, gatewayId)
			putString(KEY_CONTENT_KEYS, encodeContentKeys(contentKeys))
		}.commit()
	}

	/** Router reach discovered locally. */
	fun saveRouterReach(json: String) = prefs.edit().putString(KEY_ROUTER_REACH, json).apply()

	fun loadRouterReach(): String? = prefs.getString(KEY_ROUTER_REACH, null)

	internal fun saveRouterState(kind: String, slot: RouterStateSlot) {
		check(prefs.edit().putString(KEY_ROUTER_STATE_PREFIX + kind, wireJson.encodeToString(JsonObject.serializer(), slot.encode())).commit()) {
			"router state commit failed"
		}
	}

	internal fun loadRouterState(kind: String, legacy: String? = null): RouterStateSlot? {
		val stored = prefs.getString(KEY_ROUTER_STATE_PREFIX + kind, null)
		if (stored != null) return wireJson.decodeFromString<JsonObject>(stored).decodeRouterStateSlot()
		if (legacy == null) return null
		val slot = RouterStateSlot(0L, 0L, wireJson.parseToJsonElement(legacy))
		saveRouterState(kind, slot)
		return slot
	}

	fun clear() = prefs.edit().clear().apply()

	/** Wipes provisioning-owned keys only. */
	fun clearProvisioning() {
		prefs.edit().apply { PROVISIONING_KEYS.forEach { remove(it) } }.apply()
	}

	var biometricLock: Boolean
		get() = prefs.getBoolean(KEY_BIO, false)
		set(value) {
			prefs.edit().putBoolean(KEY_BIO, value).apply()
		}

	/** Provider descriptor id. */
	var sttsProvider: String
		get() = prefs.getString(KEY_STTS_PROVIDER, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_STTS_PROVIDER, value).apply()
		}

	fun sttsVoiceFor(providerId: String): String = prefs.getString(KEY_STTS_VOICE_PREFIX + providerId, "") ?: ""

	fun setSttsVoiceFor(providerId: String, voice: String) {
		prefs.edit().putString(KEY_STTS_VOICE_PREFIX + providerId, voice).apply()
	}

	/** Pre-synthesizes followed-thread notifications. */
	var autoTts: Boolean
		get() = prefs.getBoolean(KEY_AUTO_TTS, false)
		set(value) {
			prefs.edit().putBoolean(KEY_AUTO_TTS, value).apply()
		}

	/** Arrival speech tier. */
	var autoPlay: String
		get() = prefs.getString(KEY_AUTO_PLAY, "off") ?: "off"
		set(value) {
			prefs.edit().putString(KEY_AUTO_PLAY, value).apply()
		}

	/** Automatic-run chime URI. */
	var chimeUri: String
		get() = prefs.getString(KEY_CHIME_URI, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_CHIME_URI, value).apply()
		}

	/** SAF tree URI, revalidated before use. */
	var saveTreeUri: String
		get() = prefs.getString(KEY_SAVE_TREE_URI, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_SAVE_TREE_URI, value).apply()
		}

	/** TTS volume, 0-200. */
	var sttsVolume: Int
		get() = prefs.getInt(KEY_STTS_VOLUME, 100).coerceIn(0, 200)
		set(value) {
			prefs.edit().putInt(KEY_STTS_VOLUME, value.coerceIn(0, 200)).apply()
		}

	/** Board strip height in dp. */
	var boardStripHeight: Int
		get() = prefs.getInt(KEY_BOARD_STRIP_HEIGHT, BOARD_STRIP_DEFAULT_DP).coerceIn(BOARD_STRIP_MIN_DP, BOARD_STRIP_MAX_DP)
		set(value) {
			prefs.edit().putInt(KEY_BOARD_STRIP_HEIGHT, value.coerceIn(BOARD_STRIP_MIN_DP, BOARD_STRIP_MAX_DP)).apply()
		}

	/** Chime volume, 0-200. */
	var sttsChimeVolume: Int
		get() = prefs.getInt(KEY_STTS_CHIME_VOLUME, 100).coerceIn(0, 200)
		set(value) {
			prefs.edit().putInt(KEY_STTS_CHIME_VOLUME, value.coerceIn(0, 200)).apply()
		}

	/** Terminal refresh interval, clamped to the server floor. */
	var terminalRefreshMs: Long
		get() = prefs.getLong(KEY_TERMINAL_REFRESH_MS, 2000L).coerceAtLeast(TERMINAL_REFRESH_FLOOR_MS)
		set(value) {
			prefs.edit().putLong(KEY_TERMINAL_REFRESH_MS, value.coerceAtLeast(TERMINAL_REFRESH_FLOOR_MS)).apply()
		}

	/** Null means no persisted silence start. */
	override fun saveIdleSilenceStart(v: Long) = prefs.edit().putLong(KEY_IDLE_SILENCE_START, v).apply()

	override fun loadIdleSilenceStart(): Long? {
		if (!prefs.contains(KEY_IDLE_SILENCE_START)) return null
		return prefs.getLong(KEY_IDLE_SILENCE_START, 0L)
	}

	/** STTS settings remain outside provisioning. */
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

	/** Wipes only grammar versions below the floor, before parsing. */
	fun migrateSchemaIfNeeded(): Boolean {
		val stored = prefs.getInt(KEY_SCHEMA_VERSION, 0)
		if (stored == CURRENT_SCHEMA_VERSION) return false
		val wipe = stored < GRAMMAR_VERSION
		prefs.edit().apply {
			if (wipe) SCHEMA_WIPE_KEYS.forEach { remove(it) }
			putInt(KEY_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION)
		}.apply()
		return wipe
	}

	override fun saveThreads(json: String) = prefs.edit().putString(KEY_THREADS, json).apply()

	override fun loadThreads(): String? = prefs.getString(KEY_THREADS, null)

	/** Per-team mailbox coordinate. */
	override fun saveReadAnchors(json: String) = prefs.edit().putString(KEY_READ_ANCHORS, json).apply()

	override fun loadReadAnchors(): String? = prefs.getString(KEY_READ_ANCHORS, null)

	/** Atomically writes threads and anchors. */
	override fun saveThreadsAndReadAnchors(threadsJson: String, anchorsJson: String) {
		prefs.edit().putString(KEY_THREADS, threadsJson).putString(KEY_READ_ANCHORS, anchorsJson).apply()
	}

	override fun saveLabels(json: String) = prefs.edit().putString(KEY_LABELS, json).apply()

	override fun loadLabels(): String? = prefs.getString(KEY_LABELS, null)

	/** Persisted team absence streaks. */
	override fun saveAbsenceStreaks(json: String) = prefs.edit().putString(KEY_ABSENCE_STREAKS, json).apply()

	override fun loadAbsenceStreaks(): String? = prefs.getString(KEY_ABSENCE_STREAKS, null)

	override fun saveDrafts(json: String) = prefs.edit().putString(KEY_DRAFTS, json).apply()

	override fun loadDrafts(): String? = prefs.getString(KEY_DRAFTS, null)

	/** Pending scheduled sends. */
	override fun saveScheduledSends(json: String) = prefs.edit().putString(KEY_SCHEDULED_SENDS, json).apply()

	override fun loadScheduledSends(): String? = prefs.getString(KEY_SCHEDULED_SENDS, null)

	/** Pending durable operations. */
	override fun saveGoals(json: String) = prefs.edit().putString(KEY_GOALS, json).apply()

	override fun loadGoals(): String? = prefs.getString(KEY_GOALS, null)

	/** Board state and pending actions share one key. */
	override fun saveTaskBoard(json: String) = check(prefs.edit().putString(KEY_TASK_BOARD, json).commit())

	override fun loadTaskBoard(): String? = prefs.getString(KEY_TASK_BOARD, null)

	/** Connected Gateway id. */
	fun saveGatewayId(id: String) = prefs.edit().putString(KEY_GATEWAY_ID, id).apply()

	override fun loadGatewayId(): String = prefs.getString(KEY_GATEWAY_ID, "") ?: ""

	/** Console conversation id. */
	fun saveConversationId(id: String) = prefs.edit().putString(KEY_CONVERSATION_ID, id).apply()

	fun loadConversationId(): String? = prefs.getString(KEY_CONVERSATION_ID, null)

	/** Domain id the Router reported for this console. */
	fun saveDomainId(id: String) = prefs.edit().putString(KEY_DOMAIN_ID, id).apply()

	fun loadDomainId(): String = prefs.getString(KEY_DOMAIN_ID, "") ?: ""

	/** Console-owned mailbox cursor. */
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

	/** Console identity, keystore-backed only. */
	fun saveIdentity(identity: Crypto.Identity) {
		check(encrypted) { "secure storage unavailable; refusing to persist the federation key in cleartext" }
		prefs.edit().putString(KEY_IDENTITY, wireJson.encodeToString(Crypto.Identity.serializer(), identity)).apply()
	}

	fun loadIdentity(): IdentityLoad = readIdentity(KEY_IDENTITY)

	/** Domain owner root, keystore-backed only. */
	fun saveOwnerIdentity(identity: Crypto.Identity) {
		check(encrypted) { "secure storage unavailable; refusing to persist the owner root key in cleartext" }
		prefs.edit()
			.putString(KEY_OWNER_IDENTITY, wireJson.encodeToString(Crypto.Identity.serializer(), identity))
			.apply()
	}

	fun loadOwnerIdentity(): IdentityLoad = readIdentity(KEY_OWNER_IDENTITY)

	fun saveContentKeys(keys: Map<Int, ByteArray>): Boolean {
		check(encrypted) { "secure storage unavailable; refusing to persist content keys in cleartext" }
		return prefs.edit().putString(KEY_CONTENT_KEYS, encodeContentKeys(keys)).commit()
	}

	fun loadContentKeys(): ContentKeysLoad {
		val raw = prefs.getString(KEY_CONTENT_KEYS, null) ?: return ContentKeysLoad.Absent
		return runCatching {
			val json = JSONObject(raw)
			val keys = buildMap {
				json.keys().forEach { name ->
					val epoch = name.toIntOrNull()?.takeIf { it >= 1 } ?: error("invalid epoch")
					val key = Base64.getDecoder().decode(json.getString(name))
					check(key.size == 32) { "invalid key" }
					put(epoch, key)
				}
			}
			ContentKeysLoad.Loaded(keys)
		}.getOrElse { ContentKeysLoad.Corrupt(raw) }
	}

	internal fun saveContentKeysCorrupt(raw: String) {
		prefs.edit().putString(KEY_CONTENT_KEYS_CORRUPT, raw).apply()
	}

	internal fun saveContentKeysCorrupt(keys: Map<Int, ByteArray>) {
		saveContentKeysCorrupt(encodeContentKeys(keys))
	}

	private fun encodeContentKeys(keys: Map<Int, ByteArray>): String {
		val json = JSONObject()
		keys.toSortedMap().forEach { (epoch, key) -> json.put(epoch.toString(), Base64.getEncoder().encodeToString(key)) }
		return json.toString()
	}

	/** Preserves corrupt identity state. */
	private fun readIdentity(key: String): IdentityLoad = IdentityLoad.classify(prefs.getString(key, null))

	/** Mirrored public Domain keyring. */
	fun saveDomain(json: String, version: String) {
		prefs.edit().putString(KEY_DOMAIN, json).putString(KEY_DOMAIN_VERSION, version).apply()
	}

	fun loadDomain(): String? = prefs.getString(KEY_DOMAIN, null)

	fun loadDomainVersion(): String = prefs.getString(KEY_DOMAIN_VERSION, "") ?: ""

	/** Whether this Console is admitted. */
	var consoleAdmitted: Boolean
		get() = prefs.getBoolean(KEY_CONSOLE_ADMITTED, false)
		set(value) {
			prefs.edit().putBoolean(KEY_CONSOLE_ADMITTED, value).apply()
		}

	/** Whether the pending Domain was rooted. */
	var firstRooted: Boolean
		get() = prefs.getBoolean(KEY_FIRST_ROOTED, false)
		set(value) {
			prefs.edit().putBoolean(KEY_FIRST_ROOTED, value).apply()
		}

	/** Whether invite verification completed. */
	var enrollCeremonyDone: Boolean
		get() = prefs.getBoolean(KEY_ENROLL_CEREMONY_DONE, false)
		set(value) {
			prefs.edit().putBoolean(KEY_ENROLL_CEREMONY_DONE, value).apply()
		}

	/** Cached owner display name. */
	var displayName: String
		get() = prefs.getString(KEY_PROFILE_NAME, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_PROFILE_NAME, value).apply()
		}

	/** Per-Gateway project suggestions. */
	var lastProjectByGateway: Map<String, String>
		get() {
			// Corrupt values mean no suggestion.
			val raw = prefs.getString(KEY_LAST_PROJECT, null) ?: return emptyMap()
			return runCatching {
				val o = JSONObject(raw)
				o.keys().asSequence().mapNotNull { k -> o.optString(k).takeIf { it.isNotEmpty() }?.let { k to it } }.toMap()
			}.getOrDefault(emptyMap())
		}
		set(value) {
			prefs.edit().putString(KEY_LAST_PROJECT, JSONObject(value as Map<*, *>).toString()).apply()
		}

	/** Locally staged guest tenants. */
	/** Undelivered Gateway bundles. */
	fun savePendingEnrolls(json: String) = prefs.edit().putString(KEY_PENDING_ENROLLS, json).apply()

	fun loadPendingEnrolls(): String? = prefs.getString(KEY_PENDING_ENROLLS, null)

	fun saveHostedTenants(json: String) = prefs.edit().putString(KEY_HOSTED_TENANTS, json).apply()

	fun loadHostedTenants(): String? = prefs.getString(KEY_HOSTED_TENANTS, null)

	/** Trusted owner signing keys. */
	fun saveTrustedOwners(json: String) = prefs.edit().putString(KEY_TRUSTED_OWNERS, json).apply()

	fun loadTrustedOwners(): String? = prefs.getString(KEY_TRUSTED_OWNERS, null)

	/** Per-plugin setting. */
	fun pluginEnabled(id: String): Boolean = prefs.getBoolean(KEY_PLUGIN_ENABLED_PREFIX + id, true)

	fun setPluginEnabled(id: String, on: Boolean) {
		prefs.edit().putBoolean(KEY_PLUGIN_ENABLED_PREFIX + id, on).apply()
	}

	/** Owner-verified Gateway public keys. */
	data class GatewayKeys(val signPub: String, val boxPub: String)

	internal companion object {
		const val KEY_BLOB = "provisioning"
		const val KEY_ROUTER_REACH = "router_reach"
		const val KEY_DOMAIN_ID = "domain_id"
		const val KEY_ROUTER_STATE_PREFIX = "router_state."
		const val KEY_BIO = "biometric_lock"
		const val KEY_THREADS = "threads"
		const val KEY_READ_ANCHORS = "read_anchors"
		const val KEY_LABELS = "labels"
		const val KEY_ABSENCE_STREAKS = "team_absence_streak"
		const val KEY_DRAFTS = "drafts"
		const val KEY_SCHEDULED_SENDS = "scheduled_sends"
		const val KEY_GOALS = "goals"
		const val KEY_GATEWAY_ID = "gateway_id"
		const val KEY_CONVERSATION_ID = "conversation_id"
		const val KEY_IDENTITY = "federation_identity"
		const val KEY_OWNER_IDENTITY = "federation_owner_identity"
		const val KEY_CONTENT_KEYS = "federation_content_keys"
		const val KEY_CONTENT_KEYS_CORRUPT = "federation_content_keys_corrupt"
		const val KEY_DOMAIN = "federation_domain"
		const val KEY_DOMAIN_VERSION = "federation_domain_version"
		const val KEY_CONSOLE_ADMITTED = "federation_console_admitted"
		const val KEY_FIRST_ROOTED = "federation_first_rooted"
		const val KEY_ENROLL_CEREMONY_DONE = "federation_enroll_ceremony_done"
		const val KEY_PROFILE_NAME = "federation_profile_name"
		const val KEY_LAST_PROJECT = "create_last_project_by_gateway"
		const val KEY_HOSTED_TENANTS = "federation_hosted_tenants"
		const val KEY_PENDING_ENROLLS = "federation_pending_enrolls"
		const val KEY_TRUSTED_OWNERS = "federation_trusted_owners"
		const val KEY_STTS_URL = "stts_url"
		const val KEY_STTS_KEY = "stts_key"
		const val DEFAULT_STTS_URL = "https://vrcsttapi.azurewebsites.net"
		const val KEY_STTS_PROVIDER = "stts_provider"
		const val KEY_STTS_VOICE_PREFIX = "stts_voice."
		const val KEY_PLUGIN_ENABLED_PREFIX = "plugin_enabled."
		const val KEY_TASK_BOARD = "task_board"
		const val KEY_AUTO_TTS = "auto_tts"
		const val KEY_AUTO_PLAY = "auto_play_tier"
		const val KEY_CHIME_URI = "stts_chime_uri"
		// Preserved across grammar wipes.
		const val KEY_SAVE_TREE_URI = "save_tree_uri"
		const val KEY_STTS_VOLUME = "stts_volume"
		const val KEY_STTS_CHIME_VOLUME = "stts_chime_volume"
		const val KEY_BOARD_STRIP_HEIGHT = "board_strip_height"
		// Keeps the transcript usable.
		const val BOARD_STRIP_MIN_DP = 72
		const val BOARD_STRIP_MAX_DP = 420
		const val BOARD_STRIP_DEFAULT_DP = 260
		const val KEY_TERMINAL_REFRESH_MS = "terminal_refresh_ms"
		const val TERMINAL_REFRESH_FLOOR_MS = 300L
		const val KEY_IDLE_SILENCE_START = "idle_silence_start"
		const val KEY_SYNC_EPOCH = "sync_epoch"
		const val KEY_SYNC_ACKED = "sync_acked"
		const val KEY_SYNC_DROPPED = "sync_dropped"

		/** Persisted grammar-schema version. */
		const val KEY_SCHEMA_VERSION = "schema_version"
		const val CURRENT_SCHEMA_VERSION = 4

		/** Minimum readable grammar version. */
		const val GRAMMAR_VERSION = 3

		/** Keep every grammar key here. */
		val SCHEMA_WIPE_KEYS = listOf(
			KEY_THREADS, KEY_READ_ANCHORS, KEY_LABELS, KEY_DRAFTS, KEY_SCHEDULED_SENDS, KEY_GOALS, KEY_ABSENCE_STREAKS,
			KEY_SYNC_EPOCH, KEY_SYNC_ACKED, KEY_SYNC_DROPPED, KEY_TASK_BOARD,
		)

		/** Keep every provisioning key here. */
		val PROVISIONING_KEYS = listOf(
			KEY_BLOB, KEY_ROUTER_REACH, KEY_IDENTITY, KEY_OWNER_IDENTITY, KEY_CONTENT_KEYS, KEY_CONTENT_KEYS_CORRUPT,
			KEY_DOMAIN, KEY_DOMAIN_VERSION,
			KEY_CONSOLE_ADMITTED, KEY_FIRST_ROOTED, KEY_ENROLL_CEREMONY_DONE, KEY_PROFILE_NAME, KEY_HOSTED_TENANTS,
			KEY_PENDING_ENROLLS,
			KEY_TRUSTED_OWNERS,
			KEY_THREADS, KEY_READ_ANCHORS, KEY_LABELS, KEY_DRAFTS, KEY_SCHEDULED_SENDS, KEY_GOALS, KEY_GATEWAY_ID,
			KEY_CONVERSATION_ID,
			KEY_SYNC_EPOCH, KEY_SYNC_ACKED, KEY_SYNC_DROPPED, KEY_ABSENCE_STREAKS, KEY_TASK_BOARD,
			KEY_LAST_PROJECT,
		)
	}
}
