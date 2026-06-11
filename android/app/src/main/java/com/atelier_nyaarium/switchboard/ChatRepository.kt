package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** `id` is a per-thread, local-only row key for the WebView DOM (lets the renderer
 * replace a row in place). It is NOT the mailbox seq; poll dedupe stays lastSeq-based.
 * Stamped on append; reassigned from list order on load so old transcripts still work. */
data class Message(val fromMe: Boolean, val text: String, val at: Long, val id: Long = 0)

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
) {
	/** Sessions shows live teams plus any team we already have a thread with (agent-initiated). */
	val sessions: List<Team>
		get() {
			val known = teams.associateBy { it.name }
			val extra = threads.keys.filter { it !in known }.map { Team(it, "offline", "channel", 0) }
			return teams + extra
		}

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
class ChatRepository(private val store: ProvisioningStore) {
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
		_state.value = _state.value.copy(provisioned = true, error = null, deviceName = prov.device)
	}

	suspend fun connect() = withContext(Dispatchers.IO) {
		try {
			val reg = client().register()
			cursor = reg.cursor
			epoch = reg.epoch
			_state.value = _state.value.copy(teams = client().teams(), status = "connected", error = null)
		} catch (e: Exception) {
			_state.value = _state.value.copy(status = "error", error = e.message)
		}
	}

	suspend fun refreshTeams() = withContext(Dispatchers.IO) {
		runCatching { client().teams() }.onSuccess { _state.value = _state.value.copy(teams = it) }
	}

	suspend fun send(team: String, text: String) = withContext(Dispatchers.IO) {
		append(team, Message(true, text, System.currentTimeMillis()))
		try {
			val r = client().send(team, text)
			when {
				!r.ok -> _state.value = _state.value.copy(error = r.error ?: "send failed")
				r.inlineBody != null -> append(team, Message(false, r.inlineBody, System.currentTimeMillis()))
			}
		} catch (e: Exception) {
			_state.value = _state.value.copy(error = e.message)
		}
	}

	fun startPolling(scope: CoroutineScope) {
		if (pollJob?.isActive == true) return
		pollJob = scope.launch(Dispatchers.IO) {
			while (isActive) {
				try {
					val mb = client().poll(cursor, epoch)
					if (mb.epoch != epoch) {
						epoch = mb.epoch
						cursor = 0
						lastSeq = -1
					}
					if (mb.dropped > 0) _state.value = _state.value.copy(gap = true)
					for (e in mb.entries) {
						if (e.seq <= lastSeq) continue // dedupe a re-drain after a lost ack
						lastSeq = e.seq
						val team = teamFromSession(e.sessionId) ?: e.from ?: continue
						if (e.body.isNotEmpty()) {
							append(team, Message(false, e.body, e.at))
							bumpUnread(team)
						}
					}
					cursor = mb.cursor
					pollFails = 0
					if (_state.value.error != null) _state.value = _state.value.copy(error = null)
				} catch (e: Exception) {
					// One blip is silent; the loop retries every cycle. Surface only after a
					// couple of consecutive failures, and clear it on the next success above.
					pollFails++
					if (pollFails >= 2) {
						val msg =
							if (e is java.net.UnknownHostException) "Offline. Retrying..." else "Connection issue, retrying..."
						_state.value = _state.value.copy(error = msg)
					}
				}
				delay(POLL_INTERVAL_MS)
			}
		}
	}

	fun openThread(team: String) {
		val s = _state.value
		_state.value = s.copy(
			unread = s.unread - team,
			openTabs = if (team in s.openTabs) s.openTabs else s.openTabs + team,
		)
	}

	fun closeTab(team: String) {
		_state.value = _state.value.copy(openTabs = _state.value.openTabs - team)
	}

	/** Give a team a local display label (or clear it with a blank name). */
	fun setLabel(team: String, name: String) {
		val s = _state.value
		val labels = if (name.isBlank()) s.labels - team else s.labels + (team to name.trim())
		_state.value = s.copy(labels = labels)
		persistLabels(labels)
	}

	/** Drop a peer from this device: its thread, unread, tab, and label. */
	fun forget(team: String) {
		val s = _state.value
		val threads = s.threads - team
		val labels = s.labels - team
		_state.value = s.copy(
			threads = threads,
			labels = labels,
			unread = s.unread - team,
			openTabs = s.openTabs - team,
		)
		persistThreads(threads)
		persistLabels(labels)
	}

	fun setBiometricLock(enabled: Boolean) {
		store.biometricLock = enabled
		_state.value = _state.value.copy(biometricLock = enabled)
	}

	suspend fun setDeviceName(name: String) = withContext(Dispatchers.IO) {
		val blob = store.load() ?: return@withContext
		val j = JSONObject(blob).put("device", name)
		store.save(j.toString())
		client = null
		_state.value = _state.value.copy(deviceName = name)
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
		val s = _state.value
		val existing = s.threads[team].orEmpty()
		val nextId = (existing.maxOfOrNull { it.id } ?: -1L) + 1
		val thread = existing + msg.copy(id = nextId)
		val threads = s.threads + (team to thread)
		_state.value = s.copy(threads = threads)
		persistThreads(threads)
	}

	private fun bumpUnread(team: String) {
		val s = _state.value
		_state.value = s.copy(unread = s.unread + (team to (s.unread[team] ?: 0) + 1))
	}

	private fun teamFromSession(sessionId: String): String? =
		sessionId.substringAfterLast(':').takeIf { it.isNotEmpty() && it != sessionId }

	private fun persistThreads(threads: Map<String, List<Message>>) {
		val root = JSONObject()
		for ((team, msgs) in threads) {
			val arr = JSONArray()
			for (m in msgs) {
				arr.put(JSONObject().put("me", m.fromMe).put("text", m.text).put("at", m.at))
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
						Message(m.optBoolean("me"), m.optString("text"), m.optLong("at"), it.toLong())
					})
				}
			}
		}.getOrDefault(emptyMap())
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
	}
}
