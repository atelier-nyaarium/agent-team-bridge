package com.atelier_nyaarium.switchboard

import android.graphics.Bitmap
import android.util.LruCache

////////////////////////////////
//  Functions & Helpers

/**
 * The one bitmap cache every thumbnail surface shares.
 *
 * Bounded in BYTES rather than entries, because the two producers make very different bitmaps: a
 * captured design card and a decoded photo thumb have nothing in common but their type. Counting
 * entries would let one of them quietly own all the memory.
 *
 * Keys are namespaced by producer. A design card is keyed by its attachment rel and an image by its
 * content reference, and those are different strings drawn from different spaces, so without a
 * prefix a collision would silently serve one surface's bitmap to the other.
 *
 * Deliberately holds NO lock. Serializing renders is the WebView producer's problem, since there is
 * one WebView and it is main-thread-only; a decode has no such constraint and must not queue behind
 * a card render.
 */
object ThumbCache {
	// ~20 card thumbs at 300 KB, or many more of the smaller image thumbs.
	private const val MAX_BYTES = 6 * 1024 * 1024

	private val cache = object : LruCache<String, Bitmap>(MAX_BYTES) {
		override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
	}

	fun card(rel: String): String = "card:$rel"

	/**
	 * The key for a file's image thumbnail.
	 *
	 * `blobId` first because it is content-addressed, so the same bytes arriving twice hit one entry.
	 * It is absent on a file the user just picked (it is computed when the message is sent), which is
	 * why `src` has to be the fallback rather than the key being blobId alone.
	 */
	fun image(blobId: String?, src: String?): String? {
		val id = blobId?.takeIf { it.isNotBlank() } ?: src?.takeIf { it.isNotBlank() } ?: return null
		return "img:$id"
	}

	fun get(key: String): Bitmap? = cache.get(key)

	fun put(key: String, bitmap: Bitmap) {
		cache.put(key, bitmap)
	}

	/** Drop everything. Used when the attachment store is purged, so a revoked file cannot keep
	 * showing from memory after its bytes are gone. */
	fun clear() {
		cache.evictAll()
	}
}
