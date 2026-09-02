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
	private var migrationEpoch = 0L
	private var awaitingTranslation = false

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
			// A cursor from before the migration names rows by an old coordinate. Nothing is taken on
			// it until the translation is committed, so a kill in between replays to the same cursor
			// rather than acking rows nobody was handed.
			awaitingTranslation = migrationEpoch != 0L && cursorEpoch != migrationEpoch
			dropped += lost
			link = ConsoleLink.SOCKET
			ConsoleAdoption.Adopted(cursor, cursorEpoch, lost)
		}

	/** Zero until the Router says, which is every case outside a migration window. */
	fun setMigrationEpoch(epoch: Long) = synchronized(lock) {
		migrationEpoch = epoch
		if (epoch != 0L && cursorEpoch != epoch && link == ConsoleLink.SOCKET) awaitingTranslation = true
	}

	/** Whether rows may be taken and acked on the live generation. */
	fun mayConsume(gen: Long): Boolean = synchronized(lock) {
		gen == live && link == ConsoleLink.SOCKET && !awaitingTranslation
	}

	/** Lands the translated coordinate once the journal has it. Only then do rows flow. */
	fun commitTranslation(gen: Long, cursor: Long, epoch: Long): Boolean = synchronized(lock) {
		if (gen != live) return false
		this.cursor = cursor
		cursorEpoch = epoch
		awaitingTranslation = false
		true
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

	/**
	 * The poll's wait, and the one place the idle ladder is consulted.
	 *
	 * A live socket does NOT park the poll. The socket carries the ROUTER's owner inbox while the poll
	 * drains the GATEWAY's mailbox, and those are separate sources with their own cursors, so parking
	 * one on the other's account would drop the phone's messages. The arbitration below exists for the
	 * day a background transport reads the same Router inbox.
	 */
	fun nextWait(visible: Boolean, lastPassFailed: Boolean, watchedWorking: Boolean): PollWait =
		pushback.decide(now(), visible, lastPassFailed, watchedWorking)
}
