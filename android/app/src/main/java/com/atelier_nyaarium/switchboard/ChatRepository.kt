package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
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
 * replace a row in place). It is NOT the mailbox seq; poll dedupe stays lastSeq-based.
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
	 * delivering to the agent (the phone protocol contract). */
	val opId: String? = null,
	/** Notification-bar line for broadcast notices. Notification-only: the thread
	 * renders the body as usual and never shows this. */
	val title: String? = null,
	/** The Short tier of a notice, persisted for an upcoming feature; no UI
	 * reads it yet. */
	val summary: String? = null,
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
) {
	/** Sessions shows live teams plus any team we already have a thread with
	 * (agent-initiated). A thread-only peer is gone from the bridge and cannot be
	 * woken, so it is synthesized as an ended loose session with no mode. */
	val sessions: List<Team>
		get() {
			val known = teams.associateBy { it.name }
			val extra = threads.keys.filter { it !in known }.map { Team(it, "ended", "", 0) }
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
	 * cleanly, amber while a poll-failure streak is building, red when offline. */
	enum class Health { ONLINE, DEGRADED, OFFLINE }

	val health: Health
		get() = when {
			connected && pollFailStreak == 0 -> Health.ONLINE
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

	/** The user's friendly name for a team, falling back to its (possibly random) id. */
	fun label(team: String): String = labels[team] ?: team
}

/**
 * Chat state over a PhoneClient. Holds per-team threads, an unread tally, the open
 * tab set, and a poll loop that drains the device mailbox, dedupes by mailbox seq,
 * and routes each reply to its team (parsed from the `conv:<id>:<team>` session id
 * or the entry's `from`). Transcripts persist (encrypted) so history survives
 * restarts; the durable host-side ledger is a later phase.
 */
class ChatRepository(
	private val store: ProvisioningStore,
	private val filesDir: File,
	private val contentResolver: ContentResolver,
	// STTS provider catalog, parsed + validated once from the bundled asset by
	// Repo.get. Empty only if the asset is missing/corrupt (Play stays dark).
	private val sttsCatalog: List<com.atelier_nyaarium.switchboard.proto.SttsProvider> = emptyList(),
) {
	private val _state = MutableStateFlow(
		ChatState(
			provisioned = store.load() != null,
			threads = loadPersistedThreads(),
			biometricLock = store.biometricLock,
			deviceName = currentDeviceName(),
			labels = loadPersistedLabels(),
		),
	)
	val state: StateFlow<ChatState> = _state

	// Lazy clients are read and invalidated across threads (poll loop, main,
	// the player's daemon thread); @Volatile gives the writes visibility. A
	// rare double-construct race is harmless (last writer wins, cheap build).
	@Volatile private var client: PhoneClient? = null
	private var cursor = 0L
	private var epoch = 0L
	private var lastSeq = -1L
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
		_state.update { it.copy(error = null, pollFailStreak = 0) }
		forceTeamsRefresh = true
		kick.trySend(Unit)
	}

	fun onBackground() {
		visible = false
	}

	private fun client(): PhoneClient {
		client?.let { return it }
		val blob = store.load() ?: error("not provisioned")
		return PhoneClient(Provisioning.parse(blob)).also { client = it }
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
		client = null
		sttsClient = null
		_state.update { it.copy(provisioned = true, error = null, deviceName = prov.device) }
	}

	suspend fun connect() = withContext(Dispatchers.IO) {
		try {
			val reg = client().register()
			cursor = reg.cursor
			epoch = reg.epoch
			val teams = client().teams()
			_state.update {
				it.copy(
					teams = teams,
					status = "connected",
					error = null,
					connected = true,
					pollFailStreak = 0,
				)
			}
		} catch (e: Exception) {
			_state.update { it.copy(status = "error", error = e.message, connected = false) }
		}
	}

	suspend fun refreshTeams() = withContext(Dispatchers.IO) {
		runCatching { client().teams() }.onSuccess { t -> _state.update { it.copy(teams = t) } }
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
			fail(e.message)
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
						runCatching { client().teams() }.onSuccess { t ->
							_state.update { it.copy(teams = t) }
						}
					}
					// Visible: long-poll (the hold IS the wait; re-poll immediately).
					// AFK: plain poll, then sleep an interval; the mailbox batches.
					hold = if (visible) LONG_POLL_HOLD_MS else 0L
					val started = System.currentTimeMillis()
					val mb = client().poll(cursor, epoch, hold)
					// An old arbiter ignores holdMs and returns empty instantly; floor
					// the cadence so that degradation never becomes a tight spin.
					heldEmpty = hold > 0 && mb.entries.isEmpty() &&
						System.currentTimeMillis() - started < 3_000
					if (mb.epoch != epoch) {
						epoch = mb.epoch
						cursor = 0
						lastSeq = -1
					}
					if (mb.dropped > 0) _state.update { it.copy(gap = true) }
					val burst = mutableMapOf<String, MutableList<Message>>()
					for (e in mb.entries) {
						if (e.seq <= lastSeq) continue // dedupe a re-drain after a lost ack
						lastSeq = e.seq
						// Broadcast notices thread under the SENDER: their session id is
						// the pinned "notice:<from>" grammar, not a conversation.
						val team = if (e.kind == "notice") {
							e.from ?: e.session_id.removePrefix(NOTICE_SESSION_PREFIX).takeIf { it.isNotEmpty() } ?: continue
						} else {
							teamFromSession(e.session_id) ?: e.from ?: continue
						}
						val files = Attachments.decode(filesDir, mb.epoch, e.seq, e.files)
						// status-only entries still land (e.g. a wake-failure error
						// with no body would otherwise vanish).
						val bodyText = e.body.orEmpty()
						if (bodyText.isNotEmpty() || files.isNotEmpty() || e.status != null) {
							val msg =
								Message(false, bodyText, e.at, files = files, status = e.status, title = e.title, summary = e.summary)
							appendInbound(team, msg)
							bumpUnread(team)
							burst.getOrPut(team) { mutableListOf() }.add(msg)
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
					cursor = mb.cursor
					pollFails = 0
					if (_state.value.error != null || _state.value.pollFailStreak != 0) {
						_state.update { it.copy(error = null, pollFailStreak = 0, connected = true) }
					}
				} catch (e: Exception) {
					if (hold > 0 && e.message?.startsWith("HTTP 504") == true) {
						// A relay-timeout during a hold is an empty long-poll, not an
						// outage: an evie still on the shorter hold (upgrade window) or
						// a transient arbiter drop mid-hold. Back off, do not alarm.
						heldEmpty = true
					} else {
						// One blip is silent; the loop retries every cycle. Surface only
						// after a couple of consecutive failures, cleared on next success.
						failed = true
						pollFails++
						_state.update { it.copy(pollFailStreak = pollFails) }
						if (pollFails >= 2) {
							val msg =
								if (e is java.net.UnknownHostException) "Offline. Retrying..." else "Connection issue, retrying..."
							_state.update { it.copy(error = msg) }
						}
					}
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
		cursor = 0L
		epoch = 0L
		lastSeq = -1L
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
	private fun appendInbound(team: String, msg: Message) {
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
	}

	private fun bumpUnread(team: String) {
		_state.update { s -> s.copy(unread = s.unread + (team to (s.unread[team] ?: 0) + 1)) }
	}

	private fun teamFromSession(sessionId: String): String? =
		sessionId.substringAfterLast(':').takeIf { it.isNotEmpty() && it != sessionId }

	private fun persistThreads(threads: Map<String, List<Message>>) {
		val root = JSONObject()
		for ((team, msgs) in threads) {
			val arr = JSONArray()
			for (m in msgs) {
				val obj = JSONObject().put("me", m.fromMe).put("text", m.text).put("at", m.at)
				obj.putOpt("status", m.status)
				obj.putOpt("opId", m.opId)
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
			buildMap {
				for (team in root.keys()) {
					val arr = root.getJSONArray(team)
					// id is not persisted; reassign from list order so it stays a dense,
					// stable per-thread key whether the JSON is old (no id) or new.
					val loaded = (0 until arr.length()).map {
						val m = arr.getJSONObject(it)
						Message(
							m.optBoolean("me"),
							m.optString("text"),
							m.optLong("at"),
							it.toLong(),
							loadFiles(m),
							m.optString("status").takeIf { s -> s.isNotEmpty() },
							m.optString("opId").takeIf { s -> s.isNotEmpty() },
							title = m.optString("title").takeIf { s -> s.isNotEmpty() },
							summary = m.optString("summary").takeIf { s -> s.isNotEmpty() },
						)
					}
					// A "waking" placeholder has no resolution coming after a process
					// death; drop it. "pending" echoes WITH an opId are kept for the
					// service's idempotent reconcile; legacy ones without an opId
					// cannot be re-sent safely, so they demote to retriable here (and
					// never strand a forever-working chip if the service fails early).
					put(
						team,
						loaded
							.filterNot { !it.fromMe && it.status == "waking" }
							.map {
								if (it.fromMe && it.status == "pending" && it.opId == null) it.copy(status = "error") else it
							},
					)
				}
			}
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
			buildMap { for (team in root.keys()) put(team, root.getString(team)) }
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
		// Mirrors NOTICE_SESSION_PREFIX in src/shared/phone-protocol.ts, the single
		// source of truth for the broadcast-notice session-id grammar.
		const val NOTICE_SESSION_PREFIX = "notice:"
	}
}
