package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.mutableIntStateOf

////////////////////////////////
//  Functions & Helpers

/**
 * Announces that a video's frame set has landed on disk.
 *
 * Extraction is slow and lazy, so a row is normally already on screen before its frames exist, and
 * nothing else would ever tell it. Frames appearing on disk change neither the message list nor a
 * row's rendered content, which are the only two things the transcript re-syncs on.
 *
 * BOTH readers are load-bearing and either alone is silently inert. [generation] belongs in the
 * sync effect's keys, or no sync runs at all; [versionOf] belongs in the row fingerprint, or the
 * sync runs and skips the row as unchanged.
 */
object FrameReadiness {
	private val generationState = mutableIntStateOf(0)
	private val perKey = mutableMapOf<String, Int>()

	/** Read from composition, so a landing set recomposes whatever syncs the transcript. */
	val generation: Int
		get() = generationState.intValue

	/** Per frame-set, so folding this into a fingerprint re-pushes only the rows that gained frames. */
	fun versionOf(key: String): Int = synchronized(perKey) { perKey[key] ?: 0 }

	fun mark(key: String) {
		synchronized(perKey) { perKey[key] = (perKey[key] ?: 0) + 1 }
		generationState.intValue++
	}

	/** Forget every set. Paired with an attachment purge, whose deleted frames must not keep counting
	 * as ready. */
	fun clear() {
		synchronized(perKey) { perKey.clear() }
		generationState.intValue++
	}
}
