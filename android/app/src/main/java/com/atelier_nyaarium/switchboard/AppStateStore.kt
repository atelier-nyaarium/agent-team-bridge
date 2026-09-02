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

	/** Where this app's durable state lives on disk. The prefs live here already; anything else
	 * that has to survive a restart (the blob store's bytes) roots off the same directory. */
	fun save(blob: String) = prefs.edit().putString(KEY_BLOB, blob).apply()

	fun load(): String? = prefs.getString(KEY_BLOB, null)

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

	/** What this device LEARNED about how to reach its Router (from the Router itself), kept apart from
	 * the blob it was handed: the blob is imported, this is discovered, and a re-provision wipes both. */
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

	/** The sound that marks the start of an automatic run, as a content Uri. Empty means the bundled
	 * asset. A user-chosen system sound can be any format Android happens to ship, which is why the
	 * player takes a resolved file rather than assuming the bundled asset's own encoding. */
	var chimeUri: String
		get() = prefs.getString(KEY_CHIME_URI, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_CHIME_URI, value).apply()
		}

	/** The folder the user last chose to save attachments into, as a SAF tree Uri. Empty until they
	 * pick one, which is why the first save cannot use SAF at all: no grant exists yet. The grant
	 * behind it can die between runs, so a reader must re-validate rather than trust this. */
	var saveTreeUri: String
		get() = prefs.getString(KEY_SAVE_TREE_URI, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_SAVE_TREE_URI, value).apply()
		}

	/** TTS playback volume as a percentage, 0-200 (100 = unchanged, above 100 needs a gain stage
	 * on top of MediaPlayer's own 0-100 range). */
	var sttsVolume: Int
		get() = prefs.getInt(KEY_STTS_VOLUME, 100).coerceIn(0, 200)
		set(value) {
			prefs.edit().putInt(KEY_STTS_VOLUME, value.coerceIn(0, 200)).apply()
		}

	/** Resting height of a thread's board strip, in dp. Coerced on READ as well as write, so a height
	 * set on a larger screen shrinks to fit this one instead of burying the transcript. */
	var boardStripHeight: Int
		get() = prefs.getInt(KEY_BOARD_STRIP_HEIGHT, BOARD_STRIP_DEFAULT_DP).coerceIn(BOARD_STRIP_MIN_DP, BOARD_STRIP_MAX_DP)
		set(value) {
			prefs.edit().putInt(KEY_BOARD_STRIP_HEIGHT, value.coerceIn(BOARD_STRIP_MIN_DP, BOARD_STRIP_MAX_DP)).apply()
		}

	/** The run-start chime's own volume, same 0-200 scale. Separate from [sttsVolume] because the two
	 * are balanced against different things: speech against whatever else is playing, and the chime
	 * against the speech that follows it. A bundled tone at the level that suits a voice is usually
	 * louder than anyone wants a repeated notification to be. */
	var sttsChimeVolume: Int
		get() = prefs.getInt(KEY_STTS_CHIME_VOLUME, 100).coerceIn(0, 200)
		set(value) {
			prefs.edit().putInt(KEY_STTS_CHIME_VOLUME, value.coerceIn(0, 200)).apply()
		}

	/** How often the terminal view re-captures the pane, in ms. A device setting (not the
	 * blob), default 2s; clamped to the server's floor (the gateway re-uses a capture within
	 * ~300ms regardless, so a smaller value only adds round-trips). */
	var terminalRefreshMs: Long
		get() = prefs.getLong(KEY_TERMINAL_REFRESH_MS, 2000L).coerceAtLeast(TERMINAL_REFRESH_FLOOR_MS)
		set(value) {
			prefs.edit().putLong(KEY_TERMINAL_REFRESH_MS, value.coerceAtLeast(TERMINAL_REFRESH_FLOOR_MS)).apply()
		}

	/** The idle pushback ladder's silence clock: when the current tier's silence window started
	 * (backgrounded or last comms, whichever is later). Null (not 0L) when absent, same as
	 * [loadSyncCursor] - an unset key must read as "nothing persisted yet" so the manager's
	 * hydrate clamp can default it to now(), not to the epoch. Device runtime state (not the
	 * blob), so it stays out of both SCHEMA_WIPE_KEYS and PROVISIONING_KEYS by omission. */
	override fun saveIdleSilenceStart(v: Long) = prefs.edit().putLong(KEY_IDLE_SILENCE_START, v).apply()

	override fun loadIdleSilenceStart(): Long? {
		if (!prefs.contains(KEY_IDLE_SILENCE_START)) return null
		return prefs.getLong(KEY_IDLE_SILENCE_START, 0L)
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

	/** One-shot grammar wipe, for a store whose KEY GRAMMAR this build cannot parse.
	 *
	 * Gated on [GRAMMAR_VERSION], not on equality with the current version: a wipe destroys the
	 * owner's whole transcript, so it must fire only when the keys are genuinely unreadable, never
	 * merely because a later version added a field. A store at or above the grammar floor is carried
	 * forward and stamped current, which is safe because every field added since is optional on the
	 * DEVICE's own hand-written row codec even where the wire requires it.
	 *
	 * Must be called BEFORE the first thread/label load-parse so a stale-grammar key never reaches a
	 * parser. Returns true only on a real wipe, so the caller purges the matching filesDir caches
	 * (stranded attachment bytes + TTS audio) on the same latch.
	 */
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

	/** Per-team read anchor (the mailbox journal coordinate a device has read up to), keyed by
	 * canonical address. Never bundled into `threads` itself: it survives independently of any
	 * single message row (a forgotten/reloaded row can still resolve against it by coordinate). */
	override fun saveReadAnchors(json: String) = prefs.edit().putString(KEY_READ_ANCHORS, json).apply()

	override fun loadReadAnchors(): String? = prefs.getString(KEY_READ_ANCHORS, null)

	/** Write threads and read anchors in ONE SharedPreferences batch. Required whenever a single
	 * state transition changes both (forget's cross-thread anchor sweep): two separate apply()
	 * calls could be torn by a process kill between them, resurrecting a stale anchor against the
	 * already-updated thread list (or vice versa). An anchor-only or threads-only change is safe
	 * with the plain single-key setters above. */
	override fun saveThreadsAndReadAnchors(threadsJson: String, anchorsJson: String) {
		prefs.edit().putString(KEY_THREADS, threadsJson).putString(KEY_READ_ANCHORS, anchorsJson).apply()
	}

	override fun saveLabels(json: String) = prefs.edit().putString(KEY_LABELS, json).apply()

	override fun loadLabels(): String? = prefs.getString(KEY_LABELS, null)

	/** How many consecutive fresh-teams observations each locally-labeled team has been missing
	 * entirely from. Persisted alongside labels (unlike pollFailStreak, which deliberately resets on
	 * a fresh start): it accumulates evidence against an already-durable label across restarts, and a
	 * device that goes a long stretch unforegrounded is also the one most likely to have its process
	 * killed between observations. */
	override fun saveAbsenceStreaks(json: String) = prefs.edit().putString(KEY_ABSENCE_STREAKS, json).apply()

	override fun loadAbsenceStreaks(): String? = prefs.getString(KEY_ABSENCE_STREAKS, null)

	override fun saveDrafts(json: String) = prefs.edit().putString(KEY_DRAFTS, json).apply()

	override fun loadDrafts(): String? = prefs.getString(KEY_DRAFTS, null)

	/** At most one pending scheduled send per team, same disposable storage class as drafts, with no
	 * special re-provisioning survival. */
	override fun saveScheduledSends(json: String) = prefs.edit().putString(KEY_SCHEDULED_SENDS, json).apply()

	override fun loadScheduledSends(): String? = prefs.getString(KEY_SCHEDULED_SENDS, null)

	/** Same disposable storage class as the two above. */
	override fun saveGoals(json: String) = prefs.edit().putString(KEY_GOALS, json).apply()

	override fun loadGoals(): String? = prefs.getString(KEY_GOALS, null)

	/** The whole task-board blob: per-Gateway cache + sync metadata, the pending-action queue, and
	 * the one board draft - ONE key, so an optimistic edit and its queue append land in one apply. */
	override fun saveTaskBoard(json: String) = prefs.edit().putString(KEY_TASK_BOARD, json).apply()

	override fun loadTaskBoard(): String? = prefs.getString(KEY_TASK_BOARD, null)

	/** The connected Gateway's id, learned from the register result. Anchors the
	 * composite (gatewayId, name) key; empty until a federation-aware Gateway reports it. */
	fun saveGatewayId(id: String) = prefs.edit().putString(KEY_GATEWAY_ID, id).apply()

	override fun loadGatewayId(): String = prefs.getString(KEY_GATEWAY_ID, "") ?: ""

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

	/** Read a persisted identity into the [IdentityLoad] tri-state, keeping the corrupt case
	 * distinct so the caller never mints over an unreadable key. */
	private fun readIdentity(key: String): IdentityLoad = IdentityLoad.classify(prefs.getString(key, null))

	/** The mirrored Domain snapshot (keyring) the Console resolves peers against. Public material
	 * only (admissions + revocations + owner pubkey), so the plaintext fallback is acceptable.
	 * `version` is the Router's keyring hash, stored alongside so a poll can skip an unchanged pull. */
	fun saveDomain(json: String, version: String) {
		prefs.edit().putString(KEY_DOMAIN, json).putString(KEY_DOMAIN_VERSION, version).apply()
	}

	fun loadDomain(): String? = prefs.getString(KEY_DOMAIN, null)

	fun loadDomainVersion(): String = prefs.getString(KEY_DOMAIN_VERSION, "") ?: ""

	/** Whether this Console's own admission has been submitted to the Router. Gates the
	 * one-time submit so connect does not re-issue a fresh-nonce admission each cycle. */
	var consoleAdmitted: Boolean
		get() = prefs.getBoolean(KEY_CONSOLE_ADMITTED, false)
		set(value) {
			prefs.edit().putBoolean(KEY_CONSOLE_ADMITTED, value).apply()
		}

	/** Whether this device has already first-rooted the pending Domain from its invite blob. Gates
	 * the one-time first_root: the op is idempotent at the Router, but the latch avoids a needless
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
	 * authoritative copy lives on the Domain at the Router; this is refreshed from discovery and updated
	 * on a local rename. */
	var displayName: String
		get() = prefs.getString(KEY_PROFILE_NAME, "") ?: ""
		set(value) {
			prefs.edit().putString(KEY_PROFILE_NAME, value).apply()
		}

	/** The project last spawned on, per Gateway, so the create dialog can offer it again.
	 *
	 * Per GATEWAY rather than one global value: a project name means nothing on another machine, and
	 * `windows` exists on exactly one of them. A remembered name is only ever a SUGGESTION - the
	 * dialog re-checks it against that Gateway's current list and falls back to no selection, so a
	 * renamed, removed or since-undetected project cannot preselect something unspawnable.
	 *
	 * Provisioning-scoped: it names gateways and projects belonging to one Domain, so it goes with
	 * that Domain rather than lingering as suggestions that can never match again.
	 */
	var lastProjectByGateway: Map<String, String>
		get() {
			// Tolerant by design: this is a convenience, so a corrupt or absent value means "no
			// suggestion" rather than anything a caller has to handle.
			val raw = prefs.getString(KEY_LAST_PROJECT, null) ?: return emptyMap()
			return runCatching {
				val o = JSONObject(raw)
				o.keys().asSequence().mapNotNull { k -> o.optString(k).takeIf { it.isNotEmpty() }?.let { k to it } }.toMap()
			}.getOrDefault(emptyMap())
		}
		set(value) {
			prefs.edit().putString(KEY_LAST_PROJECT, JSONObject(value as Map<*, *>).toString()).apply()
		}

	/** The guest tenants this owner has staged (the "Networks you host" list), a JSON array of
	 * {domainId, displayName, nonce}. Persisted locally so the list and each row's invite QR survive
	 * restarts: the Router holds the canonical pending/rooted state, but only the host remembers the label
	 * and current invite nonce needed to re-render the QR. */
	/** Gateways admitted whose bundle was never confirmed delivered, keyed by gateway id. Durable
	 * because the interruption this exists for is the app being killed: a record held in memory would
	 * die with exactly the event it is meant to survive. */
	fun savePendingEnrolls(json: String) = prefs.edit().putString(KEY_PENDING_ENROLLS, json).apply()

	fun loadPendingEnrolls(): String? = prefs.getString(KEY_PENDING_ENROLLS, null)

	fun saveHostedTenants(json: String) = prefs.edit().putString(KEY_HOSTED_TENANTS, json).apply()

	fun loadHostedTenants(): String? = prefs.getString(KEY_HOSTED_TENANTS, null)

	/** The OWNER signing keys this owner trusts (the friend graph, keyed by ownerSignPub), as a JSON
	 * array of base64 owner keys. Written on every completed trust ceremony (enroll or link) and on
	 * untrust. This friend edge is recorded even for a gateway-less person, distinct from the
	 * gateway-side relay-affinity edges that carry actual cross-Domain traffic. */
	fun saveTrustedOwners(json: String) = prefs.edit().putString(KEY_TRUSTED_OWNERS, json).apply()

	fun loadTrustedOwners(): String? = prefs.getString(KEY_TRUSTED_OWNERS, null)

	/**
	 * Per-plugin flag, keyed by the plugin's composite id (see `plugins/`). Settings-owned taste like
	 * the voice creds: survives a re-provision by omission from PROVISIONING_KEYS, and is not
	 * address-keyed so it never joins SCHEMA_WIPE_KEYS.
	 *
	 * A baked-in plugin is INSTALLED, so it is on until the user says otherwise. The toggle exists to
	 * switch a feature OFF, not to opt into one. Reading the flag through `getBoolean`'s default is
	 * what keeps an explicit choice authoritative: once toggled, the stored value exists and wins, so
	 * a plugin switched off stays off.
	 */
	fun pluginEnabled(id: String): Boolean = prefs.getBoolean(KEY_PLUGIN_ENABLED_PREFIX + id, true)

	fun setPluginEnabled(id: String, on: Boolean) {
		prefs.edit().putBoolean(KEY_PLUGIN_ENABLED_PREFIX + id, on).apply()
	}

	/** A Gateway's signing + box public keys, resolved from the owner-verified keyring at
	 * seal time (the phone-anchored model does not persist per-Gateway keys). */
	data class GatewayKeys(val signPub: String, val boxPub: String)

	internal companion object {
		const val KEY_BLOB = "provisioning"
		const val KEY_ROUTER_REACH = "router_reach"
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
		// Deliberately absent from SCHEMA_WIPE_KEYS: it holds no address grammar, and clearing it
		// would make the user re-pick their folder for an unrelated schema change.
		const val KEY_SAVE_TREE_URI = "save_tree_uri"
		const val KEY_STTS_VOLUME = "stts_volume"
		const val KEY_STTS_CHIME_VOLUME = "stts_chime_volume"
		const val KEY_BOARD_STRIP_HEIGHT = "board_strip_height"
		// Floor is about two rows, so the header never sits alone. Ceiling keeps the transcript usable
		// on a small screen; the strip scrolls rather than growing past it.
		const val BOARD_STRIP_MIN_DP = 72
		const val BOARD_STRIP_MAX_DP = 420
		const val BOARD_STRIP_DEFAULT_DP = 260
		const val KEY_TERMINAL_REFRESH_MS = "terminal_refresh_ms"
		const val TERMINAL_REFRESH_FLOOR_MS = 300L
		const val KEY_IDLE_SILENCE_START = "idle_silence_start"
		const val KEY_SYNC_EPOCH = "sync_epoch"
		const val KEY_SYNC_ACKED = "sync_acked"
		const val KEY_SYNC_DROPPED = "sync_dropped"

		/** Persisted grammar-schema version. The unified address grammar wiped grammar-bearing prefs at
		 * v2; v3 re-runs the one-shot wipe so the caller also purges the filesDir caches (attachment
		 * bytes + TTS audio) that v2 left stranded. A stored value below this triggers the wipe in
		 * [migrateSchemaIfNeeded]. */
		const val KEY_SCHEMA_VERSION = "schema_version"
		const val CURRENT_SCHEMA_VERSION = 4

		/** The version that last changed the persisted KEY GRAMMAR. Only a store below this is
		 * unreadable and therefore wiped; bump it solely when keys stop parsing, never for an added
		 * field, or a routine bump silently deletes the owner's history. */
		const val GRAMMAR_VERSION = 3

		/** The grammar-bearing keys the one-shot schema wipe clears (thread/label/draft/absence-streak
		 * store keys plus the mailbox sync cursor). Any NEW address-keyed pref MUST be added here or it
		 * survives the grammar migration carrying a stale-grammar key. The set is pinned by a unit test. */
		val SCHEMA_WIPE_KEYS = listOf(
			KEY_THREADS, KEY_READ_ANCHORS, KEY_LABELS, KEY_DRAFTS, KEY_SCHEDULED_SENDS, KEY_GOALS, KEY_ABSENCE_STREAKS,
			KEY_SYNC_EPOCH, KEY_SYNC_ACKED, KEY_SYNC_DROPPED, KEY_TASK_BOARD,
		)

		/** The keys a re-provision wipes. Everything else is preserved by omission (voice creds +
		 * taste, the biometric lock), so any new provisioning/identity/transcript key MUST be added
		 * here or it silently survives a Clear (a privacy/correctness regression). The partition is
		 * pinned by a unit test. */
		val PROVISIONING_KEYS = listOf(
			KEY_BLOB, KEY_ROUTER_REACH, KEY_IDENTITY, KEY_OWNER_IDENTITY, KEY_CONTENT_KEYS, KEY_CONTENT_KEYS_CORRUPT,
			KEY_DOMAIN, KEY_DOMAIN_VERSION,
			KEY_CONSOLE_ADMITTED, KEY_FIRST_ROOTED, KEY_ENROLL_CEREMONY_DONE, KEY_PROFILE_NAME, KEY_HOSTED_TENANTS,
			KEY_PENDING_ENROLLS,
			KEY_TRUSTED_OWNERS,
			KEY_THREADS, KEY_READ_ANCHORS, KEY_LABELS, KEY_DRAFTS, KEY_SCHEDULED_SENDS, KEY_GOALS, KEY_GATEWAY_ID,
			KEY_SYNC_EPOCH, KEY_SYNC_ACKED, KEY_SYNC_DROPPED, KEY_ABSENCE_STREAKS, KEY_TASK_BOARD,
			KEY_LAST_PROJECT,
		)
	}
}
