package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Thumbnail decode sizing.
 *
 * Asserted in BYTES rather than in sample steps, because the failure this guards against is a heap
 * blow-up: a rule that bounds only the short edge lets a lopsided image decode at full size to fill
 * a 64.dp tile, and the resulting OutOfMemoryError is swallowed into a blank tile.
 */
class ImageThumbsTest {
	/** ARGB_8888, which is what BitmapFactory yields here. */
	private fun bytesAfterDecode(width: Int, height: Int): Int {
		val sample = ImageThumbs.sampleFor(width, height)
		return (width / sample) * (height / sample) * 4
	}

	private val cacheBytes = 6 * 1024 * 1024

	// ---- ordinary photos ----

	@Test
	fun aTwelveMegapixelPhotoDecodesToASmallFractionOfTheCache() {
		val bytes = bytesAfterDecode(4032, 3024)

		assertTrue("4032x3024 decoded to $bytes bytes", bytes < cacheBytes / 4)
	}

	@Test
	fun aTwentyFourMegapixelPhotoDecodesToASmallFractionOfTheCache() {
		val bytes = bytesAfterDecode(6000, 4000)

		assertTrue("6000x4000 decoded to $bytes bytes", bytes < cacheBytes / 4)
	}

	@Test
	fun aSquareImageIsNotDownsampledPastTheTile() {
		// The short edge is what the crop shows, so it must not fall under the tile.
		val sample = ImageThumbs.sampleFor(1024, 1024)

		assertTrue("short edge fell under the tile", 1024 / sample >= 256)
	}

	// ---- the shapes that break a short-edge-only rule ----

	@Test
	fun aTallStitchedScreenshotCannotDecodeAtFullSize() {
		// Short edge 400 is already near the tile, so sharpness alone would leave sample at 1 and
		// decode 400x20000, which is 32 MB for a 64.dp tile.
		val bytes = bytesAfterDecode(400, 20000)

		assertTrue("400x20000 decoded to $bytes bytes, over the whole cache", bytes < cacheBytes)
	}

	@Test
	fun aWidePanoramaCannotDecodeAtFullSize() {
		val bytes = bytesAfterDecode(12000, 1000)

		assertTrue("12000x1000 decoded to $bytes bytes, over the whole cache", bytes < cacheBytes)
	}

	@Test
	fun noAspectRatioDecodesLargerThanTheCacheItGoesInto() {
		// The general form of the two above: whatever the shape, one thumbnail must not evict
		// everything the cache holds, including the Designer card thumbs sharing it.
		val shapes = listOf(
			8000 to 500,
			500 to 8000,
			16000 to 300,
			4000 to 4000,
			10000 to 10000,
			259 to 30000,
		)
		for ((w, h) in shapes) {
			val bytes = bytesAfterDecode(w, h)
			assertTrue("${w}x$h decoded to $bytes bytes", bytes < cacheBytes)
		}
	}

	// ---- degenerate probes ----

	@Test
	fun aFailedProbeAsksForNoDownsampling() {
		assertEquals(1, ImageThumbs.sampleFor(0, 0))
		assertEquals(1, ImageThumbs.sampleFor(-1, 100))
	}

	@Test
	fun aTinyImageIsNeverDownsampled() {
		assertEquals(1, ImageThumbs.sampleFor(48, 48))
		assertEquals(1, ImageThumbs.sampleFor(480, 320))
	}
}
