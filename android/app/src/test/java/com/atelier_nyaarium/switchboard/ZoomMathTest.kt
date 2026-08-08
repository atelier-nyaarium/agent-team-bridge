package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Behaviour tests for the fullscreen stage's zoom arithmetic. The assertions are written in terms of
 * what the user sees (one source pixel per screen pixel, an edge that cannot leave the frame) rather
 * than the intermediate layer scale, since the layer scale is the thing most likely to be wrong.
 */
class ZoomMathTest {
	/** Screen pixels per SOURCE pixel actually rendered at a given layer scale. The inverse of what
	 * scaleForRatio computes, so a round trip through both proves the formula rather than restating
	 * it. */
	private fun renderedRatio(bounds: ImageBounds, cw: Int, ch: Int, scale: Float): Float {
		val fit = ZoomMath.fitFactor(bounds, cw, ch)
		return fit * scale / bounds.sampleSize
	}

	// ---- true-pixel scale ----

	@Test
	fun oneHundredPercentIsOneSourcePixelPerScreenPixelForAnImageLargerThanTheFrame() {
		val bounds = ImageBounds(width = 4000, height = 3000, sampleSize = 1)
		val scale = ZoomMath.scaleForRatio(ZoomMath.PRESET_ACTUAL, bounds, 1440, 2400)

		assertEquals(1f, renderedRatio(bounds, 1440, 2400, scale), 0.0001f)
	}

	@Test
	fun oneHundredPercentShrinksASmallImageBackDownBecauseFitAlreadyMagnifiedIt() {
		// A 64px icon on a 1440px frame is blown up ~22x by ContentScale.Fit, so true 1:1 is a layer
		// scale far BELOW 1: the scale range must not floor at 1, or a small image could never be seen at
		// its own size.
		val bounds = ImageBounds(width = 64, height = 64, sampleSize = 1)
		val scale = ZoomMath.scaleForRatio(ZoomMath.PRESET_ACTUAL, bounds, 1440, 2400)

		assertTrue("expected a layer scale below fit, got $scale", scale < ZoomMath.FIT)
		assertEquals(1f, renderedRatio(bounds, 1440, 2400, scale), 0.0001f)
	}

	@Test
	fun aDownsampledBitmapStillReportsHonestSourceScale() {
		// The bitmap is half the file's size, so one bitmap pixel IS two source pixels. Ignoring
		// sampleSize would render 200% and call it 100%.
		val bounds = ImageBounds(width = 4096, height = 4096, sampleSize = 2)
		val scale = ZoomMath.scaleForRatio(ZoomMath.PRESET_ACTUAL, bounds, 1440, 2400)

		assertEquals(1f, renderedRatio(bounds, 1440, 2400, scale), 0.0001f)
	}

	@Test
	fun theThreePresetsStayInTheirStatedRatioToEachOther() {
		val bounds = ImageBounds(width = 4000, height = 3000, sampleSize = 1)
		val half = ZoomMath.scaleForRatio(ZoomMath.PRESET_HALF, bounds, 1440, 2400)
		val actual = ZoomMath.scaleForRatio(ZoomMath.PRESET_ACTUAL, bounds, 1440, 2400)
		val double = ZoomMath.scaleForRatio(ZoomMath.PRESET_DOUBLE, bounds, 1440, 2400)

		assertEquals(actual / 2f, half, 0.0001f)
		assertEquals(actual * 2f, double, 0.0001f)
	}

	@Test
	fun aDegenerateFrameOrBitmapFallsBackToFitRatherThanProducingAnUnusableScale() {
		val bounds = ImageBounds(width = 100, height = 100, sampleSize = 1)

		assertEquals(ZoomMath.FIT, ZoomMath.scaleForRatio(1f, bounds, 0, 2400), 0f)
		assertEquals(ZoomMath.FIT, ZoomMath.scaleForRatio(1f, ImageBounds(0, 0, 1), 1440, 2400), 0f)
	}

	// ---- the pinch domain ----

	@Test
	fun everyPresetIsReachableWithinTheDomainForALargePhoto() {
		val bounds = ImageBounds(width = 4000, height = 3000, sampleSize = 1)
		val d = ZoomMath.domain(bounds, 1440, 2400)

		for (ratio in listOf(ZoomMath.PRESET_HALF, ZoomMath.PRESET_ACTUAL, ZoomMath.PRESET_DOUBLE)) {
			val s = ZoomMath.scaleForRatio(ratio, bounds, 1440, 2400)
			assertTrue("$ratio unreachable: $s not in ${d.min}..${d.max}", s in d.min..d.max)
		}
		assertTrue("fit unreachable", ZoomMath.FIT in d.min..d.max)
	}

	@Test
	fun everyPresetIsReachableForATinyIconWhereAllThreeSitBelowFit() {
		// The case a fixed 1f..6f range got backwards: here fit is the CEILING, not the floor.
		val bounds = ImageBounds(width = 64, height = 64, sampleSize = 1)
		val d = ZoomMath.domain(bounds, 1440, 2400)

		for (ratio in listOf(ZoomMath.PRESET_HALF, ZoomMath.PRESET_ACTUAL, ZoomMath.PRESET_DOUBLE)) {
			val s = ZoomMath.scaleForRatio(ratio, bounds, 1440, 2400)
			assertTrue("$ratio unreachable: $s not in ${d.min}..${d.max}", s in d.min..d.max)
		}
		assertTrue("fit unreachable", ZoomMath.FIT in d.min..d.max)
	}

