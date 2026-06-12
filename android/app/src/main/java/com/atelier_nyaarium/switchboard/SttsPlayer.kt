package com.atelier_nyaarium.switchboard

import android.media.AudioAttributes
import android.media.MediaPlayer
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
	enum class Tier(val suffix: String) { FULL("full"), SUMMARY("summary") }

	private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "stts").apply { isDaemon = true } }
	private val inFlight = Collections.synchronizedSet(mutableSetOf<String>())

	@Volatile private var player: MediaPlayer? = null
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

	/** Run work on the player's daemon thread. Lets callers move credential
	 * loading and message resolution off their own thread (a broadcast
	 * receiver's main thread must hold zero disk or crypto work). */
	fun post(action: () -> Unit) {
		exec.execute(action)
	}

	/**
	 * Play (or toggle-stop) one message tier. Synthesizes through `client` on
	 * a cache miss, then plays the cached file. Safe to call from any thread.
	 */
	fun play(
		client: SttsClient,
		provider: SttsProvider,
		voice: String?,
		team: String,
		at: Long,
		tier: Tier,
		text: String,
	) {
		val k = key(team, at, tier, provider, voice)
		if (currentKey == k) {
			stop()
			return
		}
		if (text.isBlank()) return
		synthesizeAndPlay(k, team, at, cacheFile(team, at, tier, provider, voice)) { dest ->
			client.stream(provider, text, voice, dest)
		}
	}

	/** Voice preview for the settings screen: synthesizes through the cheaper
	 * sample endpoint (stream for providers without one) and plays. Cached per
	 * provider+voice under the reserved "_sample" team, purged with clearAll. */
	fun playSample(client: SttsClient, provider: SttsProvider, voice: String?, text: String) {
		val k = "_sample/${provider.path}-${safeVoice(voice)}"
		if (currentKey == k) {
			stop()
			return
		}
		val dest = File(File(root, "stts/_sample"), "${provider.path}-${safeVoice(voice)}.audio")
		synthesizeAndPlay(k, "_sample", 0, dest) { d -> client.sample(provider, text, voice, d) }
	}

	/** Shared synthesis path: single-flight on the key, atomic cache write,
	 * then playback. `fetch` writes the audio into the destination file. */
	private fun synthesizeAndPlay(k: String, team: String, at: Long, dest: File, fetch: (File) -> Unit) {
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
				playFile(k, team, at, dest)
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
		runCatching { player?.release() }
		player = null
		clearNowPlaying()
	}

	/** Delete a team's cached audio; wired into ChatRepository.forget. */
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
	private fun playFile(k: String, team: String, at: Long, f: File) {
		runCatching { player?.release() }
		if (currentKey != null) clearNowPlaying()
		currentKey = k
		currentTeam = team
		currentAt = at
		player = MediaPlayer().apply {
			setAudioAttributes(
				AudioAttributes.Builder()
					.setUsage(AudioAttributes.USAGE_MEDIA)
					.setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
					.build(),
			)
			setDataSource(f.absolutePath)
			setOnCompletionListener {
				runCatching { it.release() }
				if (currentKey == k) {
					player = null
					clearNowPlaying()
				}
			}
			setOnErrorListener { mp, what, extra ->
				Log.w(TAG, "playback $k error what=$what extra=$extra")
				runCatching { mp.release() }
				if (currentKey == k) {
					player = null
					clearNowPlaying()
				}
				true
			}
			prepare()
			start()
		}
		onPlayingChanged?.invoke(team, at, true)
	}

	// Provider PATH and voice ride the key so a settings change can never replay
	// another voice's cached audio: distinct voices land in distinct files. The
	// path (not the descriptor id) is the cache component so entries survive an
	// id rename, and it matches the pre-descriptor key layout.
	private fun key(team: String, at: Long, tier: Tier, provider: SttsProvider, voice: String?): String =
		"$team/$at-${tier.suffix}-${provider.path}-${safeVoice(voice)}"

	private fun cacheFile(team: String, at: Long, tier: Tier, provider: SttsProvider, voice: String?): File =
		File(File(root, "stts/$team"), "$at-${tier.suffix}-${provider.path}-${safeVoice(voice)}.audio")

	private fun safeVoice(voice: String?): String =
		(voice ?: "default").replace(Regex("[^A-Za-z0-9_-]"), "_").take(48)

	companion object {
		private const val TAG = "SttsPlayer"

		/** The text a tier speaks. Summary prefers the addressable tiers; full
		 * is the sanitized body. */
		fun ttsText(m: Message, tier: Tier): String = when (tier) {
			Tier.SUMMARY -> m.summary ?: m.title ?: sanitize(m.text)
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
