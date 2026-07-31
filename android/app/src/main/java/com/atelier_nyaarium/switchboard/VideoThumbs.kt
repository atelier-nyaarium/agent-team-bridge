package com.atelier_nyaarium.switchboard

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

////////////////////////////////
//  Functions & Helpers

/**
 * Frame sets for video thumbnails, extracted once and cached on disk.
 *
 * Ten seeks is expensive, so this never runs on the main thread and never blocks a row from
 * rendering: a video shows its glyph until a set exists. A video whose frames cannot be extracted
 * keeps the glyph rather than failing.
 *
 * The frames live under the attachments root so the WebView reaches them through the same mounted
 * path as everything else it draws.
 */
object VideoThumbs {
	/** Long edge handed to the retriever. Unbounded extraction decodes a full-resolution bitmap per
	 * seek, which on a 4K source is tens of megabytes ten times over, to paint a ~100 px tile. */
	private const val FRAME_DIM = 256

	private const val JPEG_QUALITY = 80

	/** Buckets are named from a digest so a src, which is a URL path, cannot shape a directory. */
	private const val BUCKET_CHARS = 32

	private val extractLock = Mutex()

	/**
	 * Identity for a video's frame set.
	 *
	 * Content-addressed when the bytes are named, so the sent copy and its settled echo share one
	 * set. A file the user just picked has no `blobId` (it is stamped at send), which is why `src` has
	 * to be the fallback rather than the key being `blobId` alone.
	 */
	fun keyFor(file: MessageFile): String? =
		file.blobId?.takeIf { it.isNotBlank() } ?: file.src?.takeIf { it.isNotBlank() }

	fun bucketFor(key: String): String {
		val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray())
		return "frames-" + digest.joinToString("") { "%02x".format(it) }.take(BUCKET_CHARS)
	}

	/** The srcs of an already-extracted set, in order, or empty when none exists yet. */
	fun cached(filesDir: File, key: String): List<String> {
		val dir = File(Attachments.root(filesDir), bucketFor(key))
		val frames = dir.listFiles { f -> f.isFile && f.name.endsWith(".jpg") } ?: return emptyList()
		return frames.sortedBy { it.name }.map { "${Attachments.assetBase()}/${bucketFor(key)}/${it.name}" }
	}

	/**
	 * Extract the set if it is not already on disk, and report its frames.
	 *
	 * Serialized: several rows of video reaching this at once would otherwise run concurrent decoder
	 * sessions, and the whole point of the disk cache is that the work happens once.
	 */
	suspend fun ensure(filesDir: File, key: String, source: File): List<String> {
		cached(filesDir, key).takeIf { it.isNotEmpty() }?.let { return it }
		return extractLock.withLock {
			cached(filesDir, key).takeIf { it.isNotEmpty() } ?: withContext(Dispatchers.IO) {
				extract(filesDir, key, source)
			}
		}
	}

	private fun extract(filesDir: File, key: String, source: File): List<String> {
		val retriever = MediaMetadataRetriever()
		return runCatching {
			retriever.setDataSource(source.path)
			// Probed FIRST. A null or non-numeric duration has no defined behaviour in the sampling
			// arithmetic, and an audio-only container carrying a video mime would otherwise run every
			// seek just to collect nulls.
			val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
				?.toLongOrNull()
				?: return@runCatching emptyList()
			val offsets = VideoSampling.pointsMs(duration).ifEmpty { listOf(VideoSampling.midpointMs(duration)) }
			val dir = File(Attachments.root(filesDir), bucketFor(key)).apply { mkdirs() }

			val written = offsets.mapIndexedNotNull { i, atMs ->
				// OPTION_CLOSEST explicitly: the default snaps to the nearest SYNC frame, so on a
				// sparse-GOP source (a screen recording, which is most of what gets attached) every
				// sample resolves to the same frame and the thumb is silently static.
				val frame = retriever.getScaledFrameAtTime(
					VideoSampling.msToUs(atMs),
					MediaMetadataRetriever.OPTION_CLOSEST,
					FRAME_DIM,
					FRAME_DIM,
				) ?: return@mapIndexedNotNull null
				val name = "%02d.jpg".format(i)
				runCatching {
					File(dir, name).outputStream().use { frame.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
					name
				}.getOrNull().also { frame.recycle() }
			}
			// A partial set would cycle through gaps, so it is all or nothing.
			if (written.size != offsets.size) {
				dir.deleteRecursively()
				emptyList()
			} else {
				written.map { "${Attachments.assetBase()}/${bucketFor(key)}/$it" }
			}
		}.getOrDefault(emptyList()).also { runCatching { retriever.release() } }
	}
}
