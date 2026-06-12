package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
	/** Wire reply state: "running" interim, "error", or null for a final answer.
	 * Parsed and persisted here; the renderer's status badge is wired in P3. */
	val status: String? = null,
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
	 * ends on our cleanly-sent message) or the agent's last word was an interim
	 * running status. An error-marked tail (failed send) is not "working". */
	fun working(team: String): Boolean {
		val last = threads[team]?.lastOrNull() ?: return false
		return (last.fromMe && last.status == null) || last.status == "running"
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
	fun snippet(team: String): String? = threads[team]?.lastOrNull()?.text
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

	private var client: PhoneClient? = null
	private var cursor = 0
	private var epoch = 0
	private var lastSeq = -1
	private var pollFails = 0
	private var pollJob: Job? = null

	private fun client(): PhoneClient {
		client?.let { return it }
		val blob = store.load() ?: error("not provisioned")
		return PhoneClient(Provisioning.parse(blob)).also { client = it }
	}

	suspend fun provision(blob: String) = withContext(Dispatchers.IO) {
		val prov = Provisioning.parse(blob) // throws on malformed input before we persist
		store.save(blob)
		client = null
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
		// thumbnails through the same asset-loader path as inbound files.
		val localFiles = Attachments.storeOutgoing(filesDir, "out-${System.currentTimeMillis()}", picked)
		append(team, Message(true, text, System.currentTimeMillis(), files = localFiles))
		try {
			val r = client().send(team, text, picked)
			when {
				!r.ok -> {
					_state.update { it.copy(error = r.error ?: "send failed") }
					markLastMessageError(team)
				}
				r.inlineBody != null -> append(team, Message(false, r.inlineBody, System.currentTimeMillis()))
			}
		} catch (e: Exception) {
			_state.update { s -> s.copy(error = e.message) }
			markLastMessageError(team)
		}
	}

	/** Stamp the just-echoed message as failed, so the thread tail stops reading
	 * as awaiting-reply (working chip) and P3 can badge it. The atomic update
	 * re-checks the tail on every retry, so a reply that raced in is never the
	 * one dropped and re-stamped. */
	private fun markLastMessageError(team: String) {
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team] ?: return@updateAndGet s
			val last = thread.lastOrNull()?.takeIf { it.fromMe && it.status == null } ?: return@updateAndGet s
			s.copy(threads = s.threads + (team to (thread.dropLast(1) + last.copy(status = "error"))))
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
		pollJob = scope.launch(Dispatchers.IO) {
			var tick = 0
			while (isActive) {
				try {
					// The board's live/available states would otherwise only change on
					// a manual Refresh; piggyback a team-list refresh on the poll loop.
					if (tick % TEAMS_REFRESH_TICKS == 0) {
						runCatching { client().teams() }.onSuccess { t ->
							_state.update { it.copy(teams = t) }
						}
					}
					tick++
					val mb = client().poll(cursor, epoch)
					if (mb.epoch != epoch) {
						epoch = mb.epoch
						cursor = 0
						lastSeq = -1
					}
					if (mb.dropped > 0) _state.update { it.copy(gap = true) }
					for (e in mb.entries) {
						if (e.seq <= lastSeq) continue // dedupe a re-drain after a lost ack
						lastSeq = e.seq
						val team = teamFromSession(e.sessionId) ?: e.from ?: continue
						val files = Attachments.decode(filesDir, mb.epoch, e.seq, e.files)
						if (e.body.isNotEmpty() || files.isNotEmpty()) {
							append(team, Message(false, e.body, e.at, files = files, status = e.status))
							bumpUnread(team)
						}
					}
					cursor = mb.cursor
					pollFails = 0
					if (_state.value.error != null || _state.value.pollFailStreak != 0) {
						_state.update { it.copy(error = null, pollFailStreak = 0, connected = true) }
					}
				} catch (e: Exception) {
					// One blip is silent; the loop retries every cycle. Surface only after a
					// couple of consecutive failures, and clear it on the next success above.
					pollFails++
					_state.update { it.copy(pollFailStreak = pollFails) }
					if (pollFails >= 2) {
						val msg =
							if (e is java.net.UnknownHostException) "Offline. Retrying..." else "Connection issue, retrying..."
						_state.update { it.copy(error = msg) }
					}
				}
				delay(POLL_INTERVAL_MS)
			}
		}
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

	/** Drop a peer from this device: its thread, unread, tab, and label. */
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
		cursor = 0
		epoch = 0
		lastSeq = -1
		_state.value = ChatState(provisioned = false)
	}

	private fun append(team: String, msg: Message) {
		val threads = _state.updateAndGet { s ->
			val existing = s.threads[team].orEmpty()
			val nextId = (existing.maxOfOrNull { it.id } ?: -1L) + 1
			s.copy(threads = s.threads + (team to (existing + msg.copy(id = nextId))))
		}.threads
		persistThreads(threads)
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
					put(team, (0 until arr.length()).map {
						val m = arr.getJSONObject(it)
						Message(
							m.optBoolean("me"),
							m.optString("text"),
							m.optLong("at"),
							it.toLong(),
							loadFiles(m),
							m.optString("status").takeIf { s -> s.isNotEmpty() },
						)
					})
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
		// Refresh the team list every Nth poll (~30s) so card states track reality.
		const val TEAMS_REFRESH_TICKS = 6
		const val MAX_OUTGOING_BYTES = 10_000_000
	}
}