	@Test
	fun repeatedPinchInCannotDecayTheImageToAnUnrecoverableDot() {
		// Pinch multiplies, so without a floor the scale tends to zero and never comes back.
		val bounds = ImageBounds(width = 4000, height = 3000, sampleSize = 1)
		val d = ZoomMath.domain(bounds, 1440, 2400)
		var scale = ZoomMath.FIT
		repeat(200) { scale = (scale * 0.8f).coerceIn(d.min, d.max) }

		assertEquals(d.min, scale, 0f)
		assertTrue("floor collapsed to zero", scale > 0f)
	}

	@Test
	fun repeatedPinchOutIsBoundedToo() {
		val bounds = ImageBounds(width = 4000, height = 3000, sampleSize = 1)
		val d = ZoomMath.domain(bounds, 1440, 2400)
		var scale = ZoomMath.FIT
		repeat(200) { scale = (scale * 1.25f).coerceIn(d.min, d.max) }

		assertEquals(d.max, scale, 0f)
		assertTrue("ceiling must clear the largest preset", d.max > ZoomMath.scaleForRatio(2f, bounds, 1440, 2400))
	}

	// ---- pan ----

	@Test
	fun aFittedImageCannotBePannedAtAllSoItStaysCentred() {
		val bounds = ImageBounds(width = 4000, height = 3000, sampleSize = 1)
		val p = ZoomMath.panBounds(bounds, 1440, 2400, ZoomMath.FIT)

		assertEquals(0f, p.maxX, 0f)
		assertEquals(0f, p.maxY, 0f)
	}

	@Test
	fun panStopsExactlyWhereTheImageEdgeMeetsTheFrameEdge() {
		val bounds = ImageBounds(width = 4000, height = 3000, sampleSize = 1)
		val scale = ZoomMath.scaleForRatio(ZoomMath.PRESET_ACTUAL, bounds, 1440, 2400)
		val p = ZoomMath.panBounds(bounds, 1440, 2400, scale)
		val fit = ZoomMath.fitFactor(bounds, 1440, 2400)
		val drawnWidth = bounds.width * fit * scale

		// Dragged fully to the limit, the far edge lands on the frame edge and no further.
		assertEquals((drawnWidth - 1440) / 2f, p.maxX, 0.001f)
		assertTrue("a zoomed image must be pannable", p.maxX > 0f)
	}

	@Test
	fun anAxisThatDoesNotOverflowIsPinnedEvenWhileTheOtherPans() {
		// A wide panorama zoomed to fill the width still fits vertically, so vertical drag must not
		// open a gap above and below.
		val bounds = ImageBounds(width = 4000, height = 400, sampleSize = 1)
		val p = ZoomMath.panBounds(bounds, 1440, 2400, 4f)

		assertTrue("horizontal should pan", p.maxX > 0f)
		assertEquals(0f, p.maxY, 0f)
	}

	// ---- sampling quality ----

	@Test
	fun nearestNeighbourTurnsOnOnlyAboveOneToOne() {
		val bounds = ImageBounds(width = 64, height = 64, sampleSize = 1)
		val actual = ZoomMath.scaleForRatio(ZoomMath.PRESET_ACTUAL, bounds, 1440, 2400)

		assertFalse(ZoomMath.useNearestNeighbour(bounds, 1440, 2400, actual * 0.9f))
		assertFalse("at exactly 1:1 there is nothing to interpolate", ZoomMath.useNearestNeighbour(bounds, 1440, 2400, actual))
		assertTrue(ZoomMath.useNearestNeighbour(bounds, 1440, 2400, actual * 1.1f))
	}

	@Test
	fun aDownsampledBitmapStaysSmoothBecauseItsGridIsNotTheSourceGrid() {
		val bounds = ImageBounds(width = 4096, height = 4096, sampleSize = 2)
		val actual = ZoomMath.scaleForRatio(ZoomMath.PRESET_ACTUAL, bounds, 1440, 2400)

		assertFalse(ZoomMath.useNearestNeighbour(bounds, 1440, 2400, actual * 4f))
	}

	// ---- source dimensions the info row reports ----

	@Test
	fun sourceDimensionsUndoTheDownsampleSoTheInfoRowQuotesTheFileNotTheBitmap() {
		val bounds = ImageBounds(width = 2048, height = 1536, sampleSize = 4)

		assertEquals(8192, bounds.sourceWidth)
		assertEquals(6144, bounds.sourceHeight)
	}

	@Test
	fun measuredSourceDimensionsWinOverTheDerivedOnesBecauseTheDecoderRounds() {
		// A 4097-wide file at inSampleSize 2 decodes to 2049, and 2049*2 is 4098. The row must quote
		// what the file says, not what the multiplication reconstructs.
		val bounds = ImageBounds(width = 2049, height = 1537, sampleSize = 2, sourceWidth = 4097, sourceHeight = 3073)

		assertEquals(4097, bounds.sourceWidth)
		assertEquals(3073, bounds.sourceHeight)
	}
}
