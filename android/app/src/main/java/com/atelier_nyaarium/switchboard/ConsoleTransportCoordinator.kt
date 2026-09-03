package com.atelier_nyaarium.switchboard

internal enum class ConsoleLink { SOCKET, POLL }

internal sealed interface ConsoleAdoption {
	data object Stale : ConsoleAdoption

	data class Adopted(val cursor: Long, val cursorEpoch: Long, val dropped: Long) : ConsoleAdoption
}

internal data class ConsoleTransportPlan(
	val wait: PollWait,
	val reconnectSocket: Boolean,
	val pullDiscovery: Boolean,
)

/** One Router consumer across transports. */
// One cursor permits one drain at a time.
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

	@Volatile var dropped = 0L
		private set

	fun link(): ConsoleLink = synchronized(lock) { link }

	fun cursor(): Long = synchronized(lock) { cursor }

	fun beginSocket(): Long = synchronized(lock) {
		generation += 1
		live = generation
		generation
	}

	fun onWelcome(gen: Long, cursor: Long, cursorEpoch: Long, floor: Long): ConsoleAdoption =
		synchronized(lock) {
			if (gen != live) return ConsoleAdoption.Stale
			val lost = (floor - (cursor + 1)).coerceAtLeast(0)
			// A higher floor means intervening rows are gone.
			this.cursor = cursor
			this.cursorEpoch = cursorEpoch
			// Do not consume until coordinate translation commits.
			awaitingTranslation = migrationEpoch != 0L && cursorEpoch != migrationEpoch
			dropped += lost
			link = ConsoleLink.SOCKET
			ConsoleAdoption.Adopted(cursor, cursorEpoch, lost)
		}

	fun setMigrationEpoch(epoch: Long) = synchronized(lock) {
		migrationEpoch = epoch
		if (epoch != 0L && cursorEpoch != epoch && link == ConsoleLink.SOCKET) awaitingTranslation = true
	}

	fun mayConsume(gen: Long): Boolean = synchronized(lock) {
		gen == live && link == ConsoleLink.SOCKET && !awaitingTranslation
	}

	fun commitTranslation(gen: Long, cursor: Long, epoch: Long): Boolean = synchronized(lock) {
		if (gen != live) return false
		this.cursor = cursor
		cursorEpoch = epoch
		awaitingTranslation = false
		true
	}

	fun owns(gen: Long): Boolean = synchronized(lock) { gen == live && link == ConsoleLink.SOCKET }

	fun acked(gen: Long, cursor: Long): Boolean = synchronized(lock) {
		if (gen != live) return false
		if (cursor <= this.cursor) return false
		// Advance only after durable commit.
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

	fun onVisibility(visible: Boolean) {
		if (!visible) synchronized(lock) {
			live = null
			link = ConsoleLink.POLL
		}
	}

	fun onActivity(visible: Boolean) = pushback.onCommsActivity(now(), visible)

	fun plan(visible: Boolean, linkUp: Boolean, lastPassFailed: Boolean): ConsoleTransportPlan =
		ConsoleTransportPlan(
			wait = nextWait(visible, lastPassFailed, false),
			reconnectSocket = visible && !linkUp,
			pullDiscovery = !linkUp,
		)

	fun clearDropped() {
		synchronized(lock) { dropped = 0 }
	}

	/** Router and Gateway inboxes have separate cursors. */
	fun nextWait(visible: Boolean, lastPassFailed: Boolean, watchedWorking: Boolean): PollWait =
		pushback.decide(now(), visible, lastPassFailed, watchedWorking)
}
