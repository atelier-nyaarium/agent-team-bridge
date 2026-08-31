package com.atelier_nyaarium.switchboard

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.audiofx.LoudnessEnhancer
import android.util.Log
import com.atelier_nyaarium.switchboard.proto.SttsProvider
import java.io.File
import java.util.concurrent.Executors

/**
 * Synthesis playback over a per-message audio cache. Owns the MediaPlayer; [SttsCache] owns where
 * each rendering is filed and what fills it, and SttsClient owns the wire.
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

	// Separate lanes: SttsClient blocks for up to 80s, and a stalled synth must never hold up a
	// playback whose audio is already cached.
	private val synthExec = Executors.newSingleThreadExecutor { r -> Thread(r, "stts-synth").apply { isDaemon = true } }

	// Warming runs WIDE, unlike every other lane here, because these are independent network fetches
	// with nothing ordered about them - the queue decides what is spoken next, not the order these
	// happen to finish in. Bounded at three: enough that a burst is ready before it is reached, few
	// enough not to open a fetch per message and have the provider rate-limit the whole run.
	private val warmExec = Executors.newFixedThreadPool(3) { r -> Thread(r, "stts-warm").apply { isDaemon = true } }
	private val playExec = Executors.newSingleThreadExecutor { r -> Thread(r, "stts-play").apply { isDaemon = true } }
	private val eventExec = Executors.newSingleThreadExecutor { r -> Thread(r, "stts-events").apply { isDaemon = true } }
	// Control work gets a lane that blocking synthesis can never occupy. Sharing one meant a tap that
	// should supersede an in-flight preview sat behind the very fetch it was trying to cancel.
	private val controlExec = Executors.newSingleThreadExecutor { r -> Thread(r, "stts-ctl").apply { isDaemon = true } }
	// The request lifecycle lives in its own pure unit so its invariants can be tested without a
	// MediaPlayer, and it delivers its own events so their order is its transition order. This class
	// owns only the playback effects and lends it the lane to deliver on.
	private val requests = PlaybackRequests(eventExec)

	// The cache half, over the same root. Takes `requests` and `warmExec`, so it is declared after both.
	val cache = SttsCache(root, requests, warmExec)

	@Volatile private var player: MediaPlayer? = null
	@Volatile private var loudness: LoudnessEnhancer? = null

	// Which request the current player belongs to. A drop decides under the registry's lock and
	// releases under this class's, and a newer request can take the sound in between; without an owner
	// to check against, that release kills the newcomer's player and strands it with no terminal.
	private var playerOwner: PlaybackId? = null

	// Which RECORDING the current player is in. One message is spoken two ways, so the owner alone
	// does not identify the audio a position points into.
	private var playerAudio: String? = null


	/** Every listener sees every event, on whichever thread it occurred. Playback that continues in the
	 * background keeps its signal even when a UI listener unsubscribes. */
	fun addListener(listener: Listener): Listener = requests.addListener(listener)

	fun removeListener(listener: Listener) = requests.removeListener(listener)

	/**
	 * Run the one effect a drop implies. The registry already published the events under its own
	 * monitor; this releases the player the drop actually took, on the play lane so a MediaPlayer
	 * callback arriving on the main Looper never blocks there.
	 *
	 * `remember` is the CALLER'S, and it has to be: an outcome cannot answer it. A pause, a skip, a
	 * trash and a genuine displacement all end as PREEMPTED, and two of those want the position kept
	 * while two want it gone - so inferring here silently resurrected the offset a skip had just
	 * deleted, on the play lane, one line after the delete. Identity is the engine's to supply and
	 * intent is the caller's to declare; neither substitutes for the other.
	 */
	private fun apply(drop: PlaybackDrop, remember: Boolean = false) {
		drop.soundingEnded?.let { id -> playExec.execute { releasePlayerOf(id, remember) } }
	}

	/** Give up one request named by the generation its terminal would carry. Never resumable: this is
	 * only ever a marker, and a boundary that starts halfway is worse than one that repeats. */
	fun abandonGeneration(gen: Long) = apply(requests.finishGeneration(gen, Outcome.PREEMPTED))

	/** Whether anything at all is audible right now, whoever owns it. */
	fun isSounding(): Boolean = requests.isSounding()

	/**
	 * Where the audible playback is, how long it is, and WHICH request it belongs to. Null when
	 * nothing is playing.
	 *
	 * A SNAPSHOT taken on the play lane's behalf, read under the same monitor that installs and
	 * releases the player - a caller polling `player` directly would be reading a handle that can be
	 * released between its null check and its call, which is a native crash rather than a wrong number.
	 *
	 * It NAMES its request. "Whatever is audible" is not an answer any caller can use: at the head of
	 * every run the audible thing is a boundary marker while the queue's head is already the body, so a
	 * position attributed by asking the queue instead of asking the player belongs to the wrong sound.
	 */
	@Synchronized
	fun positionSnapshot(): Position? {
		val mp = player ?: return null
		val owner = playerOwner ?: return null
		val audio = playerAudio ?: return null
		return runCatching {
			Position(owner, audio, mp.currentPosition.toLong(), mp.duration.toLong())
		}.getOrNull()
	}

	/** Move a NAMED playback. Ignored unless that request still owns the sound, so a bar built from a
	 * snapshot that has since been replaced cannot seek into whatever started after it. */
	@Synchronized
	fun seekTo(owner: PlaybackId, ms: Long) {
		if (playerOwner != owner) return
		runCatching { player?.seekTo(ms.toInt()) }
	}

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
		rowKey: String = at.toString(),
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
		val audio = cache.cacheFile(team, at, tier, provider, voice, text, rowKey)
		return null != synthesizeAndPlay(team, at, tier, audio, volumePct, yielding) { dest ->
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
		val voiceAt = cache.sampleAt(provider, voice)
		if (stopSounding(SAMPLE_TEAM, voiceAt, null)) return
		// Picking a different voice supersedes instead of just stopping; this voice is left alone so a
		// second tap on it falls through to single-flight rather than paying for a second synthesis.
		apply(requests.finishTeamExcept(SAMPLE_TEAM, voiceAt, null, Outcome.PREEMPTED))
		val dest = File(File(root, "stts/$SAMPLE_TEAM"), "${provider.path}-${cache.safeVoice(voice)}.audio")
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
		val at = cache.markerAt(text, provider, voice)
		val dest = File(File(root, "stts/$MARKER_TEAM"), "$at-${provider.path}-${cache.safeVoice(voice)}.audio")
		// Returns the request's GENERATION, not its entry key. The key is derived from the spoken words
		// so one session's sentinel is synthesized once and reused - which means two runs of the same
		// session share it, and a terminal keyed on it cannot say WHICH run it belongs to.
		return synthesizeAndPlay(MARKER_TEAM, at, null, dest, volumePct, yielding) { d ->
			client.stream(provider, text, voice, d)
		}
	}

	/** Play the bundled or user-chosen chime. Takes a resolved local source rather than synthesizing,
	 * since the audio is an asset and not speech. */
	fun playChime(source: File, volumePct: Int = 100): Long? =
		synthesizeAndPlay(MARKER_TEAM, CHIME_AT, null, source, volumePct, yielding = false) { }

	/** Let a gap fall between two playbacks before running `then`. Silence between a marker and what
	 * it announces is what makes it read as a boundary rather than as part of the sentence; run
	 * back to back they blur into one utterance. */
	fun afterGap(then: () -> Unit) {
		playExec.execute {
			runCatching { Thread.sleep(MARKER_GAP_MS) }
			then()
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
	): Long? {
		val id = requests.claim(team, at, tier) ?: return null
		// A cache hit goes straight to the play lane. Left inside the synth lane it queued behind a
		// stalled fetch, which is the one thing the lane split exists to prevent.
		if (dest.isFile && dest.length() > 0L) {
			playExec.execute { playGuarded(id, dest, volumePct, yielding) }
			return id.gen
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
						cache.discardPreload(dest)
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
		return id.gen
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
	fun abandon(team: String, at: Long, tier: Tier?, remember: Boolean) =
		apply(requests.finishEntry(team, at, tier, Outcome.PREEMPTED), remember)

	@Synchronized
	private fun teardownPlayer() {
		runCatching { loudness?.release() }
		loudness = null
		runCatching { player?.release() }
		player = null
		playerOwner = null
		playerAudio = null
	}

	/**
	 * Release the player only while `id` still owns it. A newer request that took the sound in the
	 * gap owns it now, and releasing that one would leave a live request no path to a terminal.
	 *
	 * `remember` files where it got to first. The caller decides that; this decides WHOSE position it
	 * is, which is the half a caller cannot see.
	 */
	@Synchronized
	private fun releasePlayerOf(id: PlaybackId, remember: Boolean = false) {
		if (playerOwner != id) return
		if (remember) rememberWhereItGotTo()
		teardownPlayer()
	}

	/** File the sounding position, unless the sound is not the kind of thing anyone resumes. */
	@Synchronized
	private fun rememberWhereItGotTo() {
		val id = playerOwner ?: return
		if (!isResumable(id)) return
		positionSnapshot()?.let { rememberPosition(it) }
	}

	/**
	 * Whether a request is the kind of sound worth resuming.
	 *
	 * Markers and the settings sample are not. A marker's cache key is its WORDS, so one is shared by
	 * every run of a session - an offset left on one truncates the announcement of every later run,
	 * for good. And neither is a message: there is no row to come back to and nothing a user could
	 * point at to say "start that again".
	 */
	private fun isResumable(id: PlaybackId): Boolean = id.team != MARKER_TEAM && id.tier != null

	/** Delete a team's cached audio; wired into SessionOps.forget. Under the dot grammar a
	 * team address ("domain.gateway.spawn.session") is a flat path segment with no slash, so it
	 * does not nest a subdir: the team string is the unique path, so two distinct sessions never
	 * share a cache dir. */
	fun purge(team: String) {
		// Every claimed request, not just the sounding one, so a synthesis still running cannot go on
		// to play a forgotten team. The delete below races that synthesis rather than ordering it: a
		// producer that writes afterwards finds itself stale and removes what it recreated.
		apply(requests.purgeTeam(team))
		// The offsets go with the audio. A remembered position points INTO a file that is about to be
		// deleted, so leaving it behind would seek freshly re-synthesized speech to where the copy that
		// no longer exists happened to be paused. A measured duration describes that same deleted file.
		resumeAt.keys.removeAll { it.entry.team == team }
		cache.warmedMs.keys.removeAll { it.team == team }
		File(root, "stts/$team").deleteRecursively()
	}

	/** Stop and delete the entire cache root; wired into ChatRepository.clearAll
	 * so the repository never reaches into the player's directory layout. */
	fun purgeAll() {
		apply(requests.purgeEverything())
		resumeAt.clear()
		cache.warmedMs.clear()
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
		// The request that just lost the sound did not ASK to stop - something else took it - so keep
		// where it got to. Taken here because `installPlayer` tears that player down on the next line,
		// and because this path never goes through `apply`: the registry publishes the displaced
		// terminal from inside `sound()`, so nothing else runs an effect for it - this is the ordinary
		// way a run is interrupted, and the only place a displaced run's position gets recorded.
		if (displaced.soundingEnded != null) rememberWhereItGotTo()
		installPlayer(id, mp, effect, f)
		// Resume where it stopped. Keyed on THIS recording, so the offset a hand-played (attributed)
		// rendering left behind is not handed to the unattributed one a run speaks, which is a
		// different file of a different length. Consumed on use, so it can never outlive its pause.
		resumeAt.remove(ResumeKey(QueueEntry(id.team, id.at, id.tier), f.name))
			?.let { runCatching { mp.seekTo(it.toInt()) } }
		requests.started(id)
	}

	/** Where a paused playback should pick up. Held here rather than on the queue because it describes
	 * audio, and the queue deliberately knows nothing about audio. */
	private val resumeAt = java.util.concurrent.ConcurrentHashMap<ResumeKey, Long>()

	/**
	 * Remember where a playback was when it stopped, so resuming continues rather than restarts.
	 *
	 * Takes the SNAPSHOT, not loose numbers, and files under the message AND the recording the
	 * snapshot names. A caller that could pass a position and a key separately is a caller that can
	 * pair a boundary marker's position with the body's key, which cuts the opening off the message -
	 * or, when the marker runs longer than the body, seeks past its end so it retires as heard without
	 * ever being spoken.
	 */
	fun rememberPosition(position: Position) {
		if (position.positionMs > 0) resumeAt[position.key] = position.positionMs
	}

	/** Forget every recording of one message. Coarse ON PURPOSE: giving up on a message gives up on it
	 * however it would have been spoken. */
	fun forgetPosition(team: String, at: Long, tier: Tier?) {
		val entry = QueueEntry(team, at, tier)
		resumeAt.keys.removeAll { it.entry == entry }
	}

	/**
	 * Forget every offset a team holds, without touching its cached audio.
	 *
	 * What a teardown needs, and it cannot be done message by message: a pause parks its entry in the
	 * queue's pending list, so the one message that actually holds an offset is never the head - and
	 * the head is the only thing a teardown is handed. Closing a paused thread therefore left a live
	 * resume point behind, waiting to seek whatever played next if the tab was ever reopened.
	 */
	fun forgetTeamPositions(team: String) {
		resumeAt.keys.removeAll { it.entry.team == team }
	}

	/** Where a message would pick up if it started now, across whichever recording holds an offset.
	 * What a paused sheet shows: the position exists, so leaving the timeline blank hides the one
	 * thing a pause is for. */
	fun heldPosition(team: String, at: Long, tier: Tier?): Long? {
		val entry = QueueEntry(team, at, tier)
		return resumeAt.entries.firstOrNull { it.key.entry == entry }?.value
	}

	/** Swap in the player that just took the sound. The only part of playback that needs the monitor,
	 * so it is the only part that holds it: building and preparing a MediaPlayer is disk work and
	 * happens outside, where nothing else can be made to wait on it. */
	@Synchronized
	private fun installPlayer(id: PlaybackId, mp: MediaPlayer, effect: LoudnessEnhancer?, source: File) {
		teardownPlayer()
		playerAudio = source.name
		player = mp
		loudness = effect
		playerOwner = id
	}

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
			.replace(Regex("(?m)^```[^\\r\\n]*(?:\\r?\\n|$)[\\s\\S]*?(?:^```[ \\t]*\\r?$|\\z)"), " Code block omitted. ")
			.replace(Regex("\\[FILES[^\\]]*\\][\\s\\S]*?(?=\\n\\n|$)"), " Attachments omitted. ")
			.replace(Regex("\\[([^\\]]+)\\]\\([^)]*\\)"), "$1")
			.trim()
	}
}
