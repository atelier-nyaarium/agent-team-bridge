package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.NoticeId
import com.atelier_nyaarium.switchboard.proto.SessionId
import com.atelier_nyaarium.switchboard.proto.SyncEntry
import com.atelier_nyaarium.switchboard.proto.SyncPollResult
import com.atelier_nyaarium.switchboard.proto.TeamAddress
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

/** A rendered attachment on a message. `src` is what the WebView loads (a data URI
 * or an appassets-proxied local path); a null `src` renders as a download chip.
 * Real attachment plumbing decodes these to disk in a later phase. */
data class MessageFile(val name: String, val mime: String, val src: String? = null)

/** `id` is a per-thread, local-only row key for the WebView DOM (lets the renderer
 * replace a row in place). It is NOT the mailbox seq; mailbox dedupe is owned by SyncCursor.
 * Stamped on append; reassigned from list order on load so old transcripts still work. */
data class Message(
	val fromMe: Boolean,
	val text: String,
	val at: Long,
	val id: Long = 0,
	val files: List<MessageFile> = emptyList(),
	/** Reply/send state: wire "running"/"error", local "pending" (echo in flight)
	 * and "waking" (the cold-wake placeholder), or null for a settled message. */
	val status: String? = null,
	/** The relay opId this send was first delivered under. A retry reuses it so
	 * the arbiter's idempotency cache replays a lost reply instead of double-
	 * delivering to the agent (the console protocol contract). */
	val opId: String? = null,
	/** Notification-bar line for broadcast notices. Notification-only: the thread
	 * renders the body as usual and never shows this. */
	val title: String? = null,
	/** The Short tier of a notice, persisted for an upcoming feature; no UI
	 * reads it yet. */
	val summary: String? = null,
	/** Mailbox coordinates of the entry that produced this row. Used to dedupe an
	 * at-least-once re-drain so the same (epoch, seq) renders exactly once. 0 for
	 * local/optimistic rows and legacy persisted rows from before this field. */
	val epoch: Long = 0,
	val seq: Long = 0,
)

data class ChatState(
	val provisioned: Boolean = false,
	val teams: List<Team> = emptyList(),
	val threads: Map<String, List<Message>> = emptyMap(),
	val unread: Map<String, Int> = emptyMap(),
	val openTabs: List<String> = emptyList(),
	val status: String = "",
	val error: String? = null,
	val gap: Boolean = false,
	val biometricLock: Boolean = false,
	val deviceName: String = "",
	val labels: Map<String, String> = emptyMap(),
	val connected: Boolean = false,
	val pollFailStreak: Int = 0,
	/** Connected Switch id, learned from the register result. Empty before the first
	 * federation-aware connect; bare names resolve to the local Switch in that case. */
	val localSwitchId: String = "",
	/** Non-zero (epoch ms) while a post-enrollment allowlist sync is in progress: the device
	 * is admitted but the home Switch has not re-synced yet, so sealed ops transiently reject.
	 * Drives the calm SYNCING header; cleared the moment an op succeeds or the grace lapses. */
	val enrollingSince: Long = 0L,
) {
	/** Sessions shows live teams plus any team we already have a thread with
	 * (agent-initiated). A thread-only peer is gone from the bridge and cannot be
	 * woken, so it is synthesized as an ended loose session with no mode.
	 * Both sides are compared by their canonical key so a bare vs qualified form
	 * of the same team never produces a phantom "ended" entry. */
	fun sessions(localSwitchId: String): List<Team> {
		val known = teams.associateBy { TeamAddress.parse(it.name, localSwitchId).canonical }
		val extra = threads.keys
			.filter { TeamAddress.parse(it, localSwitchId).canonical !in known }
			.map { Team(it, "ended", "", 0) }
		return teams + extra
	}

	/** Busy heuristic for the status board: we are awaiting a reply (the thread
	 * ends on our pending or cleanly-sent message) or the tail is a waking/running
	 * placeholder. An error-marked tail (failed send) is not "working". */
	fun working(team: String): Boolean {
		val last = threads[team]?.lastOrNull() ?: return false
		return (last.fromMe && (last.status == null || last.status == "pending")) ||
			last.status == "running" || last.status == "waking"
	}

	/** Bridge link health for the dashboard header: green once registered and polling
	 * cleanly, blue while finishing enrollment (allowlist syncing), amber while a poll-failure
	 * streak is building, red when offline. */
	enum class Health { ONLINE, SYNCING, DEGRADED, OFFLINE }

	val health: Health
		get() = when {
			connected && pollFailStreak == 0 -> Health.ONLINE
			enrollingSince != 0L && !connected -> Health.SYNCING
			pollFailStreak >= 2 -> Health.OFFLINE
			connected -> Health.DEGRADED
			else -> Health.OFFLINE
		}

	/** Last local activity time for a thread, for the session card subtitle. */
	fun lastActivity(team: String): Long? = threads[team]?.maxByOrNull { it.at }?.at

	/** One-line preview from the thread tail. */
	// Prefer a notice's one-phrase title over its long report body, same as the
	// notification line: this preview is a glance surface, not the thread.
	fun snippet(team: String): String? = threads[team]?.lastOrNull()?.let { it.title ?: it.text }
		?.replace(Regex("\\s+"), " ")?.trim()?.takeIf { it.isNotEmpty() }

	/** The user's friendly name for a team, falling back to its short local name
	 * (the tail after the switch qualifier; the whole key when bare). The qualified
	 * `switch/local` key is never shown raw. */
	fun label(team: String, localSwitchId: String = ""): String =
		labels[team] ?: TeamAddress.parse(team, localSwitchId).name
}

/** A just-enrolled device's first ops can transiently reject while the home Switch
 * re-syncs the new admission from evie (it only re-syncs on its next re-register). We
 * show a calm "Finishing up enrollment..." and retry, escalating to a real error only if
 * the sync never lands within this grace window. */
private const val ENROLL_GRACE_MS = 90_000L

/** Three-way classification of a connect/poll/relay failure. */
internal enum class ConnKind {
	/** Needs human action (re-provision, bad creds, app update); surface immediately. */
	TERMINAL,

	/** A network or server blip; retry quietly (one hiccup never alarms). */
	TRANSIENT,

	/** The device IS admitted, but this Switch has not re-synced its allowlist yet, so a
	 * sealed op rejects with "...is not admitted to the Domain". Self-heals on the next
	 * re-register; show "Finishing up enrollment..." and escalate only past the grace window. */
	ENROLLING,
}

