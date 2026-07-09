package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for SttsPlayer.volumeSteps, the pure pct -> (MediaPlayer linear gain,
 * LoudnessEnhancer millibels) mapping. Pure-JVM; MediaPlayer/LoudnessEnhancer themselves
 * can't run under unit tests, so this is the only directly testable piece of the volume feature.
 */
class SttsVolumeTest {
	@Test
	fun zeroIsSilent() {
		val (linear, gainMb) = SttsPlayer.volumeSteps(0)
		assertEquals(0f, linear)
		assertEquals(0, gainMb)
	}

	@Test
	fun defaultIsUnchanged() {
		val (linear, gainMb) = SttsPlayer.volumeSteps(100)
		assertEquals(1f, linear)
		assertEquals(0, gainMb)
	}

	@Test
	fun belowUnityIsPlainAttenuation() {
		val (linear, gainMb) = SttsPlayer.volumeSteps(50)
		assertEquals(0.5f, linear)
		assertEquals(0, gainMb)
	}

	@Test
	fun aboveUnityHoldsFullLinearAndAddsGain() {
		val (linear, gainMb) = SttsPlayer.volumeSteps(150)
		assertEquals(1f, linear)
		assertEquals(300, gainMb)
	}

	@Test
	fun ceilingIsTwoHundredPercent() {
		val (linear, gainMb) = SttsPlayer.volumeSteps(200)
		assertEquals(1f, linear)
		assertEquals(600, gainMb)
	}

	@Test
	fun clampsOutOfRangeInput() {
		val (belowLinear, belowGain) = SttsPlayer.volumeSteps(-50)
		assertEquals(0f, belowLinear)
		assertEquals(0, belowGain)

		val (aboveLinear, aboveGain) = SttsPlayer.volumeSteps(500)
		assertEquals(1f, aboveLinear)
		assertEquals(600, aboveGain)
	}
}
