package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.coroutineContext

/** One drain at a time; the holder may re-enter. */
internal class DrainGate {
	private val mutex = Mutex()

	private class Holder(val gate: DrainGate) : CoroutineContext.Element {
		override val key: CoroutineContext.Key<*> get() = Holder

		companion object : CoroutineContext.Key<Holder>
	}

	internal suspend fun <T> withDrainMutex(block: suspend () -> T): T =
		if (coroutineContext[Holder]?.gate === this) block()
		else mutex.withLock { withContext(Holder(this)) { block() } }
}
