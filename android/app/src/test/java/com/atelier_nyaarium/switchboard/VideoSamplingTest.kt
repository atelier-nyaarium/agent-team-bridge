package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The video thumbnail's sampling rule.
 *
 * Worth its own corpus because both ways of getting this wrong look identical from the outside: a
 * thumbnail that does not move reads as a design choice, not as a bug.
 */
class VideoSamplingTest {
	private val second = 1_000L

	// ---- the plan's table, which is the corpus ----

	@Test
	fun aTwelveSecondClipIsTooShortToAnimate() {
		assertEquals(emptyList<Long>(), VideoSampling.pointsMs(12 * second))
	}

	@Test
	fun aFifteenSecondClipIsAlsoTooShort() {
		// Three points would leave exactly one frame after dropping the ends, which is a static thumb
		// reached the expensive way. The cutoff exists so that case never runs the seeks.
		assertEquals(emptyList<Long>(), VideoSampling.pointsMs(15 * second))
	}

	@Test
	fun aThirtySecondClipKeepsFourFramesFiveSecondsApart() {
		assertEquals(listOf(5_000L, 10_000L, 15_000L, 20_000L), VideoSampling.pointsMs(30 * second))
	}

	@Test
	fun aSixtySecondClipKeepsTenFramesFiveSecondsApart() {
		val points = VideoSampling.pointsMs(60 * second)

		assertEquals(10, points.size)
		assertEquals(5_000L, points.first())
		assertEquals(50_000L, points.last())
	}

	@Test
	fun aTenMinuteClipKeepsTenFramesSpreadAcrossTheWholeThing() {
		// The ceiling binds here, so spacing stretches instead of the count growing.
		val points = VideoSampling.pointsMs(10 * 60 * second)

		assertEquals(10, points.size)
		assertEquals(50_000L, points.first())
		assertEquals(500_000L, points.last())
	}

	// ---- properties that hold for any duration ----

	@Test
	fun neverMoreThanTheCeilingHoweverLongTheVideo() {
		for (minutes in listOf(1, 5, 30, 120, 600)) {
			val points = VideoSampling.pointsMs(minutes * 60 * second)
			assertTrue("$minutes min produced ${points.size}", points.size <= VideoSampling.MAX_POINTS)
		}
	}

	@Test
	fun everyOffsetLandsInsideTheVideoAndNeverOnItsEdges() {
		// The first frame is often black or a title card, and the last offset can sit past the final
		// decodable sample, so both ends are dropped rather than clamped.
		for (minutes in listOf(1, 3, 17, 90)) {
			val duration = minutes * 60 * second
			for (at in VideoSampling.pointsMs(duration)) {
				assertTrue("$at outside 0..$duration", at > 0 && at < duration)
			}
		}
	}

	@Test
	fun anythingThatDoesAnimateProducesMoreThanOneFrame() {
		// The point of the cutoff: a non-empty result is always genuinely moving.
		for (seconds in 1..600) {
			val points = VideoSampling.pointsMs(seconds * second)
			if (points.isNotEmpty()) assertTrue("$seconds s gave ${points.size}", points.size >= 2)
		}
	}

	@Test
	fun offsetsAreStrictlyIncreasingSoNoTwoFramesAreTheSameMoment() {
		val points = VideoSampling.pointsMs(90 * second)

		assertEquals(points.sorted(), points)
		assertEquals(points.distinct().size, points.size)
	}

	// ---- degenerate durations ----

	@Test
	fun aMissingOrNonsenseDurationAnimatesNothing() {
		assertEquals(emptyList<Long>(), VideoSampling.pointsMs(0))
		assertEquals(emptyList<Long>(), VideoSampling.pointsMs(-1))
		assertEquals(0L, VideoSampling.midpointMs(0))
	}

	@Test
	fun aShortClipStillHasAMidpointToFallBackOn() {
		assertEquals(6_000L, VideoSampling.midpointMs(12 * second))
	}

	// ---- the unit conversion, which is the other way to get a static thumb ----

	@Test
	fun secondsConvertToMicrosecondsNotMilliseconds() {
		// Duration metadata is milliseconds; the retriever's seek is microseconds. Passing ms through
		// would seek a thousand times too early and land every sample on the opening frame.
		assertEquals(5_000_000L, VideoSampling.msToUs(5_000L))
		assertEquals(0L, VideoSampling.msToUs(0L))
	}

	@Test
	fun aLongRecordingsOffsetStillFitsAfterConversion() {
		// Past about 36 minutes the microsecond offset leaves 32-bit range, and a screen recording
		// reaches that easily, so the whole path has to stay Long.
		val us = VideoSampling.msToUs(60 * 60 * second)

		assertEquals(3_600_000_000L, us)
		assertTrue("an Int would have wrapped here", us > Int.MAX_VALUE)
	}
}
