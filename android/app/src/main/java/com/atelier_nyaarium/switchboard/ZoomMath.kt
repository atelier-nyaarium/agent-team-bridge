package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/**
 * A decoded bitmap's size, the factor it was downsampled by, and the dimensions of the file it came
 * from. The source dimensions are carried rather than multiplied back out, because the decoder
 * rounds and the info row quotes these to the user as the image's real size.
 */
data class ImageBounds(
	val width: Int,
	val height: Int,
	val sampleSize: Int,
	val sourceWidth: Int = width * sampleSize,
	val sourceHeight: Int = height * sampleSize,
)

/** The scale range pinch may reach. Wider than the presets at both ends, so a preset is never the
 * boundary the user bumps into. */
data class ZoomDomain(val min: Float, val max: Float)

data class PanBounds(val maxX: Float, val maxY: Float)

////////////////////////////////
//  Functions & Helpers

/**
 * Zoom arithmetic for the fullscreen image stage, kept free of Compose so it is unit-testable.
 *
 * The layer scale is NOT the true-pixel ratio. The stage draws with ContentScale.Fit, so the bitmap
 * already arrives fitted to the container and a layer scale of 1 means "fit", whatever that happens
 * to be. On top of that a downsampled bitmap covers `sampleSize` source pixels per bitmap pixel.
 * Both factors sit between the layer scale and what the user reads as "100%", which is why a preset
 * cannot be a constant.
 */
object ZoomMath {
	/** True-pixel ratios the preset buttons request. */
	const val PRESET_HALF = 0.5f
	const val PRESET_ACTUAL = 1f
	const val PRESET_DOUBLE = 2f

	/** The layer scale that means "whole image inside the frame". ContentScale.Fit has already
	 * applied it, so this is the identity rather than a computed value. Named because the reset
	 * control and the domain floor both mean this specific scale, not the number 1. */
	const val FIT = 1f

	/** How much room pinch gets past the outermost preset, so the gesture never dead-ends exactly
	 * where a button lands. */
	private const val UNDERSHOOT = 0.5f
	private const val OVERSHOOT = 4f

	/** Bitmap pixels per container pixel once ContentScale.Fit has done its work. Zero when either
	 * side is degenerate, which every caller treats as "nothing to draw". */
	fun fitFactor(bounds: ImageBounds, containerWidth: Int, containerHeight: Int): Float {
		if (bounds.width <= 0 || bounds.height <= 0) return 0f
		if (containerWidth <= 0 || containerHeight <= 0) return 0f
		return minOf(containerWidth.toFloat() / bounds.width, containerHeight.toFloat() / bounds.height)
	}

	/**
	 * The layer scale that renders `ratio` screen pixels per SOURCE pixel.
	 *
	 * Fit is undone and the downsample factor is put back, so 100% is one source pixel per screen
	 * pixel on any density and any image size. An image smaller than the frame therefore returns a
	 * scale BELOW 1 for 100%, since Fit had already magnified it past 1:1. That case is precisely
	 * what a floor pinned at 1 used to make unreachable.
	 */
	fun scaleForRatio(ratio: Float, bounds: ImageBounds, containerWidth: Int, containerHeight: Int): Float {
		val fit = fitFactor(bounds, containerWidth, containerHeight)
		if (fit <= 0f || !ratio.isFinite() || ratio <= 0f) return FIT
		val sample = bounds.sampleSize.coerceAtLeast(1)
		val scale = ratio * sample / fit
		return if (scale.isFinite() && scale > 0f) scale else FIT
	}

	/**
	 * The pinch range, derived from this image against this frame rather than fixed.
	 *
	 * Both ends must clear the presets AND fit, because which of them is outermost flips with image
	 * size: a large photo's 200% sits far above fit, while a small icon's 50% sits far below it. A
	 * constant range gets one of those two cases wrong every time.
	 */
	fun domain(bounds: ImageBounds, containerWidth: Int, containerHeight: Int): ZoomDomain {
		val fit = fitFactor(bounds, containerWidth, containerHeight)
		if (fit <= 0f) return ZoomDomain(FIT, FIT)
		val presets = floatArrayOf(
			FIT,
			scaleForRatio(PRESET_HALF, bounds, containerWidth, containerHeight),
			scaleForRatio(PRESET_ACTUAL, bounds, containerWidth, containerHeight),
			scaleForRatio(PRESET_DOUBLE, bounds, containerWidth, containerHeight),
		)
		val min = (presets.min() * UNDERSHOOT).coerceAtLeast(Float.MIN_VALUE)
		val max = presets.max() * OVERSHOOT
		return if (max > min) ZoomDomain(min, max) else ZoomDomain(min, min)
	}

	/**
	 * How far the image may be dragged from centre before an edge would leave the frame.
	 *
	 * Zero on an axis the image does not overflow, which is what pins a fitted image to the centre
	 * instead of letting it be flung into empty space.
	 */
	fun panBounds(bounds: ImageBounds, containerWidth: Int, containerHeight: Int, scale: Float): PanBounds {
		val fit = fitFactor(bounds, containerWidth, containerHeight)
		if (fit <= 0f || !scale.isFinite() || scale <= 0f) return PanBounds(0f, 0f)
		val drawnWidth = bounds.width * fit * scale
		val drawnHeight = bounds.height * fit * scale
		return PanBounds(
			maxX = ((drawnWidth - containerWidth) / 2f).coerceAtLeast(0f),
			maxY = ((drawnHeight - containerHeight) / 2f).coerceAtLeast(0f),
		)
	}

	/**
	 * Whether the stage may draw with nearest-neighbour at this scale.
	 *
	 * Above 1:1 the source grid is what the user came to see, so interpolation is off. A DOWNSAMPLED
	 * bitmap is the exception: its grid is not the source grid, so nearest-neighbour would magnify
	 * pixels that were never in the file, which reads worse than a smooth blur.
	 */
	fun useNearestNeighbour(bounds: ImageBounds, containerWidth: Int, containerHeight: Int, scale: Float): Boolean {
		if (bounds.sampleSize > 1) return false
		val actual = scaleForRatio(PRESET_ACTUAL, bounds, containerWidth, containerHeight)
		return scale > actual
	}
}
