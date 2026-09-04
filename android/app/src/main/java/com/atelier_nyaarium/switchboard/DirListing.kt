package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/**
 * One directory's subdirectories, or why there are none.
 *
 * A failure and a genuinely empty folder are NOT the same answer. They were the same value once, and
 * a Gateway that was simply switched off rendered as a picker with no suggestions, which reads as a
 * broken feature rather than an unreachable machine. Every caller that shows a listing shows this
 * reason too.
 */
data class DirListing(val dirs: List<String>, val error: String? = null, val path: String? = null)

////////////////////////////////
//  Functions & Helpers

/**
 * What the picker says about a failed listing, from the thrown cause.
 *
 * The wire strings are matched on rather than a code, because the failures worth telling apart come
 * from three different layers (the Router's routing refusal, the receiving Gateway's missing daemon,
 * that Gateway's own filesystem answer) and none of them shares an error vocabulary. An unmatched
 * cause keeps its own message: a wrong guess would be worse than a raw one, since this string is the
 * only thing standing between a person and a silent failure.
 */
internal fun dirListError(cause: Throwable): String {
	val raw = cause.message.orEmpty()
	// Most specific first. "terminal view unavailable on this Gateway" also contains "unavailable", so a
	// broad offline test placed above it reports a reachable machine with no daemon as switched off.
	return when {
		raw.contains("terminal view", ignoreCase = true) -> "No host daemon on that machine."
		raw.contains("not connected", ignoreCase = true) || raw.contains("gateway unavailable", ignoreCase = true) ->
			"That machine is offline."
		raw.contains("unseal failed", ignoreCase = true) -> "Couldn't reach that machine."
		raw.isBlank() -> "Couldn't read that folder."
		else -> raw.take(120)
	}
}
