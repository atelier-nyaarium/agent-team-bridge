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

data class Message(val fromMe: Boolean, val text: String, val at: Long)

data class ChatState(
	val provisioned: Boolean = false,
	val teams: List<Team> = emptyList(),
	val threads: Map<String, List<Message>> = emptyMap(),
	val unread: Map<String, Int> = emptyMap(),
	val status: String = "",
	val error: String? = null,
)

/**
 * In-memory chat state over a PhoneClient. Holds per-team threads, an unread
 * tally, and a poll loop that drains the device mailbox and routes each reply to
 * its team (parsed from the `conv:<id>:<team>` session id). Durable storage is a
 * later phase; this keeps state for the life of the process.
 */
class ChatRepository(private val store: ProvisioningStore) {
	private val _state = MutableStateFlow(ChatState(provisioned = store.load() != null))
	val state: StateFlow<ChatState> = _state

	private var client: PhoneClient? = null
	private var cursor = 0
	private var epoch = 0
	private var pollJob: Job? = null

	private fun client(): PhoneClient {
		client?.let { return it }
		val blob = store.load() ?: error("not provisioned")
		return PhoneClient(Provisioning.parse(blob)).also { client = it }
	}

	suspend fun provision(blob: String) = withContext(Dispatchers.IO) {
		Provisioning.parse(blob) // throws on malformed input before we persist
		store.save(blob)
		client = null
		_state.value = _state.value.copy(provisioned = true, error = null)
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
					}
					for (e in mb.entries) {
						val team = teamFromSession(e.sessionId) ?: e.from ?: continue
						if (e.body.isNotEmpty()) {
							append(team, Message(false, e.body, e.at))
							bumpUnread(team)
						}
					}
					cursor = mb.cursor
				} catch (e: Exception) {
					_state.value = _state.value.copy(error = "poll: ${e.message}")
				}
				delay(POLL_INTERVAL_MS)
			}
		}
	}

	fun openThread(team: String) {
		_state.value = _state.value.copy(unread = _state.value.unread - team)
	}

	private fun append(team: String, msg: Message) {
		val s = _state.value
		val thread = (s.threads[team].orEmpty()) + msg
		_state.value = s.copy(threads = s.threads + (team to thread))
	}

	private fun bumpUnread(team: String) {
		val s = _state.value
		_state.value = s.copy(unread = s.unread + (team to (s.unread[team] ?: 0) + 1))
	}

	private fun teamFromSession(sessionId: String): String? =
		sessionId.substringAfterLast(':').takeIf { it.isNotEmpty() && it != sessionId }

	private companion object {
		const val POLL_INTERVAL_MS = 5_000L
	}
}
