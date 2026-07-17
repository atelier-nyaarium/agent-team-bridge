package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.CancellationException

/** Rethrows this Throwable if it is a coroutine [CancellationException], otherwise does nothing.
 * JVM CancellationException extends Exception, so a bare `catch (e: Exception)` or `runCatching`
 * intercepts a coroutine cancellation unless told not to - the discipline every suspend-wrapping
 * catch site in this app applies, named once instead of hand-copied per call site. */
fun Throwable.rethrowIfCancellation() {
	if (this is CancellationException) throw this
}

/** [Result.onFailure] that rethrows a captured cancellation instead of leaving it wrapped in the
 * Result, so a coroutine cancellation stays a cancellation all the way up the call chain instead
 * of being read back as an ordinary failure. */
fun <T> Result<T>.rethrowCancellation(): Result<T> = onFailure { it.rethrowIfCancellation() }

/** [runCatching] that never captures a coroutine cancellation - the safe default whenever [block]
 * may suspend. A bare `runCatching` around a suspend call is a well-known Kotlin footgun (it
 * catches Throwable, cancellation included), silently turning "this coroutine was cancelled" into
 * an ordinary failure Result. */
inline fun <T> runCatchingCancellable(block: () -> T): Result<T> = runCatching(block).rethrowCancellation()
