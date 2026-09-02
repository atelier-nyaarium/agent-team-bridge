package com.atelier_nyaarium.switchboard

/** Which transport is carrying owner rows right now. */
internal enum class ConsoleLink { SOCKET, POLL }

/** What a welcome did to the local cursor. */
internal sealed interface ConsoleAdoption {
	/** Not the current generation, or the socket is already gone. */
	data object Stale : ConsoleAdoption

	/** Adopted. [dropped] rows were swept before this consumer reached them. */
	data class Adopted(val cursor: Long, val cursorEpoch: Long, val dropped: Long) : ConsoleAdoption
}

/** Fallback wake for parked polls. */
internal const val SOCKET_PARK_MS = 5 * 60_000L

/**
 * One Router consumer across two transports.
 *
 * The Router keeps one cursor per console signing key, so the socket and the poll are the same
 * consumer. Only one may drain at a time, or both advance that cursor and each loses the rows the
 * other took. Sole caller of [IdlePushbackManager.decide], so alarms and wakelocks have one origin.
 */
internal class ConsoleTransportCoordinator(
	private val pushback: IdlePushbackManager,
	private val now: () -> Long = System::currentTimeMillis,
) {
	private val lock = Any()
	private var generation = 0L
	private var live: Long? = null
	private var link = ConsoleLink.POLL
	private var cursor = 0L
	private var cursorEpoch = 0L

	/** Rows swept before adoption, pending UI acknowledgement. */
	@Volatile var dropped = 0L
		private set

	fun link(): ConsoleLink = synchronized(lock) { link }

	fun cursor(): Long = synchronized(lock) { cursor }

	/** Mints a generation; older attempts are ignored. */
	fun beginSocket(): Long = synchronized(lock) {
		generation += 1
		live = generation
		generation
	}

	fun onWelcome(gen: Long, cursor: Long, cursorEpoch: Long, floor: Long): ConsoleAdoption =
		synchronized(lock) {
			if (gen != live) return ConsoleAdoption.Stale
			// The Router reads from cursor + 1, so a floor above that means the rows between are gone.
			val lost = (floor - (cursor + 1)).coerceAtLeast(0)
			this.cursor = cursor
			this.cursorEpoch = cursorEpoch
			dropped += lost
			link = ConsoleLink.SOCKET
			ConsoleAdoption.Adopted(cursor, cursorEpoch, lost)
		}

	/** True only for the live socket generation. */
	fun owns(gen: Long): Boolean = synchronized(lock) { gen == live && link == ConsoleLink.SOCKET }

	/** Advances after durable commit so failed drains replay above the cursor. */
	fun acked(gen: Long, cursor: Long): Boolean = synchronized(lock) {
		if (gen != live) return false
		if (cursor <= this.cursor) return false
		this.cursor = cursor
		true
	}

	fun onSocketClosed(gen: Long) {
		synchronized(lock) {
			if (gen != live) return
			live = null
			link = ConsoleLink.POLL
		}
	}

	/** Backgrounding hands the drain back to the poll. */
	fun onVisibility(visible: Boolean) {
		if (!visible) synchronized(lock) {
			live = null
			link = ConsoleLink.POLL
		}
	}

	/** Records socket traffic as comms activity. */
	fun onActivity(visible: Boolean) = pushback.onCommsActivity(now(), visible)

	fun clearDropped() {
		synchronized(lock) { dropped = 0 }
	}

	/** Parks the poll while the socket owns the drain. Runs decide either way, so the scheduler still
	 * sees every pass. */
	fun nextWait(visible: Boolean, lastPassFailed: Boolean, watchedWorking: Boolean): PollWait {
		val wait = pushback.decide(now(), visible, lastPassFailed, watchedWorking)
		return if (link() == ConsoleLink.SOCKET) PollWait.Delay(SOCKET_PARK_MS) else wait
	}

	/** False while the socket owns the drain. */
	fun mayPoll(): Boolean = link() == ConsoleLink.POLL
}
