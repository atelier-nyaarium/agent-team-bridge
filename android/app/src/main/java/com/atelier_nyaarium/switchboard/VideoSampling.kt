package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Functions & Helpers

/**
 * Which moments of a video the thumbnail samples.
 *
 * Pure arithmetic, kept apart from the retriever so the rule can be exercised without a decoder. It
 * has to be: two unrelated mistakes here both present as "the thumbnail is static" rather than as
 * anything that looks like a failure, so nothing about a wrong result draws attention to itself.
 */
object VideoSampling {
	/** Ceiling on sample points, so a feature-length file costs the same as a one-minute one. */
	const val MAX_POINTS = 12

	/** Spacing floor. A taste call, and the one number here most likely to want tuning: 1s samples a
	 * short clip far more densely. */
	const val MIN_SPACING_MS = 5_000L

	/**
	 * Fewest points that can produce MOTION.
	 *
	 * Dropping the first and last leaves n-2, so n must reach 4 before a second frame exists. At 3 the
	 * rule yields a single frame, which is a static thumb arrived at the expensive way, so the cutoff
	 * sits here rather than at 3 where the arithmetic quietly disagrees with the intent.
	 */
	const val MIN_MOTION_POINTS = 4

	/**
	 * The offsets to grab, in MILLISECONDS, or empty when the clip is too short to animate and the
	 * caller should take a single midpoint frame instead.
	 *
	 * Evenly spaced with the first and last dropped: frame zero is often a black or title frame, and
	 * the final offset can land past the last decodable sample.
	 */
	fun pointsMs(durationMs: Long): List<Long> {
		if (durationMs <= 0) return emptyList()
		val n = minOf(durationMs / MIN_SPACING_MS, MAX_POINTS.toLong()).toInt()
		if (n < MIN_MOTION_POINTS) return emptyList()
		val spacing = durationMs / n
		return (1..n - 2).map { it * spacing }
	}

	/** The offset for a clip with nothing to animate. */
	fun midpointMs(durationMs: Long): Long = if (durationMs > 0) durationMs / 2 else 0L

	/**
	 * MILLISECONDS to MICROSECONDS.
	 *
	 * Its own function because the two units meet exactly once: duration metadata reports ms and the
	 * retriever's seek takes us. Passing ms straight through asks for a moment a thousand times too
	 * early, so every sample resolves to the opening frame and the thumb is silently static.
	 */
	fun msToUs(ms: Long): Long = ms * 1_000L
}
