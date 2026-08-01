package com.atelier_nyaarium.switchboard

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.audiofx.LoudnessEnhancer
import android.util.Log
import com.atelier_nyaarium.switchboard.proto.SttsProvider
import java.io.File
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
 * Single-flight per entry, so impatient taps cannot fire a second request. A tap CANCELS only what is
 * audible: nothing on screen distinguishes a message that is still synthesizing, so cancelling one
 * would read as a dead button.
 *
 * [PlaybackRequests] owns which entry is claimed, which is sounding, and the delivery of every event;
 * this class owns only the effects. Synthesis, playback, control and event delivery each get their own
 * lane, so a blocking fetch can never hold up a cancel, a cached playback, or an event.
 */
class SttsPlayer(private val root: File) {
	enum class Tier(val suffix: String) { FULL("full"), SUMMARY("summary"), TITLE("title") }

	/** Why a playback ended. A queue advances on COMPLETED, PREEMPTED and the two errors, but not
	 * on STOPPED, so these cannot collapse back into a single "ended" signal: a file that fails to
	 * DECODE would then pop an entry as though it had been heard, and the retry would never fire. */
	enum class Outcome { COMPLETED, STOPPED, PREEMPTED, PLAYBACK_ERROR, SYNTH_ERROR }

	/** Carries the (team, at, tier) it belongs to, so a consumer can attribute an outcome to the
	 * entry that caused it. `tier` is null only for the settings voice sample, which is not a
	 * message. `gen` names the REQUEST: minting and publishing are not one step, so a terminal can be
	 * delivered after the Started of the request that replaced it, and without a generation a
	 * consumer cannot tell that apart from its own request ending. */
	sealed interface Event {
		val team: String
		val at: Long
		val tier: Tier?
		val gen: Long

		data class Started(
			override val team: String,
			override val at: Long,
			override val tier: Tier?,
			override val gen: Long,
		) : Event

		data class Ended(
			override val team: String,
			override val at: Long,
			override val tier: Tier?,
			override val gen: Long,
			val outcome: Outcome,
			val reason: String? = null,
		) : Event
	}

	fun interface Listener {
		fun onPlaybackEvent(event: Event)
	}

	// Separate lanes: SttsClient blocks for up to 80s, and a stalled synth must never hold up a
	// playback whose audio is already cached.
	private val synthExec = Executors.newSingleThreadExecutor { r -> Thread(r, "stts-synth").apply { isDaemon = true } }
	private val playExec = Executors.newSingleThreadExecutor { r -> Thread(r, "stts-play").apply { isDaemon = true } }
	private val eventExec = Executors.newSingleThreadExecutor { r -> Thread(r, "stts-events").apply { isDaemon = true } }
	// Control work gets a lane that blocking synthesis can never occupy. Sharing one meant a tap that
	// should supersede an in-flight preview sat behind the very fetch it was trying to cancel.
	private val controlExec = Executors.newSingleThreadExecutor { r -> Thread(r, "stts-ctl").apply { isDaemon = true } }
	// The request lifecycle lives in its own pure unit so its invariants can be tested without a
	// MediaPlayer, and it delivers its own events so their order is its transition order. This class
	// owns only the playback effects and lends it the lane to deliver on.
	private val requests = PlaybackRequests(eventExec)

	@Volatile private var player: MediaPlayer? = null
	@Volatile private var loudness: LoudnessEnhancer? = null

	// Which request the current player belongs to. A drop decides under the registry's lock and
	// releases under this class's, and a newer request can take the sound in between; without an owner
	// to check against, that release kills the newcomer's player and strands it with no terminal.
	private var playerOwner: PlaybackId? = null


	/** Every listener sees every event, on whichever thread it occurred. Playback that continues in the
	 * background keeps its signal even when a UI listener unsubscribes. */
	fun addListener(listener: Listener): Listener = requests.addListener(listener)

	fun removeListener(listener: Listener) = requests.removeListener(listener)

	/** Run the one effect a drop implies. The registry already published the events under its own
	 * monitor; this releases the player the drop actually took, on the play lane so a MediaPlayer
	 * callback arriving on the main Looper never blocks there. */
	private fun apply(drop: PlaybackDrop) {
		drop.soundingEnded?.let { id -> playExec.execute { releasePlayerOf(id) } }
	}