/**
 * Map a connect/poll failure to a SPECIFIC, actionable cause + its kind, instead of a
 * blanket "Connection issue". ConsoleClient preserves the real cause in the exception
 * message ("This device is not enrolled...", "HTTP 404: ...", a TLS exception), so this is
 * a pure mapping - no new probing.
 */
internal fun classifyConnError(e: Throwable): Pair<String, ConnKind> {
	val m = e.message ?: ""
	return when {
		// The server sealer rejecting an admitted device whose admission this Switch has not
		// synced yet (console OR cross-Switch federation). NOT terminal - it converges. Kept
		// first, and distinct from the local "keys are missing" terminal below, so a normal
		// sync lag can never be mislabeled "re-run the script".
		m.contains("is not admitted to the Domain", ignoreCase = true) ->
			"Finishing up enrollment..." to ConnKind.ENROLLING
		m.contains("not enrolled", ignoreCase = true) ->
			"Not enrolled - re-run provision-console.sh and re-import the setup blob" to ConnKind.TERMINAL
		// A local provisioning gap (the blob did not carry the Switch keys/id). Worded in
		// ConsoleClient WITHOUT the "not admitted" token so it cannot collide with ENROLLING.
		m.contains("keys are missing", ignoreCase = true) || m.contains("not provisioned", ignoreCase = true) ->
			"Home Switch not provisioned - re-run provision-console.sh and re-import the setup blob" to ConnKind.TERMINAL
		m.startsWith("HTTP 400") ->
			"Protocol mismatch (400) - update the app, or re-run provision-console.sh" to ConnKind.TERMINAL
		m.startsWith("HTTP 401") ->
			"Bridge token rejected (401) - re-run provision-console.sh and re-import the blob" to ConnKind.TERMINAL
		m.startsWith("HTTP 403") ->
			"Not authorized (403) - cluster credentials expired, re-run provision-console.sh" to ConnKind.TERMINAL
		m.startsWith("HTTP 404") ->
			"Console bridge not deployed (404) - run provision-console.sh on the server" to ConnKind.TERMINAL
		m.startsWith("HTTP 409") ->
			"A previous send is still in flight - retrying" to ConnKind.TRANSIENT
		m.startsWith("HTTP 500") ->
			"Server error - retrying" to ConnKind.TRANSIENT
		m.startsWith("HTTP 502") || m.startsWith("HTTP 503") ->
			"The server is unreachable right now - retrying" to ConnKind.TRANSIENT
		m.startsWith("HTTP 504") ->
			"The server took too long to answer - retrying" to ConnKind.TRANSIENT
		e is javax.net.ssl.SSLHandshakeException || e is java.security.cert.CertificateException ||
			m.contains("trust anchor", ignoreCase = true) || m.contains("CertPath", ignoreCase = true) ->
			"Cluster CA changed - re-provision (the server certificate no longer matches)" to ConnKind.TERMINAL
		// Freshness/replay rejects clear on the next attempt (a retry carries a fresh
		// timestamp + new nonce), so they are transient. Checked AFTER the TLS branch so a
		// handshake-signature error is not mislabeled.
		m.contains("stale", ignoreCase = true) || m.contains("replay", ignoreCase = true) ->
			"Re-syncing the secure channel - retrying" to ConnKind.TRANSIENT
		// A genuine key mismatch (bad signature / cannot decrypt) is terminal.
		m.contains("signature", ignoreCase = true) || m.contains("decrypt", ignoreCase = true) ->
			"Secure channel rejected - re-run provision-console.sh and re-import the blob" to ConnKind.TERMINAL
		e is java.net.UnknownHostException ->
			"Offline - no network" to ConnKind.TRANSIENT
		e is java.net.ConnectException || e is java.net.SocketTimeoutException || e is java.io.InterruptedIOException ->
			"Can't reach the server - retrying" to ConnKind.TRANSIENT
		else -> "Error: ${m.take(100)}" to ConnKind.TRANSIENT
	}
}

/** Fold an ENROLLING (sync-lag) failure: start/keep the grace timer so we keep showing the
 * calm "Finishing up enrollment..." cause, but once the window lapses return a terminal
 * override message (and clear the timer) so a sync that never lands surfaces a real error.
 * Returns (overrideMessage-or-null, enrollingSince-to-persist). */
private fun enrollFold(prevSince: Long): Pair<String?, Long> {
	val since = if (prevSince == 0L) System.currentTimeMillis() else prevSince
	return if (System.currentTimeMillis() - since > ENROLL_GRACE_MS) {
		"Enrollment did not finish - re-run provision-console.sh and re-import the setup blob." to 0L
	} else {
		null to since
	}
}

/**
 * Repair a persisted/legacy thread or label key to canonical form under a known Switch id.
 * A bare name ("name") and - critically - an EMPTY-switch qualified key ("/name", minted in
 * a session before the Switch id was learned) both resolve to "<switchId>/name"; an already
 * canonical "switch/name" is unchanged. When switchId is empty (Switch not yet learned) the key
 * is returned unchanged and repaired later by recanonicalizeAllKeys once connect() learns
 * it. This closes the ghost-thread split where an inbound reply keys under "switch/name"
 * but the persisted/open thread is stuck at the empty-switch "/name", so the message renders
 * nowhere. `internal` so the unit test can pin the empty-switch repair.
 */
internal fun canonicalThreadKey(rawKey: String, switchId: String): String {
	SessionId.parse(rawKey, switchId)?.let { sid ->
		val t = sid.target
		val target = if (t.switchId.isEmpty() && switchId.isNotEmpty()) TeamAddress.remote(switchId, t.name) else t
		return SessionId.channel(sid.conversationId, target).key
	}
	val a = TeamAddress.parse(rawKey, switchId)
	val fixed = if (a.switchId.isEmpty() && switchId.isNotEmpty()) TeamAddress.remote(switchId, a.name) else a
	return fixed.canonical
}

/** Wraps a drained MailboxEntry as a SyncEntry so the SyncCursor rules can dedupe/advance
 * by seq while the poll loop keeps the full entry to render. */
private data class Drained(val entry: MailboxEntry) : SyncEntry {
	override val seq: Long get() = entry.seq
}

/**
 * Chat state over a ConsoleClient. Holds per-team threads, an unread tally, the open
 * tab set, and a poll loop that drains the device mailbox, dedupes by mailbox seq,
 * and routes each reply to its team (parsed from the `conv:<id>:<team>` session id
 * or the entry's `from`). Transcripts persist (encrypted) so history survives
 * restarts; the durable switch-side ledger is a later phase.
 */
