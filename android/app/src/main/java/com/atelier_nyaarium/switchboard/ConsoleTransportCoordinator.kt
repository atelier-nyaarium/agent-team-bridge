package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonElement

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

internal data class PendingInboxAdvance(val cursor: Long, val cursorEpoch: Long)

/** One Router consumer across transports. */
// One cursor gates draining.
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
	private var incarnation = 0L
	private var migrationEpoch = 0L
	private var awaitingTranslation = false
	private var pendingAdvance: PendingInboxAdvance? = null
	private val opResults = mutableMapOf<String, CompletableDeferred<JsonElement?>>()

	@Volatile var dropped = 0L
		private set

	fun link(): ConsoleLink = synchronized(lock) { link }

	fun cursor(): Long = synchronized(lock) { cursor }

	fun cursorEpoch(): Long = synchronized(lock) { cursorEpoch }

	fun migrationEpoch(): Long = synchronized(lock) { migrationEpoch }

	fun incarnation(): Long = synchronized(lock) { incarnation }

	fun awaitingTranslation(): Boolean = synchronized(lock) { awaitingTranslation }

	fun beginSocket(): Long = synchronized(lock) {
		generation += 1
		live = generation
		generation
	}

	fun onWelcome(
		gen: Long,
		cursor: Long,
		cursorEpoch: Long,
		floor: Long,
		migrationEpoch: Long? = null,
		incarnation: Long? = null,
	): ConsoleAdoption =
		synchronized(lock) {
			if (gen != live) return ConsoleAdoption.Stale
			if (incarnation != null) this.incarnation = incarnation
			if (migrationEpoch != null) {
				if (migrationEpoch == 0L) awaitingTranslation = false
				else this.migrationEpoch = migrationEpoch
			}
			val lost = (floor - (cursor + 1)).coerceAtLeast(0)
			// Skip compacted rows.
			this.cursor = cursor
			this.cursorEpoch = cursorEpoch
			// Wait for translation.
			if (migrationEpoch == null) awaitingTranslation = this.migrationEpoch != 0L && cursorEpoch != this.migrationEpoch
			else if (migrationEpoch != 0L) awaitingTranslation = cursorEpoch != migrationEpoch
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

	fun mayPoll(): Boolean = synchronized(lock) { link == ConsoleLink.POLL && !awaitingTranslation }

	fun polled(cursor: Long, epoch: Long): Boolean = synchronized(lock) {
		if (link != ConsoleLink.POLL || awaitingTranslation) return false
		if (cursor <= this.cursor && epoch == cursorEpoch) return false
		this.cursor = cursor
		cursorEpoch = epoch
		true
	}

	fun commitTranslation(gen: Long, cursor: Long, epoch: Long): Boolean = synchronized(lock) {
		if (gen != live) return false
		// Advance after commit.
		this.cursor = cursor
		cursorEpoch = epoch
		awaitingTranslation = false
		true
	}

	fun adoptFloor(floor: Long) = synchronized(lock) {
		cursor = (floor - 1).coerceAtLeast(0)
	}

	fun owns(gen: Long): Boolean = synchronized(lock) { gen == live && link == ConsoleLink.SOCKET }

	fun pendingAdvance(): PendingInboxAdvance? = synchronized(lock) { pendingAdvance }

	fun recordPendingAdvance(cursor: Long, cursorEpoch: Long) = synchronized(lock) {
		pendingAdvance = PendingInboxAdvance(cursor, cursorEpoch)
	}

	fun clearPendingAdvance() = synchronized(lock) {
		pendingAdvance = null
	}

	fun prepareOpResult(opId: String): CompletableDeferred<JsonElement?> {
		return synchronized(lock) { opResults.getOrPut(opId) { CompletableDeferred() } }
	}

	fun discardOpResult(opId: String) {
		synchronized(lock) { opResults.remove(opId) }
	}

	fun completeOpResult(opId: String, result: JsonElement?): Boolean = synchronized(lock) {
		val waiter = opResults[opId] ?: return false
		waiter.complete(result)
		true
	}

	fun acked(gen: Long, cursor: Long): Boolean = synchronized(lock) {
		if (gen != live) return false
		if (awaitingTranslation) return false
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