	/** Whether anything at all is audible right now, whoever owns it. */
	fun isSounding(): Boolean = requests.isSounding()

	/** Whether this message is audible, in any tier. What the row shows, and so what its button may
	 * toggle on; [PlaybackRequests.isSoundingForMessage] says why it is not the claim. */
	fun isPlayingMessage(team: String, at: Long): Boolean = requests.isSoundingForMessage(team, at)

	/** Run work on the player's daemon thread. Lets callers move credential
	 * loading and message resolution off their own thread (a broadcast
	 * receiver's main thread must hold zero disk or crypto work). */
	fun post(action: () -> Unit) {
		controlExec.execute(action)
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
		/** Stand down rather than interrupt, if something else has taken the sound by the time this is
		 * ready. Autoplay sets it; a request the user made never does. */
		yielding: Boolean = false,
	): Boolean {
		// Toggle on what the user can see. A tap while this is still synthesizing is NOT a cancel: the
		// row shows nothing yet, so cancelling would read as a dead button, and single-flight already
		// refuses the duplicate claim below.
		// True here too: the toggle already REPORTED this entry's outcome, so a caller waiting on one
		// has had it. Returning false would have it invent a second terminal for the same request.
		if (stopSounding(team, at, tier)) return true
		if (text.isBlank()) return false
		// Whether this entry's outcome will be reported. A caller driving a queue has to know the
		// difference from "declined, silently", which is a terminal that never arrives.
		val audio = cacheFile(team, at, tier, provider, voice, text)
		return synthesizeAndPlay(team, at, tier, audio, volumePct, yielding) { dest ->
			client.stream(provider, text, voice, dest)
		}
	}

	/** Voice preview for the settings screen: synthesizes through the cheaper
	 * sample endpoint (stream for providers without one) and plays. Cached per
	 * provider+voice under the reserved "_sample" team, purged with clearAll. */
	fun playSample(client: SttsClient, provider: SttsProvider, voice: String?, text: String, volumePct: Int = 100) {
		// Each voice is its own entry, so Test toggles the voice you pressed rather than whatever
		// happens to be audible. Toggling on sound, like the message button: the screen shows no
		// spinner, so a tap during synthesis must not cancel audio the user is still waiting for.
		val voiceAt = sampleAt(provider, voice)
		if (stopSounding(SAMPLE_TEAM, voiceAt, null)) return
		// Picking a different voice supersedes instead of just stopping; this voice is left alone so a
		// second tap on it falls through to single-flight rather than paying for a second synthesis.
		apply(requests.finishTeamExcept(SAMPLE_TEAM, voiceAt, null, Outcome.PREEMPTED))
		val dest = File(File(root, "stts/$SAMPLE_TEAM"), "${provider.path}-${safeVoice(voice)}.audio")
		synthesizeAndPlay(SAMPLE_TEAM, voiceAt, null, dest, volumePct, yielding = false) { d ->
			client.sample(provider, text, voice, d)
		}
	}

	/**
	 * Speak a boundary marker: the words that announce who is about to talk. Its own request, so it
	 * gets one terminal and ordered delivery like anything else, and the caller chains the body behind
	 * that terminal rather than concatenating audio - providers differ in container, so one stream
	 * would mean re-encoding.
	 *
	 * Yields like the body it announces. Only the chime is exempt: it is instantaneous, so standing it
	 * down drops the boundary rather than delaying it. A sentinel is speech of the same length as any
	 * other, and one that talked over a person would be autoplay reaching around the yield rule.
	 */
	fun playMarker(
		client: SttsClient,
		provider: SttsProvider,
		voice: String?,
		text: String,
		volumePct: Int = 100,
		yielding: Boolean = true,
	): Long? {
		if (text.isBlank()) return null
		val at = markerAt(text, provider, voice)
		val dest = File(File(root, "stts/$MARKER_TEAM"), "$at-${provider.path}-${safeVoice(voice)}.audio")
		val started = synthesizeAndPlay(MARKER_TEAM, at, null, dest, volumePct, yielding) { d ->
			client.stream(provider, text, voice, d)
		}
		return at.takeIf { started }
	}