class ChatRepository(
	private val store: ProvisioningStore,
	private val filesDir: File,
	private val contentResolver: ContentResolver,
	// STTS provider catalog, parsed + validated once from the bundled asset by
	// Repo.get. Empty only if the asset is missing/corrupt (Play stays dark).
	private val sttsCatalog: List<com.atelier_nyaarium.switchboard.proto.SttsProvider> = emptyList(),
) {
	// Declared before _state so loadPersistedThreads/Labels can normalize keys
	// through TeamAddress. Kotlin initializes fields in declaration order.
	@Volatile private var localSwitchId: String = store.loadSwitchId()

	private val _state = MutableStateFlow(
		ChatState(
			provisioned = store.load() != null,
			threads = loadPersistedThreads(),
			biometricLock = store.biometricLock,
			deviceName = currentDeviceName(),
			labels = loadPersistedLabels(),
			localSwitchId = localSwitchId,
		),
	)
	val state: StateFlow<ChatState> = _state

	// Lazy clients are read and invalidated across threads (poll loop, main,
	// the player's daemon thread); @Volatile gives the writes visibility. A
	// rare double-construct race is harmless (last writer wins, cheap build).
	@Volatile private var client: ConsoleClient? = null
	// The mailbox cursor is console-owned and durable: MailboxSync loads it from the store
	// and the console resumes from its own consumption point, never re-adopting a server-
	// dictated cursor that would ack away the offline backlog on the next poll.
	private val mailboxSync = MailboxSync(store)
	private var pollFails = 0
	private var pollJob: Job? = null
	// The poll loop's scope, reused to launch auto-TTS preloads that gate the
	// notification (so the audio is cached before the user is pinged).
	private var pollScope: CoroutineScope? = null

	/** TTS playback engine; cache lives under filesDir/stts/<team>/. */
	val stts = SttsPlayer(filesDir)
	@Volatile private var sttsClient: SttsClient? = null

	/** True while the Activity is started; drives the poll cadence (5s visible,
	 * 60s AFK burst). The mailbox accumulates server-side either way. */
	@Volatile private var visible = false
	val isVisible: Boolean get() = visible
	private val kick = Channel<Unit>(Channel.CONFLATED)
	@Volatile private var forceTeamsRefresh = false
	// Rows already given their one reconcile attempt this process. Synchronized:
	// the service's start and the Activity's foreground transition can race here.
	private val reconciled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	/** Set by the service: called per poll with the new inbound messages of one
	 * team, so a background burst can become a notification. */
	var onInbound: ((team: String, messages: List<Message>) -> Unit)? = null

	/** The Activity came on screen: switch to the fast cadence, optimistically
	 * clear a doze-corpse failure banner (the kicked poll re-raises it within
	 * seconds if the bridge is genuinely down), and poll right now. */
	fun onForeground() {
		visible = true
		pollFails = 0
		_state.update { it.copy(error = null, pollFailStreak = 0, enrollingSince = 0L) }
		forceTeamsRefresh = true
		kick.trySend(Unit)
	}

	fun onBackground() {
		visible = false
	}

	private fun client(): ConsoleClient {
		client?.let { return it }
		val blob = store.load() ?: error("not provisioned")
		return ConsoleClient(Provisioning.parse(blob), store).also { client = it }
	}

	/** STTS client from the provisioning blob, or null when not configured.
	 * Rebuilt after re-provisioning (the same client=null invalidation). */
	private fun sttsClient(): SttsClient? {
		sttsClient?.let { return it.takeIf { c -> c.isConfigured } }
		val blob = store.load() ?: return null
		val prov = runCatching { Provisioning.parse(blob) }.getOrNull() ?: return null
		return SttsClient(prov.sttsUrl, prov.sttsKey).also { sttsClient = it }.takeIf { it.isConfigured }
	}

	/** Gates the Play surfaces; true once the blob carries sttsUrl + sttsKey AND
	 * the bundled catalog parsed (without descriptors there is nothing to play). */
	fun sttsReady(): Boolean = sttsClient() != null && sttsCatalog.isNotEmpty()

	/** The provider descriptors for the settings picker. */
	fun sttsProviders(): List<com.atelier_nyaarium.switchboard.proto.SttsProvider> = sttsCatalog

	/** The selected provider id (the descriptor id, e.g. "XAI"). Unset resolves
	 * to XAI when present, else the first descriptor. */
	var sttsProviderId: String
		get() {
			val stored = store.sttsProvider
			if (stored.isNotEmpty()) return stored
			return sttsCatalog.firstOrNull { it.id == "XAI" }?.id ?: sttsCatalog.firstOrNull()?.id ?: ""
		}
		set(value) {
			store.sttsProvider = value
		}

	/** The descriptor for the current selection, or null if the stored id is not
	 * in the catalog (a removed provider) - the Play surfaces disable loudly
	 * rather than silently substituting another voice. */
	private fun currentProvider(): com.atelier_nyaarium.switchboard.proto.SttsProvider? {
		val id = sttsProviderId
		return sttsCatalog.firstOrNull { it.id == id }
	}

	/** True when the stored provider id is non-empty but absent from the catalog. */
	fun sttsProviderMissing(): Boolean {
		val id = store.sttsProvider
		return id.isNotEmpty() && sttsCatalog.none { it.id == id }
	}

	/** Per-provider voice; blank uses the descriptor default. Reads seed once
	 * from the legacy global voice so an existing install keeps its choice. */
	fun sttsVoiceFor(providerId: String): String {
		val perProvider = store.sttsVoiceFor(providerId)
		if (perProvider.isNotEmpty()) return perProvider
		val legacy = store.sttsVoice
		if (legacy.isNotEmpty() && providerId == sttsProviderId) {
			store.setSttsVoiceFor(providerId, legacy)
			return legacy
		}
		return ""
	}

	fun setSttsVoiceFor(providerId: String, voice: String) = store.setSttsVoiceFor(providerId, voice.trim())

	/**
	 * Speak one message tier (notification action or thread button). The whole
	 * resolution (credential decrypt, message lookup, text prep) hops to the
	 * player's daemon thread so a broadcast receiver's main thread does zero
	 * disk or crypto work. Cache and single-flight live in SttsPlayer, so
	 * impatient multi-taps synthesize once; tapping the playing message stops
	 * it. No-op when unconfigured or the message is gone.
	 */
	fun playMessage(team: String, at: Long, tier: SttsPlayer.Tier) {
		stts.post {
			val client = sttsClient() ?: return@post
			val provider = currentProvider() ?: return@post
			val msg = _state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe } ?: return@post
			val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
			stts.play(client, provider, voice, team, at, tier, SttsPlayer.ttsText(msg, tier))
		}
	}

	/** When on, an incoming message for a followed (open) thread is
	 * pre-synthesized before its notification. Persisted in prefs. */
	var sttsAutoGen: Boolean
		get() = store.autoTts
		set(value) {
			store.autoTts = value
		}

	/** When on (with sttsAutoGen), the summary plays aloud automatically once it
	 * is synthesized. Persisted in prefs. */
	var sttsAutoPlaySummary: Boolean
		get() = store.autoPlaySummary
		set(value) {
			store.autoPlaySummary = value
		}

	/** Pre-synthesize both tiers of a message into the cache so a later Play is
	 * instant. Blocking; runs off the poll loop on an IO thread. Silent on any
	 * failure - the notification fires regardless and Play falls back to live
	 * synthesis. No-op when unconfigured or the message is gone. */
	private fun preloadMessage(team: String, at: Long) {
		val client = sttsClient() ?: return
		val provider = currentProvider() ?: return
		val msg = _state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe } ?: return
		val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		stts.preloadBoth(
			client,
			provider,
			voice,
			team,
			at,
			SttsPlayer.ttsText(msg, SttsPlayer.Tier.SUMMARY),
			SttsPlayer.ttsText(msg, SttsPlayer.Tier.FULL),
		)
	}

	/** Settings voice preview with the current provider/voice. */
	fun playSttsSample() {
		stts.post {
			val client = sttsClient() ?: return@post
			val provider = currentProvider() ?: return@post
			val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
			stts.playSample(client, provider, voice, "This is your switchboard voice.")
		}
	}

	/** STTS service liveness for the settings indicator. */
	suspend fun sttsHealth(): Boolean = withContext(Dispatchers.IO) { sttsClient()?.health() == true }

	suspend fun provision(blob: String) = withContext(Dispatchers.IO) {
		// Strict wire parse: reject before persisting. Surfaced as state.error
		// rather than thrown - callers launch this from coroutines with no
		// catch, and the strict kotlinx parse rejects blobs the old lenient
		// org.json parser would have coerced (single quotes, stringy numbers).
		val prov = try {
			Provisioning.parse(blob)
		} catch (e: Exception) {
			_state.update { it.copy(error = "Invalid provisioning blob: ${e.message?.take(160) ?: "unparseable"}") }
			return@withContext
		}
		store.save(blob)
		// If the setup script (provision-console.sh --setup) embedded a Console identity,
		// import it into the keystore so the device is enrolled from the blob ALONE - no
		// separate enroll/QR step. A decode/persist failure is non-fatal: re-run the setup
		// script and re-import. A legacy blob (no identity) leaves the prior identity intact.
		if (prov.identity.isNotEmpty()) {
			runCatching { store.saveIdentity(wireJson.decodeFromString(Crypto.Identity.serializer(), prov.identity)) }
				.onFailure { DebugLog.log("Provision", "identity import failed: ${it.message?.take(120)}") }
		}
		// The setup script also embeds the home Switch's id + keys, so the app can seal its
		// FIRST op (register is itself sealed) without an admit-switch scan. Persist them the
		// same way admit-switch used to. Non-fatal: a legacy blob omits these and the app then
		// needs an interactive admit.
		if (prov.switchId.isNotEmpty() && prov.switchSignPub.isNotEmpty() && prov.switchBoxPub.isNotEmpty()) {
			runCatching {
				store.saveSwitchKeys(prov.switchId, prov.switchSignPub, prov.switchBoxPub)
				store.saveSwitchId(prov.switchId)
			}.onFailure { DebugLog.log("Provision", "switch-keys import failed: ${it.message?.take(120)}") }
		}
		client = null
		sttsClient = null
		_state.update { it.copy(provisioned = true, error = null, deviceName = prov.device) }
	}

	suspend fun connect() = withContext(Dispatchers.IO) {
		try {
			// Preflight the cluster path (API server + SA token + TLS) before blaming the
			// bridge or enrollment, so a stale blob says "re-provision" and a missing
			// identity says "not enrolled" - two different fixes that used to look identical.
			runCatching { client().apiReachable() }.onFailure { e ->
				val (cause, kind) = classifyConnError(e)
				_state.update {
					if (kind == ConnKind.TERMINAL) {
						it.copy(status = "error", error = "Cluster: $cause", connected = false, enrollingSince = 0L)
					} else {
						it.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
					}
				}
				return@withContext
			}
			// register's cursor/epoch are no longer adopted: MailboxSync owns the durable
			// cursor. We still register (to learn switchId, claim the mailbox, get the epoch
			// the box is on); the poll loop's advance() reconciles any epoch change.
			val reg = client().register()
			reg.switchId?.let { id ->
				if (id.isNotEmpty() && id != localSwitchId) {
					localSwitchId = id
					store.saveSwitchId(id)
				}
			}
			// Repair any thread/label/unread/tab key minted under an empty/unknown switch
			// now that the real switch id is known, so an inbound reply (keyed switch/name)
			// can no longer file into a ghost "/name" thread the open tab cannot read.
			recanonicalizeAllKeys(localSwitchId)
			// Pin every subsequent relay to this home Switch so the Switch routes there
			// even once other Switches join the mesh.
			client().homeSwitch = localSwitchId.ifEmpty { null }
			// A teams refresh failure is not a connect failure: register succeeded, so we
			// are connected. Log and proceed with the prior team list rather than masking
			// the error as an empty board (which would blank live sessions).
			val teams = runCatching { client().teams(localSwitchId) }.getOrElse {
				DebugLog.log("Connect", "teams refresh failed: ${it.message?.take(120)}")
				_state.value.teams
			}
			_state.update {
				it.copy(
					teams = teams,
					status = "connected",
					error = null,
					connected = true,
					pollFailStreak = 0,
					localSwitchId = localSwitchId,
					enrollingSince = 0L,
				)
			}
			// Attach ingest now that we have the provisioning. DEBUG-only inside attachIngest.
			val blob = store.load()
			if (blob != null) runCatching { DebugLog.attachIngest(Provisioning.parse(blob)) }
		} catch (e: Exception) {
			val (cause, kind) = classifyConnError(e)
			_state.update { s ->
				when (kind) {
					// Post-enroll sync lag: calm "Finishing up enrollment..." (the poll loop
					// keeps retrying + clears it on the first success), escalating past the grace.
					ConnKind.ENROLLING -> {
						val (override, since) = enrollFold(s.enrollingSince)
						s.copy(
							status = if (override != null) "error" else "connecting",
							error = override ?: cause,
							connected = false,
							enrollingSince = since,
						)
					}
					ConnKind.TERMINAL -> s.copy(status = "error", error = cause, connected = false, enrollingSince = 0L)
					ConnKind.TRANSIENT -> s.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
				}
			}
		}
	}

	suspend fun refreshTeams() = withContext(Dispatchers.IO) {
		runCatching { client().teams(localSwitchId) }.onSuccess { t -> _state.update { it.copy(teams = t) } }
	}

	/** Repair every in-memory key (threads, unread, labels, open tabs) to canonical once
	 * the switch id is known, merging any collisions, so a thread loaded under an empty or
	 * unknown switch ("/name") can no longer shadow the canonical "switch/name" an inbound
	 * reply keys under. A no-op when every key is already canonical (the steady state),
	 * so it costs nothing on a normal connect; only a one-time repair persists. The repair
	 * lands at the startup connect() before any thread WebView is open (openTabs is not
	 * persisted, so it is empty at launch) and is a no-op on every later reconnect, so it
	 * cannot reorder/merge a thread out from under a live renderer. */
	private fun recanonicalizeAllKeys(switchId: String) {
		if (switchId.isEmpty()) return
		val s0 = _state.value
		val dirty = s0.threads.keys.any { it != canonicalThreadKey(it, switchId) } ||
			s0.labels.keys.any { it != canonicalThreadKey(it, switchId) } ||
			s0.unread.keys.any { it != canonicalThreadKey(it, switchId) } ||
			s0.openTabs.any { it != canonicalThreadKey(it, switchId) }
		if (!dirty) return
		val next = _state.updateAndGet { s ->
			val threads = LinkedHashMap<String, MutableList<Message>>()
			for ((k, msgs) in s.threads) threads.getOrPut(canonicalThreadKey(k, switchId)) { mutableListOf() }.addAll(msgs)
			val mergedThreads =
				threads.mapValues { (_, m) -> m.sortedBy { it.at }.mapIndexed { i, x -> x.copy(id = i.toLong()) } }
			val unread = LinkedHashMap<String, Int>()
			for ((k, n) in s.unread) {
				val ck = canonicalThreadKey(k, switchId)
				unread[ck] = (unread[ck] ?: 0) + n
			}
			val labels = LinkedHashMap<String, String>()
			for ((k, v) in s.labels) labels[canonicalThreadKey(k, switchId)] = v
			val openTabs = s.openTabs.map { canonicalThreadKey(it, switchId) }.distinct()
			s.copy(threads = mergedThreads, unread = unread, labels = labels, openTabs = openTabs)
		}
		persistThreads(next.threads)
		persistLabels(next.labels)
	}

	suspend fun send(team: String, text: String, uris: List<Uri> = emptyList()) = withContext(Dispatchers.IO) {
		val picked = uris.mapNotNull { readUri(it) }
		val total = picked.sumOf { it.bytes.size }
		if (total > MAX_OUTGOING_BYTES) {
			_state.update { it.copy(error = "Attachments too large (max ${MAX_OUTGOING_BYTES / 1_000_000} MB).") }
			return@withContext
		}
		// Local echo: persist the picked files so the sent message shows its own
		// thumbnails through the same asset-loader path as inbound files. The echo
		// starts "pending" and resolves to sent (null) or "error" when the op lands.
		val localFiles = Attachments.storeOutgoing(filesDir, "out-${System.currentTimeMillis()}", picked)
		val opId = java.util.UUID.randomUUID().toString()
		val echoId = append(
			team,
			Message(true, text, System.currentTimeMillis(), files = localFiles, status = "pending", opId = opId),
		)
		val wasAvailable = _state.value.teams.firstOrNull { it.name == team }?.status == "available"
		val hasPlaceholder = _state.value.threads[team]?.any { !it.fromMe && it.status == "waking" } == true
		var placeholderId: Long? = null
		if (wasAvailable && !hasPlaceholder) {
			// Cold wake takes minutes with no wire traffic; show one placeholder row
			// that the first real reply resolves in place (appendInbound). "waking"
			// is a local-only status, so a future wire "running" can never be
			// mistaken for it.
			placeholderId = append(
				team,
				Message(false, "Waking $team... first boot can take a minute or two.", System.currentTimeMillis(), status = "waking"),
			)
		}
		deliver(team, echoId, text, picked, opId, placeholderId)
	}

	/** Re-send a failed message, rebuilding attachment bytes from their local
	 * copies. The error -> pending flip is the atomic claim: a double-tap's second
	 * coroutine finds the row already pending and backs off, so the wire send runs
	 * once. The original opId is reused so the arbiter dedupes a lost-reply retry. */
	suspend fun retrySend(team: String, messageId: Long) = withContext(Dispatchers.IO) {
		var claimed = false
		_state.update { s ->
			val thread = s.threads[team] ?: return@update s.also { claimed = false }
			val msg = thread.firstOrNull { it.id == messageId }
			if (msg == null || !msg.fromMe || msg.status != "error") {
				claimed = false
				s
			} else {
				claimed = true
				s.copy(threads = s.threads + (team to thread.map { if (it.id == messageId) it.copy(status = "pending") else it }))
			}
		}
		if (!claimed) return@withContext
		val msg = _state.value.threads[team]?.firstOrNull { it.id == messageId } ?: return@withContext
		persistThreads(_state.value.threads)
		val files = rebuildFiles(msg)
		if (msg.text.isBlank() && files.isEmpty()) {
			// Nothing recoverable (attachment copies gone); put the badge back and say why.
			setMessageStatus(team, messageId, "error")
			_state.update { it.copy(error = "Attachments are no longer on this device; cannot retry.") }
			return@withContext
		}
		if (files.size < msg.files.size) {
			_state.update { it.copy(error = "Some attachments are no longer on this device; resending the rest.") }
		}
		deliver(team, messageId, msg.text, files, msg.opId ?: java.util.UUID.randomUUID().toString(), null)
	}

	/** Run the wire send and settle the echo row's state from the outcome. On
	 * failure the cold-wake placeholder (if this send created one) is removed:
	 * nothing is coming to resolve it. */
	private fun deliver(
		team: String,
		echoId: Long,
		text: String,
		picked: List<OutgoingFile>,
		opId: String,
		placeholderId: Long?,
	) {
		fun fail(message: String?) {
			_state.update { it.copy(error = message ?: "send failed") }
			setMessageStatus(team, echoId, "error")
			if (placeholderId != null) removeMessage(team, placeholderId)
		}
		try {
			val r = client().send(team, text, picked, opId)
			when {
				!r.ok -> fail(r.error)
				else -> setMessageStatus(team, echoId, null)
			}
		} catch (e: Exception) {
			// Route through the same classifier the poll loop + connect use, so a send
			// surfaces a legible cause ("Can't reach the server", "Bridge token rejected")
			// instead of a raw "HTTP 401: {json}" exception string.
			val (cause, _) = classifyConnError(e)
			fail(cause)
		}
	}

	/** Rebuild outgoing bytes from the local attachment copies stored at first
	 * send; files whose copies are gone are dropped (caller decides how loudly). */
	private fun rebuildFiles(msg: Message): List<OutgoingFile> = msg.files.mapNotNull { f ->
		val rel = f.src?.substringAfter("/${Attachments.DIR}/", "")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
		val file = Attachments.resolve(filesDir, rel) ?: return@mapNotNull null
		runCatching { OutgoingFile(f.name, f.mime, file.readBytes()) }.getOrNull()
	}

	private fun removeMessage(team: String, id: Long) {
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team] ?: return@updateAndGet s
			s.copy(threads = s.threads + (team to thread.filterNot { it.id == id }))
		}.threads
		persistThreads(threads)
	}

	private fun setMessageStatus(team: String, id: Long, status: String?) {
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team] ?: return@updateAndGet s
			s.copy(threads = s.threads + (team to thread.map { if (it.id == id) it.copy(status = status) else it }))
		}.threads
		persistThreads(threads)
	}

	private fun readUri(uri: Uri): OutgoingFile? = runCatching {
		val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
		val mime = contentResolver.getType(uri) ?: "application/octet-stream"
		OutgoingFile(queryName(uri) ?: "file", mime, bytes)
	}.getOrNull()

	private fun queryName(uri: Uri): String? = runCatching {
		contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
			if (c.moveToFirst()) c.getString(0) else null
		}
	}.getOrNull()

	fun startPolling(scope: CoroutineScope) {
		if (pollJob?.isActive == true) return
		pollScope = scope
		pollJob = scope.launch(Dispatchers.IO) {
			var lastTeamsAt = 0L
			while (isActive) {
				var failed = false
				var heldEmpty = false
				var hold = 0L
				try {
					// The board's live/available states would otherwise only change on
					// a manual Refresh; piggyback a team-list refresh on the poll loop.
					val now = System.currentTimeMillis()
					if (forceTeamsRefresh || now - lastTeamsAt >= TEAMS_REFRESH_MS) {
						forceTeamsRefresh = false
						lastTeamsAt = now
						runCatching { client().teams(localSwitchId) }.onSuccess { t ->
							_state.update { it.copy(teams = t) }
						}
					}
					// Visible: long-poll (the hold IS the wait; re-poll immediately).
					// AFK: plain poll, then sleep an interval; the mailbox batches.
					hold = if (visible) LONG_POLL_HOLD_MS else 0L
					val started = System.currentTimeMillis()
					val params = mailboxSync.pollParams()
					DebugLog.log("Poll", "firing cursor=${params.cursor} epoch=${params.epoch} hold=${hold}ms")
					val mb = client().poll(params.cursor, params.epoch, hold)
					// An old arbiter ignores holdMs and returns empty instantly; floor
					// the cadence so that degradation never becomes a tight spin.
					heldEmpty = hold > 0 && mb.entries.isEmpty() &&
						System.currentTimeMillis() - started < 3_000
					// Fold the result through the durable cursor: epoch flip, seq dedupe (a
					// lost-ack re-drain), and the dropped-gap DELTA all live in advance(), which
					// returns only genuinely-fresh entries. commit() advances the cursor LAST,
					// after the fresh entries are rendered + persisted (two-phase: a crash
					// re-delivers rather than skips).
					val adv = mailboxSync.advance(
						SyncPollResult(mb.entries.map { Drained(it) }, mb.cursor, mb.epoch, mb.dropped),
					)
					if (mb.entries.isEmpty()) {
						DebugLog.log("Poll", "empty (held=$heldEmpty epoch=${mb.epoch} cursor=${mb.cursor} dropped=${mb.dropped})")
					} else {
						DebugLog.log("Poll", "${adv.fresh.size}/${mb.entries.size} fresh epoch=${mb.epoch} cursor=${mb.cursor} dropped=${mb.dropped}")
					}
					if (adv.gap) _state.update { it.copy(gap = true) }
					val burst = mutableMapOf<String, MutableList<Message>>()
					for (d in adv.fresh) {
						val e = d.entry
						// Determine which team key this entry belongs to.
						// Notices thread under the sender canonical; conv sessions use the
						// session target, except when the tail is THIS device (Face-4: an
						// agent-initiated push whose session tail is our device name should
						// thread under `from`, not under ourselves).
						// Resolve the thread key for this entry; null means drop it.
						val team: String? = if (e.kind == "notice") {
							// Notice: prefer `from`, fall back to NoticeId parse.
							e.from?.let { TeamAddress.parse(it, localSwitchId).canonical }
								?: NoticeId.parse(e.session_id, localSwitchId)?.sender?.canonical
						} else {
							val sid = SessionId.parse(e.session_id, localSwitchId)
							if (sid != null) {
								val thisDevice = TeamAddress.local(localSwitchId, currentDeviceName())
								if (sid.target == thisDevice) {
									// Face-4: session tail is this device; thread under sender.
									e.from?.let { TeamAddress.parse(it, localSwitchId).canonical } ?: sid.target.canonical
								} else {
									sid.target.canonical
								}
							} else {
								// Not a conv session id; fall back to `from` if present.
								e.from?.let { TeamAddress.parse(it, localSwitchId).canonical }
							}
						}
						if (team == null) {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} from=${e.from} -> DROPPED (unresolvable team)")
							continue
						}
						val files = Attachments.decode(filesDir, mb.epoch, e.seq, e.files)
						// status-only entries still land (e.g. a wake-failure error
						// with no body would otherwise vanish).
						val bodyText = e.body.orEmpty()
						val snippet = bodyText.replace(Regex("\\s+"), " ").trim().take(80)
						if (bodyText.isNotEmpty() || files.isNotEmpty() || e.status != null) {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} -> thread=$team status=${e.status} files=${files.size} \"$snippet\"")
							val msg =
								Message(false, bodyText, e.at, files = files, status = e.status, title = e.title, summary = e.summary, epoch = mb.epoch, seq = e.seq)
							// appendInbound folds an at-least-once re-drain in place and returns
							// false, so a redelivered entry never re-bumps unread or re-notifies.
							if (appendInbound(team, msg)) {
								bumpUnread(team)
								burst.getOrPut(team) { mutableListOf() }.add(msg)
							}
						} else {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} -> thread=$team SKIPPED (no body, no files, no status)")
						}
					}
					for ((team, msgs) in burst) {
						val lastAgent = msgs.lastOrNull { !it.fromMe }
						// Only spend synthesis on followed threads (open tabs); a
						// never-opened or forgotten session is not in openTabs, so it
						// notifies without preloading.
						val followed = team in _state.value.openTabs
						val scope = pollScope
						if (scope != null && lastAgent != null && sttsAutoGen && sttsReady() && followed) {
							val t = team
							val ms = msgs
							val at = lastAgent.at
							scope.launch(Dispatchers.IO) {
								// Wait fully for synthesis so the cache is warm when the
								// notification lands. preloadMessage never throws and is
								// bounded by the STTS client's own timeouts, so a failed or
								// slow synth still falls through and the notification fires.
								preloadMessage(t, at)
								onInbound?.invoke(t, ms)
								// Hands-free: speak the summary the moment it is ready (a
								// cache hit from the preload above).
								if (sttsAutoPlaySummary) playMessage(t, at, SttsPlayer.Tier.SUMMARY)
							}
						} else {
							onInbound?.invoke(team, msgs)
						}
					}
					mailboxSync.commit(adv.next)
					pollFails = 0
					if (_state.value.error != null || _state.value.pollFailStreak != 0) {
						_state.update { it.copy(error = null, pollFailStreak = 0, connected = true, enrollingSince = 0L) }
					}
					// Flush buffered debug lines to the ingest endpoint once per cycle.
					DebugLog.flushToIngest()
				} catch (e: Exception) {
					if (hold > 0 && e.message?.startsWith("HTTP 504") == true) {
						// A relay-timeout during a hold is an empty long-poll, not an
						// outage: an evie still on the shorter hold (upgrade window) or
						// a transient arbiter drop mid-hold. Back off, do not alarm.
						DebugLog.log("Poll", "hold timeout (504) treated as empty long-poll")
						heldEmpty = true
					} else {
						// Name the SPECIFIC cause instead of a blanket "Connection issue". A
						// TERMINAL cause (not enrolled, bridge not deployed, bad creds) cannot
						// clear by retrying, so surface it on the first failure; a TRANSIENT blip
						// waits for a second failure so one hiccup never alarms; an ENROLLING
						// sync-lag shows the calm "Finishing up enrollment..." at once and the
						// poll loop's own retry clears it the moment an op succeeds.
						val (cause, kind) = classifyConnError(e)
						DebugLog.log("Poll", "error streak=${ pollFails + 1 } [$kind]: ${e.message?.take(120)}")
						failed = true
						pollFails++
						_state.update { s ->
							when (kind) {
								ConnKind.ENROLLING -> {
									val (override, since) = enrollFold(s.enrollingSince)
									s.copy(pollFailStreak = pollFails, error = override ?: cause, enrollingSince = since)
								}
								ConnKind.TERMINAL -> s.copy(pollFailStreak = pollFails, error = cause, enrollingSince = 0L)
								ConnKind.TRANSIENT ->
									s.copy(pollFailStreak = pollFails, error = if (pollFails >= 2) cause else s.error, enrollingSince = 0L)
							}
						}
					}
					DebugLog.flushToIngest()
				}
				// Adaptive cadence with a foreground kick: a resume interrupts the
				// AFK wait so the user never stares at stale state. Visible long-polls
				// chain back-to-back; failures and ignored holds back off to 5s.
				val interval = when {
					!visible -> AFK_POLL_INTERVAL_MS
					failed || heldEmpty -> POLL_INTERVAL_MS
					else -> 0L
				}
				if (interval > 0) withTimeoutOrNull(interval) { kick.receive() }
			}
		}
	}

	/** Re-deliver echoes stranded "pending" (process death, doze-killed socket)
	 * once each, using their original opId: the arbiter replays the cached result
	 * if the send actually landed, so this can never double-deliver. A row whose
	 * send never landed re-fails to the tap-to-retry badge. */
	suspend fun reconcilePending() = withContext(Dispatchers.IO) {
		for ((team, msgs) in _state.value.threads) {
			for (m in msgs) {
				if (!m.fromMe || m.status != "pending") continue
				val key = "$team:${m.id}"
				if (!reconciled.add(key)) continue
				if (m.opId == null) {
					// Legacy row with no opId: cannot re-send safely; make it retriable.
					setMessageStatus(team, m.id, "error")
					continue
				}
				deliver(team, m.id, m.text, rebuildFiles(m), m.opId, null)
			}
		}
	}

	/** Clear a team's unread tally without touching tabs (swipe-away on its
	 * notification reads the burst without opening the thread). */
	fun markRead(team: String) {
		_state.update { s -> s.copy(unread = s.unread - team) }
	}

	fun openThread(team: String) {
		_state.update { s ->
			s.copy(
				unread = s.unread - team,
				openTabs = if (team in s.openTabs) s.openTabs else s.openTabs + team,
			)
		}
	}

	fun closeTab(team: String) {
		_state.update { it.copy(openTabs = it.openTabs - team) }
	}

	/** Give a team a local display label (or clear it with a blank name). */
	fun setLabel(team: String, name: String) {
		val labels = _state.updateAndGet { s ->
			val next = if (name.isBlank()) s.labels - team else s.labels + (team to name.trim())
			s.copy(labels = next)
		}.labels
		persistLabels(labels)
	}

	/** Drop a peer from this device: its thread, unread, tab, label, and any
	 * cached TTS audio. */
	fun forget(team: String) {
		val next = _state.updateAndGet { s ->
			s.copy(
				threads = s.threads - team,
				labels = s.labels - team,
				unread = s.unread - team,
				openTabs = s.openTabs - team,
			)
		}
		persistThreads(next.threads)
		persistLabels(next.labels)
		stts.purge(team)
	}

	fun setBiometricLock(enabled: Boolean) {
		store.biometricLock = enabled
		_state.update { it.copy(biometricLock = enabled) }
	}

	suspend fun setDeviceName(name: String) = withContext(Dispatchers.IO) {
		val blob = store.load() ?: return@withContext
		val j = JSONObject(blob).put("device", name)
		store.save(j.toString())
		client = null
		_state.update { it.copy(deviceName = name) }
		connect()
	}

	private fun currentDeviceName(): String =
		store.load()?.let { runCatching { Provisioning.parse(it).device }.getOrNull() } ?: ""

	suspend fun clearAll() = withContext(Dispatchers.IO) {
		pollJob?.cancel()
		store.clear()
		client = null
		sttsClient = null
		stts.purgeAll()
		localSwitchId = ""
		mailboxSync.clearInMemory()
		_state.value = ChatState(provisioned = false)
	}

	private fun append(team: String, msg: Message): Long {
		var newId = 0L
		val threads = _state.updateAndGet { s ->
			val existing = s.threads[team].orEmpty()
			newId = (existing.maxOfOrNull { it.id } ?: -1L) + 1
			s.copy(threads = s.threads + (team to (existing + msg.copy(id = newId))))
		}.threads
		persistThreads(threads)
		return newId
	}

	/** Append a message that came from the wire. If the thread holds the synthetic
	 * waking placeholder (wherever it sits - a second send may have landed after
	 * it), the first real word from the team resolves it in place (same row id),
	 * so the placeholder never lingers in the transcript. */
	private fun appendInbound(team: String, msg: Message): Boolean {
		// At-least-once dedup: an entry with the same mailbox (epoch, seq) was already
		// rendered, so fold it in place and report no new render (no re-notify/TTS).
		// seq 0 is a local or legacy row that never re-drains, so it is exempt.
		if (msg.seq > 0) {
			var folded = false
			val updated = _state.updateAndGet { s ->
				val thread = s.threads[team].orEmpty()
				val idx = thread.indexOfFirst { it.seq == msg.seq && it.epoch == msg.epoch }
				if (idx >= 0) {
					folded = true
					val next = thread.toMutableList().also { it[idx] = msg.copy(id = thread[idx].id) }
					s.copy(threads = s.threads + (team to next))
				} else {
					folded = false
					s
				}
			}
			if (folded) {
				persistThreads(updated.threads)
				return false
			}
		}
		var replaced = true
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team].orEmpty()
			val idx = thread.indexOfLast { !it.fromMe && it.status == "waking" }
			if (idx >= 0) {
				val next = thread.toMutableList().also { it[idx] = msg.copy(id = thread[idx].id) }
				s.copy(threads = s.threads + (team to next))
			} else {
				replaced = false
				s
			}
		}.threads
		if (replaced) {
			persistThreads(threads)
		} else {
			append(team, msg)
		}
		return true
	}

	private fun bumpUnread(team: String) {
		_state.update { s -> s.copy(unread = s.unread + (team to (s.unread[team] ?: 0) + 1)) }
	}

	private fun persistThreads(threads: Map<String, List<Message>>) {
		val root = JSONObject()
		for ((team, msgs) in threads) {
			val arr = JSONArray()
			for (m in msgs) {
				val obj = JSONObject().put("me", m.fromMe).put("text", m.text).put("at", m.at)
				obj.putOpt("status", m.status)
				obj.putOpt("opId", m.opId)
				if (m.epoch != 0L) obj.put("epoch", m.epoch)
				if (m.seq != 0L) obj.put("seq", m.seq)
				obj.putOpt("title", m.title)
				obj.putOpt("summary", m.summary)
				// Persist local paths (the decoded files survive on disk), never base64.
				if (m.files.isNotEmpty()) {
					val files = JSONArray()
					for (f in m.files) {
						files.put(JSONObject().put("name", f.name).put("mime", f.mime).putOpt("src", f.src))
					}
					obj.put("files", files)
				}
				arr.put(obj)
			}
			root.put(team, arr)
		}
		runCatching { store.saveThreads(root.toString()) }
	}

	private fun loadPersistedThreads(): Map<String, List<Message>> {
		val json = store.loadThreads() ?: return emptyMap()
		return runCatching {
			val root = JSONObject(json)
			// Accumulate per canonical key so two legacy keys that repair to the same
			// canonical thread (e.g. "/9cb5b9" and "switchboard/9cb5b9") MERGE instead of
			// the second silently dropping the first.
			val merged = LinkedHashMap<String, MutableList<Message>>()
			for (rawKey in root.keys()) {
				val canonicalKey = canonicalThreadKey(rawKey, localSwitchId)
				val arr = root.getJSONArray(rawKey)
				val loaded = (0 until arr.length()).map {
					val m = arr.getJSONObject(it)
					Message(
						m.optBoolean("me"),
						m.optString("text"),
						m.optLong("at"),
						0L,
						loadFiles(m),
						m.optString("status").takeIf { s -> s.isNotEmpty() },
						m.optString("opId").takeIf { s -> s.isNotEmpty() },
						title = m.optString("title").takeIf { s -> s.isNotEmpty() },
						summary = m.optString("summary").takeIf { s -> s.isNotEmpty() },
						epoch = m.optLong("epoch", 0L),
						seq = m.optLong("seq", 0L),
					)
				}
					// A "waking" placeholder has no resolution coming after a process
					// death; drop it. "pending" echoes WITH an opId are kept for the
					// service's idempotent reconcile; legacy ones without an opId cannot
					// be re-sent safely, so they demote to retriable here (and never
					// strand a forever-working chip if the service fails early).
					.filterNot { !it.fromMe && it.status == "waking" }
					.map { if (it.fromMe && it.status == "pending" && it.opId == null) it.copy(status = "error") else it }
				merged.getOrPut(canonicalKey) { mutableListOf() }.addAll(loaded)
			}
			// id is not persisted; assign a dense per-thread id by time order AFTER any
			// merge, so it stays unique within the (possibly merged) thread.
			merged.mapValues { (_, msgs) -> msgs.sortedBy { it.at }.mapIndexed { i, m -> m.copy(id = i.toLong()) } }
		}.getOrDefault(emptyMap())
	}

	private fun loadFiles(m: JSONObject): List<MessageFile> {
		val arr = m.optJSONArray("files") ?: return emptyList()
		return (0 until arr.length()).map {
			val f = arr.getJSONObject(it)
			MessageFile(f.optString("name"), f.optString("mime"), f.optString("src").takeIf { s -> s.isNotEmpty() })
		}
	}

	private fun persistLabels(labels: Map<String, String>) {
		val root = JSONObject()
		for ((team, name) in labels) root.put(team, name)
		runCatching { store.saveLabels(root.toString()) }
	}

	private fun loadPersistedLabels(): Map<String, String> {
		val json = store.loadLabels() ?: return emptyMap()
		return runCatching {
			val root = JSONObject(json)
			// Normalize legacy bare/empty-switch keys to canonical form on load.
			buildMap {
				for (rawKey in root.keys()) {
					put(canonicalThreadKey(rawKey, localSwitchId), root.getString(rawKey))
				}
			}
		}.getOrDefault(emptyMap())
	}

	private companion object {
		const val POLL_INTERVAL_MS = 5_000L
		// AFK cadence: one plain poll a minute drains the accumulated burst.
		const val AFK_POLL_INTERVAL_MS = 60_000L
		// Visible cadence: server-held long-poll (under the arbiter's 45s cap).
		const val LONG_POLL_HOLD_MS = 40_000L
		// Refresh the team list at most this often, regardless of poll cadence.
		const val TEAMS_REFRESH_MS = 30_000L
		const val MAX_OUTGOING_BYTES = 10_000_000
	}
}
