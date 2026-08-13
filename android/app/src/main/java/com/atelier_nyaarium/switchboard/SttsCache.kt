package com.atelier_nyaarium.switchboard

import android.util.Log
import com.atelier_nyaarium.switchboard.SttsPlayer.Tier
import com.atelier_nyaarium.switchboard.proto.SttsProvider
import java.io.File
import java.util.concurrent.Executor

private const val TAG = "SttsPlayer"

/**
 * The per-message audio cache: where each rendering is filed, what fills it ahead of a play, and how
 * long that audio runs. [SttsPlayer] owns the MediaPlayer and the request registry; SttsClient owns
 * the wire.
 *
 * `warmExec` is lent by [SttsPlayer], which declares every lane, so warming stays on the wide pool
 * and off the synth, play, control and event lanes.
 */
class SttsCache(
	private val root: File,
	private val requests: PlaybackRequests,
	private val warmExec: Executor,
) {
	/** Pre-synthesize every tier of one message into the cache without playing, so a later Play is a
	 * cache hit. Blocking - call off the main thread. Dedups tiers that speak the same text:
	 * synthesize once and copy. Never throws; a failed tier just synthesizes on demand at Play. */
	fun preloadTiers(
		client: SttsClient,
		provider: SttsProvider,
		voice: String?,
		team: String,
		at: Long,
		titleText: String,
		summaryText: String,
		fullText: String,
	) {
		// Captured ONCE, before the first claim. This producer re-claims per tier, and a horizon read
		// per claim always sits after the purge it was meant to notice - including in the gaps between
		// tiers, where it holds no claim for a sweep to find.
		val horizon = requests.purgeStamp()
		val done = mutableMapOf<String, File>()
		for ((tier, text) in listOf(Tier.SUMMARY to summaryText, Tier.FULL to fullText, Tier.TITLE to titleText)) {
			val dest = cacheFile(team, at, tier, provider, voice, text)
			val twin = done[text]
			if (twin != null) {
				if (!dest.exists() || dest.length() == 0L) runCatching { twin.copyTo(dest, overwrite = true) }
				// The copy writes cache under no claim of its own, so it needs the same check.
				if (requests.purgedSince(team, horizon)) return discardPreload(dest)
				continue
			}
			val ok = synthToCache(client, provider, voice, text, dest)
			// Purged at any point since this preload began: the write above resurrected a deleted
			// directory, so undo it. This holds no claim - a warm-up is not a request, and the epoch
			// covers it in the gaps between tiers where a claim could not.
			if (requests.purgedSince(team, horizon)) return discardPreload(dest)
			if (ok) done[text] = dest
		}
	}

	// What has been warmed, and how long it turned out to be. The duration is the useful by-product:
	// until audio exists nothing can say how long a message will take, so a queue tile has nothing to
	// show but a shrug.
	internal val warmedMs = java.util.concurrent.ConcurrentHashMap<QueueEntry, Long>()
	private val warming = java.util.concurrent.ConcurrentHashMap.newKeySet<QueueEntry>()

	/** How long a warmed message runs, or null if its audio does not exist yet. */
	fun warmedDuration(team: String, at: Long, tier: Tier?): Long? = warmedMs[QueueEntry(team, at, tier)]

	/**
	 * Synthesize one queued entry ahead of its turn, off on the warm pool.
	 *
	 * Holds NO claim, deliberately: a warm-up is not something a consumer can see, stop, or advance a
	 * queue on, and giving it one made a message being pre-generated read as playing. A purge reaches
	 * it through the epoch instead, which also covers the gap between the write and the measure where
	 * no claim could exist.
	 *
	 * Idempotent per entry, so the repository can call it on every queue change without stacking
	 * fetches for something already in flight.
	 */
	fun warm(
		client: SttsClient,
		provider: SttsProvider,
		voice: String?,
		team: String,
		at: Long,
		tier: Tier,
		text: String,
	) {
		val entry = QueueEntry(team, at, tier)
		if (warmedMs.containsKey(entry) || !warming.add(entry)) return
		warmExec.execute {
			try {
				val horizon = requests.purgeStamp()
				val dest = cacheFile(team, at, tier, provider, voice, text)
				if (!dest.isFile || dest.length() == 0L) {
					if (!synthToCache(client, provider, voice, text, dest)) return@execute
					if (requests.purgedSince(team, horizon)) return@execute discardPreload(dest)
				}
				durationOf(dest)?.let { warmedMs[entry] = it }
			} finally {
				warming.remove(entry)
			}
		}
	}

	/** A cached file's length in milliseconds. Best effort: an unreadable or half-written file simply
	 * has no duration yet, which the tile shows as waiting rather than as a wrong number. */
	private fun durationOf(f: File): Long? =
		runCatching {
			android.media.MediaMetadataRetriever().use { mmr ->
				mmr.setDataSource(f.absolutePath)
				mmr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
			}
		}.getOrNull()

	/** Remove what a preload wrote into a directory that a purge had already deleted. The parent goes
	 * only if it is now empty, so this cannot take a sibling message's cached audio with it. */
	internal fun discardPreload(dest: File) {
		dest.delete()
		dest.parentFile?.takeIf { it.list()?.isEmpty() == true }?.delete()
	}

	/** Synthesize `text` into `dest` (atomic, cache-skip), returning whether
	 * `dest` holds audio afterward. Uses a preload-specific temp name so it never
	 * collides with a concurrent play's temp file; a play that races it just
	 * re-synthesizes (last atomic rename wins, same bytes). Never throws. */
	private fun synthToCache(
		client: SttsClient,
		provider: SttsProvider,
		voice: String?,
		text: String,
		dest: File,
	): Boolean {
		if (dest.exists() && dest.length() > 0L) return true
		if (text.isBlank()) return false
		return try {
			dest.parentFile?.mkdirs()
			val tmp = File(dest.parentFile, "${dest.name}.ptmp")
			client.stream(provider, text, voice, tmp)
			if (tmp.length() == 0L || !tmp.renameTo(dest)) {
				tmp.delete()
				false
			} else {
				true
			}
		} catch (e: Exception) {
			Log.w(TAG, "preload synth failed: ${e.message}")
			dest.delete()
			false
		}
	}

	/**
	 * Keyed on the spoken WORDS as well as the entry, the same way a marker is.
	 *
	 * One entry can be spoken more than one way - a message played by hand carries its own attribution
	 * while one inside a run does not, because a marker already said it. Without the text in the key,
	 * whichever variant synthesized first is served to both, and a cache hit never looks at the text it
	 * was asked for.
	 */
	internal fun cacheFile(
		team: String,
		at: Long,
		tier: Tier,
		provider: SttsProvider,
		voice: String?,
		text: String,
	): File = File(
		File(root, "stts/$team"),
		"$at-${tier.suffix}-${provider.path}-${safeVoice(voice)}-${text.hashCode()}.audio",
	)

	/** The sample entry's `at`. The preview is not a message, so this stands in for one, derived from
	 * provider and voice so two voices are two entries. */
	internal fun sampleAt(provider: SttsProvider, voice: String?): Long =
		"${provider.path}-${safeVoice(voice)}".hashCode().toLong()

	/** A marker's entry key. Derived from the spoken WORDS, so every message from one session reuses a
	 * single synthesis instead of paying per message - and two sessions that happen to share a label
	 * share the audio, which is correct because the audio is the label. */
	internal fun markerAt(text: String, provider: SttsProvider, voice: String?): Long =
		"$text|${provider.path}-${safeVoice(voice)}".hashCode().toLong()

	internal fun safeVoice(voice: String?): String =
		(voice ?: "default").replace(Regex("[^A-Za-z0-9_-]"), "_").take(48)
}
