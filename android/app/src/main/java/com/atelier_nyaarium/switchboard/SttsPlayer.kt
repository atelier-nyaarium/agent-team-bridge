package com.atelier_nyaarium.switchboard

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Log
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
		provider: SttsClient.Provider,
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
		if (text.isBlank() || !inFlight.add(k)) return
		exec.execute {
			val dest = cacheFile(team, at, tier, provider, voice)
			try {
				if (!dest.exists() || dest.length() == 0L) {
					dest.parentFile?.mkdirs()
					val tmp = File(dest.parentFile, "${dest.name}.tmp")
					client.stream(provider, text, voice, tmp)
					if (tmp.length() == 0L || !tmp.renameTo(dest)) {
						tmp.delete()
						error("synthesis returned no audio")
					}
				}
				playFile(k, dest)
			} catch (e: Exception) {
				Log.w(TAG, "stts $k failed: ${e.message}")
				dest.delete()
			} finally {
				inFlight.remove(k)
			}
		}
	}

	@Synchronized
	fun stop() {
		runCatching { player?.release() }
		player = null
		currentKey = null
	}

	/** Delete a team's cached audio; wired into ChatRepository.forget. */
	fun purge(team: String) {
		if (currentKey?.startsWith("$team/") == true) stop()
		File(root, "stts/$team").deleteRecursively()
	}

	@Synchronized
	private fun playFile(k: String, f: File) {
		runCatching { player?.release() }
		currentKey = k
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
					currentKey = null
				}
			}
			setOnErrorListener { mp, what, extra ->
				Log.w(TAG, "playback $k error what=$what extra=$extra")
				runCatching { mp.release() }
				if (currentKey == k) {
					player = null
					currentKey = null
				}
				true
			}
			prepare()
			start()
		}
	}

	// Provider and voice ride the key so a settings change can never replay
	// another voice's cached audio: distinct voices land in distinct files.
	private fun key(team: String, at: Long, tier: Tier, provider: SttsClient.Provider, voice: String?): String =
		"$team/$at-${tier.suffix}-${provider.path}-${safeVoice(voice)}"

	private fun cacheFile(team: String, at: Long, tier: Tier, provider: SttsClient.Provider, voice: String?): File =
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
