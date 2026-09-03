package com.atelier_nyaarium.switchboard

/** Generation-routed frames and durable acknowledgements. */
internal class ConsoleSocketDriver(
	private val coordinator: ConsoleTransportCoordinator,
	private val newClient: (ConsoleSocketListener) -> ConsoleSocketClient,
	private val onRows: (List<com.atelier_nyaarium.switchboard.proto.InboxRow>, Long) -> Unit,
	/** Null payload means re-read. */
	private val onPlane: (String, Long, kotlinx.serialization.json.JsonElement?) -> Unit = { _, _, _ -> },
	private val onGap: (Long) -> Unit = {},
	private val kick: () -> Unit = {},
	/** Fires for pre-welcome connection failure. */
	private val onUnreachable: () -> Unit = {},
	private val visible: () -> Boolean = { true },
	private val reconnect: (Long) -> Unit = {},
	private val onWelcome: (Long, com.atelier_nyaarium.switchboard.proto.ConsoleWelcomeFrame) -> Unit = { _, _ -> },
) {
	private val lock = Any()

	/** Generation fence prevents stale clears. */
	private var client: Pair<Long, ConsoleSocketClient>? = null
	private var closeStreak = 0
	private var reconnectPending = false

	fun connect() {
		reconnectPending = false
		val gen = coordinator.beginSocket()
		val listener = Listener(gen)
		val opened = runCatching { newClient(listener) }.getOrNull()
		if (opened == null) {
			coordinator.onSocketClosed(gen)
			scheduleReconnect()
			kick()
			return
		}
		synchronized(lock) { client = gen to opened }
		runCatching { opened.open() }.onFailure {
			coordinator.onSocketClosed(gen)
			forget(gen)
			retire(opened)
			scheduleReconnect()
			kick()
		}
	}

	/** Returns draining to polling. */
	fun onBackground() {
		coordinator.onVisibility(false)
		disconnect()
	}

	fun disconnect() {
		val open = synchronized(lock) { client.also { client = null } } ?: return
		retire(open.second)
	}

	internal fun commitTranslation(gen: Long, cursor: Long, epoch: Long): Boolean {
		if (!coordinator.commitTranslation(gen, cursor, epoch)) return false
		val open = synchronized(lock) { client?.takeIf { it.first == gen }?.second } ?: return true
		open.setCursorEpoch(epoch)
		open.ack(cursor)
		return true
	}

	private fun forget(gen: Long) {
		synchronized(lock) { if (client?.first == gen) client = null }
	}

	private fun retire(open: ConsoleSocketClient) {
		runCatching { open.close() }
	}

	private inner class Listener(private val gen: Long) : ConsoleSocketListener {
		@Volatile private var welcomed = false

		override fun onFrame(frame: ConsoleSocketFrame) {
			// Stale generations cannot consume, apply, or acknowledge.
			coordinator.onActivity(visible())
			when (frame) {
				is ConsoleSocketFrame.Welcome -> {
					val v = frame.value
					val consumer = socketOf()?.socketMode == ConsoleSocketMode.INBOX
					val adopted = coordinator.onWelcome(gen, v.cursor, v.cursorEpoch, v.floor, if (consumer) v.migrationEpoch else 0L)
					if (adopted !is ConsoleAdoption.Adopted) return
						welcomed = true
						closeStreak = 0
					onWelcome(gen, v)
					if (adopted.dropped > 0) onGap(adopted.dropped)
				}
					is ConsoleSocketFrame.InboxRows -> {
						val v = frame.value
						if (coordinator.owns(gen) && socketOf()?.socketMode == ConsoleSocketMode.PLANES && v.rows.isNotEmpty() && v.rows.all { it.envelope.kind in KEY_ROW_KINDS }) {
							onRows(v.rows, v.cursor)
							return
						}
						if (coordinator.owns(gen) && socketOf()?.socketMode == ConsoleSocketMode.PLANES) return
					if (!coordinator.mayConsume(gen)) return
					onRows(v.rows, v.cursor)
					if (coordinator.acked(gen, v.cursor)) {
						socketOf()?.setCursorEpoch(coordinator.cursorEpoch())
						socketOf()?.ack(v.cursor)
					}
				}
				is ConsoleSocketFrame.Plane -> {
					if (!coordinator.owns(gen)) return
					onPlane(frame.value.name, frame.value.version, frame.value.payload)
				}
				is ConsoleSocketFrame.Refused -> onClosed(null, frame.value.reason, null)
				is ConsoleSocketFrame.Pong -> Unit
			}
		}

		override fun onClosed(code: Int?, reason: String?, cause: Throwable?) {
			coordinator.onSocketClosed(gen)
			forget(gen)
			if (cause != null && !welcomed) onUnreachable()
			if (visible()) {
				scheduleReconnect()
			}
			kick()
		}

		private fun socketOf(): ConsoleSocketClient? = synchronized(lock) { client?.takeIf { it.first == gen }?.second }
	}

	private fun scheduleReconnect() {
		if (!visible() || reconnectPending) return
		val delay = (1L shl closeStreak.coerceAtMost(5)) * 1_000L
		closeStreak++
		reconnectPending = true
		reconnect(delay)
	}

	private companion object {
		val KEY_ROW_KINDS = setOf("key_request", "key_grant")
	}
}
