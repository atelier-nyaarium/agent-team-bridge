package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
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
	private var incarnation = 0L
	private var migrationEpoch = 0L
	private var awaitingTranslation = false
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
			// A higher floor means intervening rows are gone.
			this.cursor = cursor
			this.cursorEpoch = cursorEpoch
			// Do not consume until coordinate translation commits.
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
		// Advance only after durable commit.
		this.cursor = cursor
		cursorEpoch = epoch
		awaitingTranslation = false
		true
	}

	fun adoptFloor(floor: Long) = synchronized(lock) {
		cursor = floor
	}

	fun owns(gen: Long): Boolean = synchronized(lock) { gen == live && link == ConsoleLink.SOCKET }

	suspend fun awaitOpResult(opId: String, timeoutMs: Long): JsonElement? {
		val waiter = synchronized(lock) { opResults.getOrPut(opId) { CompletableDeferred() } }
		return try {
			withTimeoutOrNull(timeoutMs) { waiter.await() }
		} finally {
			synchronized(lock) {
				if (opResults[opId] === waiter) opResults.remove(opId)
			}
		}
	}

	fun prepareOpResult(opId: String) {
		synchronized(lock) { opResults.getOrPut(opId) { CompletableDeferred() } }
	}

	fun discardOpResult(opId: String) {
		synchronized(lock) { opResults.remove(opId) }
	}

	fun completeOpResult(opId: String, result: JsonElement?): Boolean = synchronized(lock) {
		val waiter = opResults[opId] ?: return false
		waiter.complete(result)
		opResults.remove(opId)
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
