package com.atelier_nyaarium.switchboard

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.audiofx.LoudnessEnhancer
import android.util.Log
import com.atelier_nyaarium.switchboard.proto.SttsProvider
import java.io.File
import java.util.Collections
import java.util.concurrent.Executors

/**
 * Synthesis playback with a per-message audio cache. Owns the cache layout and
 * the MediaPlayer; SttsClient owns the wire. Audio is cached per
 * (team, message.at, tier, provider, voice) - `at` is the stable per-message
 * identity (Message.id is reassigned on load), and the voice identity rides
 * the key so a settings change can never replay another voice's audio. The
 * container varies by provider (MP3 or streaming WAV mislabeled as audio/wav),
 * so files keep a neutral extension and MediaPlayer sniffs.
 *
 * Single-flight: a tap while the same message+tier is synthesizing is a no-op;
 * a cache hit plays with no request; tapping the one currently playing stops
 * it (toggle). Synthesis and playback hand-offs run on one daemon thread, so
 * impatient multi-taps can never fire a second request.
 */
class SttsPlayer(private val root: File) {
	enum class Tier(val suffix: String) { FULL("full"), SUMMARY("summary"), TITLE("title") }

	private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "stts").apply { isDaemon = true } }
	private val inFlight = Collections.synchronizedSet(mutableSetOf<String>())

	@Volatile private var player: MediaPlayer? = null
	@Volatile private var loudness: LoudnessEnhancer? = null
	@Volatile private var currentKey: String? = null
	@Volatile private var currentTeam: String? = null
	@Volatile private var currentAt: Long = 0

	/** Set by the owner; fired on any thread when playback starts (playing=true)
	 * or ends by completion, error, stop, or replacement (playing=false), so the
	 * thread UI can swap its play/stop glyph. */
	@Volatile var onPlayingChanged: ((team: String, at: Long, playing: Boolean) -> Unit)? = null

	/** Set by the owner; fired on the player thread when a synthesis or
	 * playback attempt fails, so a tap never dead-ends silently (e.g. a
	 * provider the service has no key for streams zero bytes). */
	@Volatile var onPlaybackError: ((reason: String) -> Unit)? = null

	fun isPlaying(team: String, at: Long, tier: Tier): Boolean =
		currentKey?.startsWith("$team/$at-${tier.suffix}-") == true

	/** Whether this message is playing in ANY tier. The play button toggles by message (it cannot
	 * know which tier an autoplay chose), unlike [isPlaying] which is tier-specific. */
	fun isPlayingMessage(team: String, at: Long): Boolean = currentKey != null && currentTeam == team && currentAt == at

	/** Run work on the player's daemon thread. Lets callers move credential
	 * loading and message resolution off their own thread (a broadcast
	 * receiver's main thread must hold zero disk or crypto work). */
	fun post(action: () -> Unit) {
		exec.execute(action)
	}

	/** Play (or toggle-stop) one message tier. Synthesizes through `client` on a
	 * cache miss, then plays the cached file. Safe to call from any thread.
	 * `volumePct` is 0-200 (100 = unchanged); see [applyVolume]. */
	fun play(
		client: SttsClient,
		provider: SttsProvider,
		voice: String?,
		team: String,
		at: Long,
		tier: Tier,
		text: String,
		volumePct: Int = 100,
	) {
		val k = key(team, at, tier, provider, voice)
		if (currentKey == k) {
			stop()
			return
		}
		if (text.isBlank()) return
		synthesizeAndPlay(k, team, at, cacheFile(team, at, tier, provider, voice), volumePct) { dest ->
			client.stream(provider, text, voice, dest)
		}
	}

	/** Voice preview for the settings screen: synthesizes through the cheaper
	 * sample endpoint (stream for providers without one) and plays. Cached per
	 * provider+voice under the reserved "_sample" team, purged with clearAll. */
	fun playSample(client: SttsClient, provider: SttsProvider, voice: String?, text: String, volumePct: Int = 100) {
		val k = "_sample/${provider.path}-${safeVoice(voice)}"
		if (currentKey == k) {
			stop()
			return
		}
		val dest = File(File(root, "stts/_sample"), "${provider.path}-${safeVoice(voice)}.audio")
		synthesizeAndPlay(k, "_sample", 0, dest, volumePct) { d -> client.sample(provider, text, voice, d) }
	}

	/** Pre-synthesize both tiers of one message into the cache without playing,
	 * so a later Play is a cache hit. Blocking - call off the main thread.
	 * Dedups when both tiers speak the same text: synthesize once and copy.
	 * Never throws; a failed tier just synthesizes on demand at Play. */
	fun preloadBoth(
		client: SttsClient,
		provider: SttsProvider,
		voice: String?,
		team: String,
		at: Long,
		summaryText: String,
		fullText: String,
	) {
		val sumDest = cacheFile(team, at, Tier.SUMMARY, provider, voice)
		val sumOk = synthToCache(client, provider, voice, summaryText, sumDest)
		val fullDest = cacheFile(team, at, Tier.FULL, provider, voice)
		if (fullText == summaryText) {
			if (sumOk && (!fullDest.exists() || fullDest.length() == 0L)) {
				runCatching { sumDest.copyTo(fullDest, overwrite = true) }
			}
		} else {
			synthToCache(client, provider, voice, fullText, fullDest)
		}
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

	/** Shared synthesis path: single-flight on the key, atomic cache write,
	 * then playback. `fetch` writes the audio into the destination file. */
	private fun synthesizeAndPlay(k: String, team: String, at: Long, dest: File, volumePct: Int, fetch: (File) -> Unit) {
		if (!inFlight.add(k)) return
		exec.execute {
			try {
				if (!dest.exists() || dest.length() == 0L) {
					dest.parentFile?.mkdirs()
					val tmp = File(dest.parentFile, "${dest.name}.tmp")
					fetch(tmp)
					if (tmp.length() == 0L || !tmp.renameTo(dest)) {
						tmp.delete()
						error("synthesis returned no audio")
					}
				}
				playFile(k, team, at, dest, volumePct)
			} catch (e: Exception) {
				Log.w(TAG, "stts $k failed: ${e.message}")
				dest.delete()
				onPlaybackError?.invoke(e.message ?: "synthesis failed")
			} finally {
				inFlight.remove(k)
			}
		}
	}

	@Synchronized
	fun stop() {
		runCatching { loudness?.release() }
		loudness = null
		runCatching { player?.release() }
		player = null
		clearNowPlaying()
	}

	/** Delete a team's cached audio; wired into ChatRepository.forget. Under the dot grammar a
	 * team address ("domain.gateway.spawn.session") is a flat path segment with no slash, so it
	 * does not nest a subdir: the team string is the unique path, so two distinct sessions never
	 * share a cache dir. */
	fun purge(team: String) {
		if (currentKey?.startsWith("$team/") == true) stop()
		File(root, "stts/$team").deleteRecursively()
	}

	/** Stop and delete the entire cache root; wired into ChatRepository.clearAll
	 * so the repository never reaches into the player's directory layout. */
	fun purgeAll() {
		stop()
		File(root, "stts").deleteRecursively()
	}

	/** Null out the now-playing fields and notify the glyph listener. Callers
	 * hold the monitor or run on the completion path where currentKey matched. */
	private fun clearNowPlaying() {
		val team = currentTeam
		val at = currentAt
		currentKey = null
		currentTeam = null
		currentAt = 0
		if (team != null) onPlayingChanged?.invoke(team, at, false)
	}

	@Synchronized
	private fun playFile(k: String, team: String, at: Long, f: File, volumePct: Int) {
		runCatching { loudness?.release() }
		loudness = null
		runCatching { player?.release() }
		if (currentKey != null) clearNowPlaying()
		currentKey = k
		currentTeam = team
		currentAt = at
		val (linear, gainMb) = volumeSteps(volumePct)
		player = MediaPlayer().apply {
			setAudioAttributes(
				AudioAttributes.Builder()
					.setUsage(AudioAttributes.USAGE_MEDIA)
					.setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
					.build(),
			)
			setDataSource(f.absolutePath)
			setVolume(linear, linear)
			setOnCompletionListener {
				runCatching { loudness?.release() }
				loudness = null
				runCatching { it.release() }
				if (currentKey == k) {
					player = null
					clearNowPlaying()
				}
			}
			setOnErrorListener { mp, what, extra ->
				Log.w(TAG, "playback $k error what=$what extra=$extra")
				runCatching { loudness?.release() }
				loudness = null
				runCatching { mp.release() }
				if (currentKey == k) {
					player = null
					clearNowPlaying()
				}
				true
			}
			prepare()
			if (gainMb > 0) {
				loudness = LoudnessEnhancer(audioSessionId).apply {
					setTargetGain(gainMb)
					enabled = true
				}
			}
			start()
		}
		onPlayingChanged?.invoke(team, at, true)
	}

	// The path (not the descriptor id) is the cache component so entries survive
	// an id rename.
	private fun key(team: String, at: Long, tier: Tier, provider: SttsProvider, voice: String?): String =
		"$team/$at-${tier.suffix}-${provider.path}-${safeVoice(voice)}"

	private fun cacheFile(team: String, at: Long, tier: Tier, provider: SttsProvider, voice: String?): File =
		File(File(root, "stts/$team"), "$at-${tier.suffix}-${provider.path}-${safeVoice(voice)}.audio")

	private fun safeVoice(voice: String?): String =
		(voice ?: "default").replace(Regex("[^A-Za-z0-9_-]"), "_").take(48)

	companion object {
		private const val TAG = "SttsPlayer"

		/** Map a 0-200% volume setting to a MediaPlayer linear gain (0-100% range, free and exact)
		 * plus a LoudnessEnhancer target gain in millibels for the 100-200% half MediaPlayer can't
		 * reach on its own. The mB mapping is a rough linear approximation (true dB would be
		 * 20*log10(ratio)), not exact, but good enough for a user volume knob: 0 mB at 100%, 600 mB
		 * (~+6dB, roughly 2x) at 200%. */
		fun volumeSteps(volumePct: Int): Pair<Float, Int> {
			val clamped = volumePct.coerceIn(0, 200)
			val linear = minOf(clamped, 100) / 100f
			val gainMb = maxOf(clamped - 100, 0) * 6
			return linear to gainMb
		}

		/** The text a tier speaks. Summary prefers the addressable tiers; full
		 * is the sanitized body. */
		fun ttsText(m: Message, tier: Tier): String = when (tier) {
			Tier.SUMMARY -> m.summary ?: m.title ?: sanitize(m.text)
			Tier.TITLE -> m.title ?: m.summary ?: sanitize(m.text)
			Tier.FULL -> sanitize(m.text)
		}

		/** Light TTS sanitizer: drop code/mermaid fences and FILES blocks,
		 * reduce links to their labels, strip heading markers, collapse space. */
		fun sanitize(s: String): String = s
			.replace(Regex("```[\\s\\S]*?(```|$)"), " Code block omitted. ")
			.replace(Regex("\\[FILES[^\\]]*\\][\\s\\S]*?(?=\\n\\n|$)"), " Attachments omitted. ")
			.replace(Regex("\\[([^\\]]+)\\]\\([^)]*\\)"), "$1")
			.replace(Regex("(?m)^#{1,6}\\s*"), "")
			.replace(Regex("(?m)^[-*+]\\s+"), "")
			.replace(Regex("[*_`~]"), "")
			.replace(Regex("\\s+"), " ")
			.trim()
	}
}
