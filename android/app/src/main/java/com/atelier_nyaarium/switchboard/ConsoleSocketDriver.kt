package com.atelier_nyaarium.switchboard

/** Routes socket frames by generation and acknowledges cursors after durable row handling. */
internal class ConsoleSocketDriver(
	private val coordinator: ConsoleTransportCoordinator,
	private val newClient: (ConsoleSocketListener) -> ConsoleSocketClient,
	private val onRows: (List<com.atelier_nyaarium.switchboard.proto.InboxRow>, Long) -> Unit,
	/** Payload is null for a plane that pokes rather than pushes; the reader re-reads on those. */
	private val onPlane: (String, Long, kotlinx.serialization.json.JsonElement?) -> Unit = { _, _, _ -> },
	private val onGap: (Long) -> Unit = {},
	private val kick: () -> Unit = {},
	/** Fires only for a socket that died before it was ever welcomed, the one signal meaning the
	 * address is wrong rather than the connection unlucky. */
	private val onUnreachable: () -> Unit = {},
) {
	private val lock = Any()

	/** Held with the generation that opened it, so a superseded socket's close cannot clear the one
	 * that replaced it. */
	private var client: Pair<Long, ConsoleSocketClient>? = null

	fun connect() {
		val gen = coordinator.beginSocket()
		val listener = Listener(gen)
		val opened = runCatching { newClient(listener) }.getOrNull()
		if (opened == null) {
			coordinator.onSocketClosed(gen)
			return
		}
		synchronized(lock) { client = gen to opened }
		runCatching { opened.open() }.onFailure {
			coordinator.onSocketClosed(gen)
			forget(gen)
			retire(opened)
			kick()
		}
	}

	/** Closes the socket after handing the drain back to polling. */
	fun onBackground() {
		coordinator.onVisibility(false)
		disconnect()
	}

	fun disconnect() {
		val open = synchronized(lock) { client.also { client = null } } ?: return
		retire(open.second)
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
			when (frame) {
				is ConsoleSocketFrame.Welcome -> {
					val v = frame.value
					val adopted = coordinator.onWelcome(gen, v.cursor, v.cursorEpoch, v.floor)
					if (adopted !is ConsoleAdoption.Adopted) return
					welcomed = true
					if (adopted.dropped > 0) onGap(adopted.dropped)
				}
				is ConsoleSocketFrame.InboxRows -> {
					if (!coordinator.owns(gen)) return
					val v = frame.value
					onRows(v.rows, v.cursor)
					if (coordinator.acked(gen, v.cursor)) socketOf()?.ack(v.cursor)
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
			kick()
		}

		private fun socketOf(): ConsoleSocketClient? = synchronized(lock) { client?.takeIf { it.first == gen }?.second }
	}
}