	/** Play the bundled or user-chosen chime. Takes a resolved local source rather than synthesizing,
	 * since the audio is an asset and not speech. */
	fun playChime(source: File, volumePct: Int = 100): Long? =
		CHIME_AT.takeIf { synthesizeAndPlay(MARKER_TEAM, CHIME_AT, null, source, volumePct, yielding = false) { } }

	/** Let a gap fall between two playbacks before running `then`. Silence between a marker and what
	 * it announces is what makes it read as a boundary rather than as part of the sentence; run
	 * back to back they blur into one utterance. */
	fun afterGap(then: () -> Unit) {
		playExec.execute {
			runCatching { Thread.sleep(MARKER_GAP_MS) }
			then()
		}
	}

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

	/** Remove what a preload wrote into a directory that a purge had already deleted. The parent goes
	 * only if it is now empty, so this cannot take a sibling message's cached audio with it. */
	private fun discardPreload(dest: File) {
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

	/** Shared synthesis path: single-flight on the key, atomic cache write,
	 * then playback. `fetch` writes the audio into the destination file. */
	private fun synthesizeAndPlay(
		team: String,
		at: Long,
		tier: Tier?,
		dest: File,
		volumePct: Int,
		yielding: Boolean,
		fetch: (File) -> Unit,
	): Boolean {
		val id = requests.claim(team, at, tier) ?: return false
		// A cache hit goes straight to the play lane. Left inside the synth lane it queued behind a
		// stalled fetch, which is the one thing the lane split exists to prevent.
		if (dest.isFile && dest.length() > 0L) {
			playExec.execute { playGuarded(id, dest, volumePct, yielding) }
			return true
		}
		synthExec.execute {
			try {
				if (!dest.exists() || dest.length() == 0L) {
					dest.parentFile?.mkdirs()
					val tmp = File(dest.parentFile, "${dest.name}.tmp")
					fetch(tmp)
					if (tmp.length() == 0L || !tmp.renameTo(dest)) {
						tmp.delete()
						error("synthesis returned no audio")
					}
					// A purge that landed while this was fetching already deleted the directory, and
					// the write above recreated it. Nothing else collects that, so undo it here.
					if (requests.isStale(id)) {
						discardPreload(dest)
						requests.finish(id, Outcome.PREEMPTED, "purged")
						return@execute
					}
				}
				// The id crosses the lane, so a hand-off that arrives after this request was abandoned
				// and the entry re-claimed drives nothing.
				playExec.execute { playGuarded(id, dest, volumePct, yielding) }
			} catch (e: Exception) {
				Log.w(TAG, "stts synth failed: ${e.message}")
				dest.delete()
				requests.finish(id, Outcome.SYNTH_ERROR, e.message ?: "synthesis failed")
			}
		}
		return true
	}


	/** Play on its own lane. `prepare` throws on a cached file that will not decode and
	 * `LoudnessEnhancer` throws on devices without the effect; neither reaches `setOnErrorListener`,
	 * so both are caught here rather than ending the request with no event at all. */
	private fun playGuarded(id: PlaybackId, dest: File, volumePct: Int, yielding: Boolean) {
		try {
			playFile(id, dest, volumePct, yielding)
		} catch (e: Exception) {
			Log.w(TAG, "playback failed: ${e.message}")
			dest.delete()
			apply(requests.finishRequest(id, Outcome.PLAYBACK_ERROR, e.message ?: "playback failed"))
		}
	}

	fun stop() = apply(requests.finishSounding(Outcome.STOPPED))

	/** Stop one message in whichever tier it is playing, sounding or still synthesizing. What the
	 * button asked about with [isPlayingMessage] is what this acts on. */
	fun stopMessage(team: String, at: Long) = apply(requests.finishMessage(team, at, Outcome.STOPPED))

	/** Stop whatever is sounding and report `outcome`. The queue has to tell "the user stopped this"
	 * apart from "something replaced it": only one of those advances. */
	fun stopWith(outcome: Outcome) = apply(requests.finishSounding(outcome))

	/** Stop ONE entry only while it is audible, and say whether it was. The check and the act are one
	 * registry operation, so a toggle cannot end whatever became audible in between - and STOPPED is
	 * the one outcome a queue does not advance on, so a mis-scoped stop would halt it on an entry
	 * nobody touched. */
	private fun stopSounding(team: String, at: Long, tier: Tier?): Boolean {
		val drop = requests.finishIfSounding(team, at, tier, Outcome.STOPPED)
		apply(drop)
		return drop.events.isNotEmpty()
	}

	/** Give up on one queue entry's audio: stop it if sounding, drop its claim so a synthesis still
	 * running cannot go on to play it, and report PREEMPTED now rather than when the uncancellable
	 * fetch finally returns. Tier-scoped, so abandoning one entry never preempts a sibling tier of
	 * the same message. */
	fun abandon(team: String, at: Long, tier: Tier?) = apply(requests.finishEntry(team, at, tier, Outcome.PREEMPTED))

	@Synchronized
	private fun teardownPlayer() {
		runCatching { loudness?.release() }
		loudness = null
		runCatching { player?.release() }
		player = null
		playerOwner = null
	}

	/** Release the player only while `id` still owns it. A newer request that took the sound in the
	 * gap owns it now, and releasing that one would leave a live request no path to a terminal. */
	@Synchronized
	private fun releasePlayerOf(id: PlaybackId) {
		if (playerOwner == id) teardownPlayer()
	}

	/** Delete a team's cached audio; wired into ChatRepository.forget. Under the dot grammar a
	 * team address ("domain.gateway.spawn.session") is a flat path segment with no slash, so it
	 * does not nest a subdir: the team string is the unique path, so two distinct sessions never
	 * share a cache dir. */
	fun purge(team: String) {
		// Every claimed request, not just the sounding one, so a synthesis still running cannot go on
		// to play a forgotten team. The delete below races that synthesis rather than ordering it: a
		// producer that writes afterwards finds itself stale and removes what it recreated.
		apply(requests.purgeTeam(team))
		File(root, "stts/$team").deleteRecursively()
	}

	/** Stop and delete the entire cache root; wired into ChatRepository.clearAll
	 * so the repository never reaches into the player's directory layout. */
	fun purgeAll() {
		apply(requests.purgeEverything())
		File(root, "stts").deleteRecursively()
	}

	/** Start `id` playing, or do nothing if it was abandoned before it reached the lane. Throws if
	 * MediaPlayer setup fails, having assigned nothing for the caller to unpick. */
	private fun playFile(id: PlaybackId, f: File, volumePct: Int, yielding: Boolean) {
		if (!requests.isLive(id)) return
		val (linear, gainMb) = volumeSteps(volumePct)
		// Built into a local and released by hand on failure: an object assigned only after `apply`
		// returns is unreachable if the block throws, which is precisely when it must be released.
		val mp = MediaPlayer()
		var effect: LoudnessEnhancer? = null
		try {
			mp.setAudioAttributes(
				AudioAttributes.Builder()
					.setUsage(AudioAttributes.USAGE_MEDIA)
					.setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
					.build(),
			)
			mp.setDataSource(f.absolutePath)
			mp.setVolume(linear, linear)
			// Scoped to this request, not to its entry: a callback that arrives after a re-claim must
			// report its own outcome and never end the generation that replaced it.
			mp.setOnCompletionListener { apply(requests.finishRequest(id, Outcome.COMPLETED)) }
			mp.setOnErrorListener { _, what, extra ->
				Log.w(TAG, "playback error what=$what extra=$extra")
				// A cached file that will not decode lands here, so it must not read as COMPLETED:
				// the entry would pop unheard and never retry.
				apply(requests.finishRequest(id, Outcome.PLAYBACK_ERROR, "playback failed ($what/$extra)"))
				true
			}
			mp.prepare()
			if (gainMb > 0) {
				// Assigned before it is configured: `apply` returns the object, so a throw inside the
				// block leaves nothing assigned and the catch below releases a null.
				val fx = LoudnessEnhancer(mp.audioSessionId)
				effect = fx
				fx.setTargetGain(gainMb)
				fx.enabled = true
			}
			mp.start()
		} catch (e: Exception) {
			runCatching { effect?.release() }
			runCatching { mp.release() }
			throw e
		}
		// Taking the sound displaces whatever held it, and the registry reports that terminal rather
		// than it vanishing. Null means this request was abandoned while the player was being built.
		val displaced = requests.sound(id, yielding)
		if (displaced == null) {
			runCatching { effect?.release() }
			runCatching { mp.release() }
			return
		}
		installPlayer(id, mp, effect)
		requests.started(id)
	}

	/** Swap in the player that just took the sound. The only part of playback that needs the monitor,
	 * so it is the only part that holds it: building and preparing a MediaPlayer is disk work and
	 * happens outside, where nothing else can be made to wait on it. */
	@Synchronized
	private fun installPlayer(id: PlaybackId, mp: MediaPlayer, effect: LoudnessEnhancer?) {
		teardownPlayer()
		player = mp
		loudness = effect
		playerOwner = id
	}

	/**
	 * Keyed on the spoken WORDS as well as the entry, the same way a marker is.
	 *
	 * One entry can be spoken more than one way - a message played by hand carries its own attribution
	 * while one inside a run does not, because a marker already said it. Without the text in the key,
	 * whichever variant synthesized first is served to both, and a cache hit never looks at the text it
	 * was asked for.
	 */
	private fun cacheFile(
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
	private fun sampleAt(provider: SttsProvider, voice: String?): Long =
		"${provider.path}-${safeVoice(voice)}".hashCode().toLong()

	/** A marker's entry key. Derived from the spoken WORDS, so every message from one session reuses a
	 * single synthesis instead of paying per message - and two sessions that happen to share a label
	 * share the audio, which is correct because the audio is the label. */
	private fun markerAt(text: String, provider: SttsProvider, voice: String?): Long =
		"$text|${provider.path}-${safeVoice(voice)}".hashCode().toLong()

	private fun safeVoice(voice: String?): String =
		(voice ?: "default").replace(Regex("[^A-Za-z0-9_-]"), "_").take(48)

	companion object {
		private const val TAG = "SttsPlayer"

		/** Reserved team for the settings voice preview, which is not a message. Lets a listener tell
		 * a preview's failure apart from a real entry's. */
		const val SAMPLE_TEAM = "_sample"

		/** Reserved team for boundary markers. Separate from a real thread so a marker is never a queue
		 * entry, never counts toward unread, and is swept by clearAll rather than by any one forget. */
		const val MARKER_TEAM = "_marker"

		/** The chime's fixed entry. One asset, so one key - unlike a sentinel, whose audio varies with
		 * the words it speaks. */
		const val CHIME_AT = 0L

		/** Silence between a boundary marker and what follows it. Long enough to hear as a pause,
		 * short enough that a run of short messages does not feel padded. */
		const val MARKER_GAP_MS = 350L

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

		/** The text a tier speaks. Agent replies and notices carry author-written spoken tiers
		 * (fullSpoken is the spoken copy of the body), so each tier is a plain null-coalesce -
		 * a tier field is null or non-blank by the Message model's invariant (`tierOrNull` at
		 * its construction boundaries). Only a TIERLESS row (a peer-mirrored ask, a user row)
		 * falls to its raw body, through the minimal strip below - such rows can be full
		 * markdown briefs, so fences and link targets must not be read aloud verbatim. */
		fun ttsText(m: Message, tier: Tier): String = when (tier) {
			Tier.SUMMARY -> m.summary ?: m.title ?: stripUnspeakable(m.text)
			Tier.TITLE -> m.title ?: m.summary ?: stripUnspeakable(m.text)
			Tier.FULL -> m.fullSpoken ?: m.summary ?: m.title ?: stripUnspeakable(m.text)
		}

		/** The tierless-row minimal strip: drop code/mermaid fences and FILES blocks, reduce
		 * links to their labels. Deliberately nothing more - an author-written spoken tier is
		 * the real fix for speakability, so this only removes the structures no voice can read. */
		fun stripUnspeakable(s: String): String = s
			.replace(Regex("```[\\s\\S]*?(```|$)"), " Code block omitted. ")
			.replace(Regex("\\[FILES[^\\]]*\\][\\s\\S]*?(?=\\n\\n|$)"), " Attachments omitted. ")
			.replace(Regex("\\[([^\\]]+)\\]\\([^)]*\\)"), "$1")
			.trim()
	}
}
