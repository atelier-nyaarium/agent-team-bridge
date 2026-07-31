package com.atelier_nyaarium.switchboard

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

////////////////////////////////
//  Functions & Helpers

/**
 * Small bitmaps for the attachment tiles, through the shared [ThumbCache].
 *
 * Gated on [isPreviewable] rather than on what BitmapFactory can decode. BitmapFactory could draw
 * more than the WebView transcript can, but a file that tiled here and then became a plain row once
 * sent would be a worse surface than one that looks the same before and after.
 */
object ImageThumbs {
	/** Short edge of a cached thumb, in pixels. The tile crops to a square, so this is the edge that
	 * decides sharpness; 256 covers a 64.dp tile at any density this app runs on. */
	private const val THUMB_DIM = 256

	/** Hard ceiling on the long edge. Sharpness alone cannot bound an extreme aspect ratio: a
	 * stitched screenshot or a panorama has a short edge already near the tile, so nothing else would
	 * stop it decoding tens of megabytes to fill 64.dp. */
	private const val MAX_THUMB_EDGE = 1024

	/** Backstop on the halving loops, so a degenerate probe cannot spin. */
	private const val MAX_SAMPLE = 64

	/** The tile's bitmap, decoded if this is the first ask. Null when the file is not a previewable
	 * image, its bytes are not on disk yet, or the decode failed. */
	suspend fun of(filesDir: File, file: MessageFile): Bitmap? {
		if (!isPreviewable(file)) return null
		val key = ThumbCache.image(file.blobId, file.src) ?: return null
		ThumbCache.get(key)?.let { return it }
		val src = file.src ?: return null
		return withContext(Dispatchers.IO) {
			val onDisk = Attachments.fileFor(filesDir, src) ?: return@withContext null
			decodeThumb(onDisk)?.also { ThumbCache.put(key, it) }
		}
	}

	/** Decode near tile size and never larger than the ceiling, then trim the remainder. inSampleSize
	 * only halves, so it lands within a factor of two; the scale afterwards is what makes a cached
	 * thumb a predictable size instead of one that grows with the source. */
	private fun decodeThumb(file: File): Bitmap? = runCatching {
		val probe = BitmapFactory.Options().apply { inJustDecodeBounds = true }
		BitmapFactory.decodeFile(file.path, probe)
		if (probe.outWidth <= 0 || probe.outHeight <= 0) return@runCatching null

		val sample = sampleFor(probe.outWidth, probe.outHeight)
		val decoded = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
			?: return@runCatching null
		scaleToTile(decoded)
	}.getOrNull()

	/**
	 * The inSampleSize to decode at.
	 *
	 * Two rules, and BOTH are load-bearing. Sharpness alone stops before the short edge falls under
	 * the tile, which for a lopsided image leaves the long edge unbounded: a stitched screenshot has a
	 * short edge already near the tile, so it would decode at full size to fill 64.dp. The ceiling is
	 * what binds that case, and only that case binds it.
	 */
	internal fun sampleFor(width: Int, height: Int): Int {
		if (width <= 0 || height <= 0) return 1
		var sample = 1
		while (minOf(width, height) / (sample * 2) >= THUMB_DIM) sample *= 2
		while (maxOf(width, height) / sample > MAX_THUMB_EDGE && sample < MAX_SAMPLE) sample *= 2
		return sample
	}

	/** Trim a decoded bitmap so its short edge sits at the tile. The cache is shared with the Designer
	 * card thumbs, so an oversized photo here evicts unrelated work. */
	private fun scaleToTile(decoded: Bitmap): Bitmap {
		val shortEdge = minOf(decoded.width, decoded.height)
		if (shortEdge <= THUMB_DIM) return decoded
		val factor = THUMB_DIM.toFloat() / shortEdge
		val width = (decoded.width * factor).toInt().coerceAtLeast(1)
		val height = (decoded.height * factor).toInt().coerceAtLeast(1)
		val scaled = Bitmap.createScaledBitmap(decoded, width, height, true)
		if (scaled !== decoded) decoded.recycle()
		return scaled
	}
}
