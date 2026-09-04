package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SttsProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal interface PlaybackPort {
	val stts: SttsPlayer
	fun sttsClient(): SttsClient?
	fun currentProvider(): SttsProvider?
	fun sttsVoiceFor(providerId: String): String
	val sttsVolume: Int
	val sttsChimeVolume: Int
	val sttsAutoPlay: String
	fun sttsReady(): Boolean
}

internal interface PlaybackOpsCollaborators {
	fun openThread(team: String): String
}

/** The playback surface: the autoplay queue, the chime/sentinel marker sequence in front of it, and
 * every transport control a UI surface drives either one with. PlaybackOps is the single owner of the
 * whole playback serialization boundary - the queue, its advance mutex, and every piece of state that
 * boundary protects. What a surface only READS is answered by [PlaybackReadModels], which takes no
 * lock because it mutates nothing; the queries below forward to it. */
internal class PlaybackOps(
	private val state: MutableStateFlow<ChatState>,
	private val repoScope: CoroutineScope,
	private val playback: PlaybackPort,
	private val collaborators: PlaybackOpsCollaborators,
) : ClearsOnReprovision {
	/** What autoplay still has to speak. This class owns it and advances it; [SttsPlayer] stays a
	 * one-shot engine that knows nothing about what comes next. */
	private val queue = PlaybackQueue()

	/** Serializes every advance. A player terminal and a user gesture can arrive together, and both
	 * read the head before mutating it; `scheduledSendFireMutex` guards the same shape for sends. */
	private val advanceMutex = Mutex()

	private val reads = PlaybackReadModels(state, playback, queue) { transportPaused }

	// The queue advances off terminals, so it subscribes for the process's lifetime rather than with a
	// screen: a backgrounded burst has no UI listening and must still walk forward.
	init {
		playback.stts.addListener { event ->
			if (event is Event.Ended) {
				val entry = QueueEntry(event.team, event.at, event.tier)
				// `gen` is carried, not dropped: it is the only field that says WHICH request ended,
				// and a marker's entry key is shared by every run of the same session.
				repoScope.launch { onPlaybackEnded(entry, event.outcome, event.gen, event.reason) }
			}
		}
	}

	/**
	 * Speak one message tier. The whole resolution (credential decrypt, message lookup, text prep)
	 * hops to the player's control lane so a broadcast receiver's main thread does zero disk or crypto
	 * work. Cache and single-flight live in SttsPlayer. No-op when unconfigured or the message is gone.
	 */
	fun playMessage(team: String, at: Long, tier: SttsPlayer.Tier) {
		playback.stts.post { startPlayback(team, at, tier) }
	}

	/** Null when the engine TOOK this message, which is the same as a terminal now being owed for it.
	 * Every give-up names its reason rather than returning silently, because a queue waiting on a
	 * terminal that will never come waits forever. */
	private fun startPlayback(
		team: String,
		at: Long,
		tier: SttsPlayer.Tier,
		yielding: Boolean = false,
		// A run announces its speaker with a sentinel; a message played by hand carries its own
		// attribution instead.
		attributed: Boolean = true,
		// Null when it started; otherwise WHY: one of four causes (no key, no provider, a gone
		// message, an unspeakable row), each named so the alert is never left with only a generic
		// failure.
	): String? {
		val client = playback.sttsClient() ?: return "no voice key set"
		val provider = playback.currentProvider() ?: return "no voice provider set"
		val msg = state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe }
			?: return "message is no longer here"
		val text = ttsTextFramed(state.value, msg, tier, attributed)
		if (text.isBlank()) return "nothing to read aloud"
		val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		val taken = playback.stts.play(client, provider, voice, team, at, tier, text, playback.sttsVolume, yielding, "${msg.epoch}-${msg.seq}")
		return if (taken) null else "already speaking"
	}

	fun playStatesFor(team: String): Map<Long, String> = reads.playStatesFor(team)

	fun isMessagePlaying(team: String, at: Long): Boolean = playback.stts.isPlayingMessage(team, at)

	fun stopMessage(team: String, at: Long) = playback.stts.stopMessage(team, at)

	/** Advances on a terminal like the queue, not through a second mechanism. Held here, not on
	 * [QueueEntry]: what an entry consists of is not the queue's business. */
	private val pendingMarkers = ArrayDeque<Marker>()

	/** The entry [pendingMarkers] were staged for. A marker announces a specific session, so a queue
	 * that moved on while one was in flight must not let the leftovers introduce the wrong one. */
	private var markersFor: QueueEntry? = null

	/** The entry a pause parked, which its markers already introduced. A resume speaks the body
	 * rather than naming the session again: the transport's play button is not a new run, and
	 * re-announcing on every tap is what it sounded like. Cleared by the next start, so a fresh tap
	 * on the same message later still gets its sentinel. */
	private var parkedAnnounced: QueueEntry? = null

	/** The marker handed to the engine, by its own entry key. CLAIMED rather than sounding: a marker
	 * spends its whole synthesis owning nothing audible, and a teardown in that window still has to
	 * reach it. A terminal that does not match belongs to a run that has already ended. */
	private var markerInFlight: Long? = null

	private sealed interface Marker {
		data object Chime : Marker

		data class Spoken(val text: String) : Marker
	}

	/** Queues one message, speaking it if idle. `announceRun` is false for a tap: the chime marks an
	 * unprompted run, but the sentinel still plays since a tap alone does not say which session speaks. */
	suspend fun enqueueForPlay(
		team: String,
		at: Long,
		tier: SttsPlayer.Tier,
		announceRun: Boolean,
		// Autoplay only speaks followed threads. A person asking for a specific message has already
		// decided, and a notification can name a thread that is not open - refusing there would be a
		// button that does nothing and says nothing.
		requireFollowed: Boolean = true,
	) {
		val entry = QueueEntry(team, at, tier)
		advanceMutex.withLock {
			// Re-checked under the lock, not just at the drain. A burst job runs on its own coroutine
			// and can land after a close or forget has already swept this team, putting an entry back
			// into a queue the teardown believed it had emptied.
			if (requireFollowed && team !in state.value.openTabs) return
			// Asked BEFORE the enqueue: mid-run the queue is never idle, so the chime marks the run
			// rather than every message in it.
			val beginsRun = queue.isIdle()
			if (!queue.enqueue(entry)) return
			if (beginsRun) queueMarkers(entry, chime = announceRun)
			resumeIfSilent()
		}
		transportChanged()
	}

	/** Stage the markers that precede one entry's body. A manual tap never chimes; it is not a run. */
	private fun queueMarkers(entry: QueueEntry, chime: Boolean) {
		pendingMarkers.clear()
		markersFor = entry
		if (chime) pendingMarkers.addLast(Marker.Chime)
		val msg = state.value.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe } ?: return
		pendingMarkers.addLast(Marker.Spoken(sentinelText(state.value, msg, entry.team)))
	}

	private fun clearMarkers() {
		pendingMarkers.clear()
		markersFor = null
		markerInFlight = null
	}

	/** Play the next owed marker, or report that the body may now speak. Records WHICH marker is in
	 * flight, so a terminal can be matched to it: without that, a marker from a run that has already
	 * been torn down drives the current run's sequence and swallows its message. */
	private fun nextMarkerStarted(): Boolean {
		while (pendingMarkers.isNotEmpty()) {
			val started = when (val marker = pendingMarkers.removeFirst()) {
				is Marker.Chime -> chimeSource?.invoke()?.let { playback.stts.playChime(it, playback.sttsChimeVolume) }
				is Marker.Spoken -> speakMarker(marker.text)
			}
			// A marker that will not play is skipped rather than allowed to stall the body behind it:
			// losing a boundary is a smaller harm than losing the message.
			if (started != null) {
				markerInFlight = started
				return true
			}
		}
		markerInFlight = null
		return false
	}

	private fun speakMarker(text: String): Long? {
		val client = playback.sttsClient() ?: return null
		val provider = playback.currentProvider() ?: return null
		val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		return playback.stts.playMarker(client, provider, voice, text, playback.sttsVolume)
	}

	/** Set by the app layer: this class deliberately holds no Context, the same seam the alarm
	 * scheduler uses. A marker that cannot load must not hold up the message behind it. */
	@Volatile
	var chimeSource: (() -> File?)? = null

	/** Retire the entry that just ended and speak whatever follows. Every terminal routes here, so the
	 * outcome alone decides whether the queue moves: a decode failure must not retire an entry as
	 * though it had been heard, and a user stop must not walk forward. `gen` names the request that
	 * ended; zero means a terminal this class synthesized because the engine declined the entry, which
	 * is never a marker, and real generations start at one so they cannot collide. */
	private suspend fun onPlaybackEnded(
		entry: QueueEntry,
		outcome: SttsPlayer.Outcome,
		gen: Long = 0L,
		reason: String? = null,
	) {
		try {
			advanceEnded(entry, outcome, gen, reason)
		} finally {
			// After the advance, not on the event: the queue is only correct once this has run.
			transportChanged()
		}
	}

	private suspend fun advanceEnded(entry: QueueEntry, outcome: SttsPlayer.Outcome, gen: Long, reason: String?) {
		advanceMutex.withLock {
			// A marker finishing means the sequence moves on, never that the queue does: the body it
			// precedes has not been spoken yet, and advancing here would skip the message entirely.
			if (entry.team == SttsPlayer.MARKER_TEAM) {
				// Matched to the marker that was actually started. A terminal from a torn-down run
				// otherwise looks indistinguishable from this run's own, and drives it a step forward
				// while its message has not been spoken.
				if (gen != markerInFlight) return
				markerInFlight = null
				val head = queue.playing()
				// The run these markers belonged to is gone, either torn down or moved on. Nothing else
				// will report a terminal for it, so drop the leftovers and pick the queue back up
				// rather than leaving the backlog waiting on a message that may never arrive.
				if (head == null || markersFor != head) {
					clearMarkers()
					resumeIfSilent()
					return
				}
				// Gapped, so each marker reads as a boundary rather than running into what follows. The
				// owner is captured HERE, not re-read when the gap expires: by then the run may have
				// been torn down and a new one staged, and a stale callback that re-bound to whatever
				// was current would drive the new entry's sequence and drop its body unspoken.
				val owner = head
				playback.stts.afterGap {
					repoScope.launch {
						advanceMutex.withLock {
							if (markersFor != owner || queue.playing() != owner) return@withLock
							if (nextMarkerStarted()) return@withLock
							clearMarkers()
							speakBody(owner)
						}
					}
				}
				return
			}
			val step = queue.advance(entry, outcome, reason)
			step.failed?.let { DebugLog.log("Stts", "giving up on ${it.team} @${it.at} after a retry") }
			if (step.next != null) {
				// Spoken unconditionally. `advance` has already installed this as the head, so refusing
				// here would strand an entry the engine was never given and no terminal will ever
				// retire. It is safe to hand over even while the user is listening to something else:
				// the request yields at the player and reports its own terminal.
				speak(step.next)
				return
			}
			// The head just gave the sound to something else. An empty head reads exactly like an idle
			// queue, so without this the resume below would speak straight over what displaced it.
			if (step.standDown) return
			// A terminal for something the queue does not own. If that freed the sound, pick the run
			// back up rather than stalling until the next message arrives.
			resumeIfSilent()
		}
	}

	/** Drop everything queued for a team and stop it if it was the one speaking. Ordered drop-then-stop
	 * on purpose: the stop's own terminal would otherwise advance into an entry this same call is
	 * removing. Cache deletion is a separate step, so closing a tab the user may reopen keeps its audio. */
	suspend fun dropQueuedFor(team: String) {
		advanceMutex.withLock {
			// Tearing the thread down is not a pause. Swept across the whole TEAM rather than the entry
			// handed back: a pause parks its message in pending, so the one entry that actually holds an
			// offset is never the head, and the head is all a teardown is told about.
			queue.dropTeam(team)?.let { playback.stts.abandon(it.team, it.at, it.tier, remember = false) }
			playback.stts.forgetTeamPositions(team)
			// A marker lives under its own reserved team, so dropping the message's team cannot reach
			// one already handed to the engine. Abandoned by its own identity rather than by stopping
			// whatever is audible: the marker may still be synthesizing and hold no sound yet, and
			// what IS audible may belong to a team nobody asked to silence.
			if (markersFor?.team == team) {
				markerInFlight?.let { playback.stts.abandonGeneration(it) }
				clearMarkers()
			}
			resumeIfSilent()
		}
		// A teardown changes what there is to show as surely as a terminal does. Without this, closing
		// a thread mid-run left the lockscreen holding a transport for a run that no longer exists.
		transportChanged()
	}

	/** A wipe empties the run. The queue names the previous owner's messages and every transport
	 * surface draws it, and none of that is reachable through [dropQueuedFor], which is keyed by team.
	 * The engine is silenced separately by `stts.purgeAll()` in the same wipe; a terminal it then
	 * reports for a dropped entry is matched by generation and ignored, as a torn-down run's already is. */
	override suspend fun clearInMemory() {
		advanceMutex.withLock {
			queue.clear()
			clearMarkers()
			// Or the next owner's entry with the same team, timestamp and tier reads as a resume and
			// plays with no sentinel in front of it.
			parkedAnnounced = null
			pausedFlag = false
		}
		transportChanged()
	}

	/**
	 * Whether the run is held. Distinct from an empty queue: paused means there is something to come
	 * back to, which is why nothing auto-resumes past it. Read through an accessor that CANNOT report
	 * a pause over an idle queue.
	 *
	 * A pause describes a run, so it cannot outlive one, and a run can end without passing through any
	 * particular writer (a thread torn down, an entry trashed, the last entry skipped). Normalizing at
	 * the writers therefore cannot hold: each new way to empty the queue strands the flag again, and a
	 * stranded flag refuses autoplay on every team with no enabled control left on screen to clear it.
	 *
	 * Normalizing in the GETTER makes the bad state unobservable rather than merely unreached, so a new
	 * way to empty the queue cannot reintroduce it.
	 */
	@Volatile
	private var pausedFlag = false
	private var transportPaused: Boolean
		get() {
			if (pausedFlag && queue.isIdle()) pausedFlag = false
			return pausedFlag
		}
		set(value) {
			pausedFlag = value
		}

	/** Called after the run's state has SETTLED, never from a raw playback event: an event fires before
	 * the queue advances, so a listener reading on it sees the entry that just ended still installed.
	 * Mid-run that self-corrects on the next start; at the last terminal there is no next start to fix it. */
	@Volatile
	var onTransportChanged: (() -> Unit)? = null

	/** A counter rather than a second callback slot: [onTransportChanged] is the one slot the service
	 * owns; a counter has no owner, so any number of surfaces can watch it. */
	val queueRevision: kotlinx.coroutines.flow.StateFlow<Int> get() = _queueRevision
	private val _queueRevision = kotlinx.coroutines.flow.MutableStateFlow(0)

	private fun transportChanged() {
		_queueRevision.value = _queueRevision.value + 1
		warmQueued()
		runCatching { onTransportChanged?.invoke() }
	}

	/** Get every queued entry's audio made before its turn comes. Driven off the settled queue rather
	 * than off message arrival, so it follows what will ACTUALLY be spoken - warming off message
	 * arrival alone has no notion of the queue and would warm entries that are never actually going to
	 * play. Warming is idempotent per entry, so calling it on every change is free. Deliberately keeps
	 * going while the run is PAUSED: a pause means the person is busy, not that the work should stop. */
	private fun warmQueued() {
		val client = playback.sttsClient() ?: return
		val provider = playback.currentProvider() ?: return
		val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		val state = state.value
		for (entry in queue.queued()) {
			val tier = entry.tier ?: continue
			val msg = state.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe } ?: continue
			// The words the RUN will speak, not the attributed form a hand-play uses - the cache is keyed
			// on the text, so warming the other one would fill the cache and still synthesize live.
			val text = ttsTextFramed(state, msg, tier, attributed = false)
			if (text.isNotBlank()) playback.stts.cache.warm(client, provider, voice, entry.team, entry.at, tier, text, "${msg.epoch}-${msg.seq}")
		}
	}

	/** Start the next entry only while nothing is audible. "The queue has no head" is not the same
	 * question: the queue is headless the instant it stands down, and answering the wrong one is how it
	 * ends up speaking over the playback it just yielded to. Callers hold [advanceMutex]. */
	private fun resumeIfSilent() {
		if (transportPaused || queue.playing() != null || playback.stts.isSounding()) return
		queue.startNext()?.let { speak(it) }
	}

	/** Hold the run where it is. PREEMPTED already means "stand down and wait" rather than "advance",
	 * so a pause is that plus a flag stopping the next terminal from picking the run back up. */
	suspend fun pausePlayback() {
		advanceMutex.withLock {
			// Nothing to pause means nothing to resume. Setting the flag here would stick: an idle
			// queue mints no terminal, so no event would ever arrive to clear it, and every later run
			// - autoplay AND the in-thread button, which share this start path - would be refused.
			if (queue.isIdle()) return@withLock
			transportPaused = true
			markerInFlight?.let { playback.stts.abandonGeneration(it) }
			clearMarkers()
			val head = queue.playing()
			if (head != null) {
				// Requeued at the FRONT, then retired. Stopping audio would only reach a body that is
				// already sounding - during a marker, or while the body is still synthesizing, there is
				// nothing audible to stop, and the head would stay installed AND be waiting in pending:
				// stuck, and then spoken twice when the synthesis it never cancelled finally landed.
				// A pause KEEPS where it got to - that is what separates it from a skip. Which sound's
				// position that is stays the engine's to answer: during the chime or the sentinel the
				// audible thing is a marker, and a marker is never resumable, so a pause landing there
				// files nothing rather than cutting the opening off the body.
				queue.requeueFront(head)
				parkedAnnounced = head
				playback.stts.abandon(head.team, head.at, head.tier, remember = true)
				queue.advance(head, SttsPlayer.Outcome.PREEMPTED)
			}
		}
		transportChanged()
	}

	suspend fun resumePlayback() {
		advanceMutex.withLock {
			transportPaused = false
			resumeIfSilent()
		}
		transportChanged()
	}

	/** Give up on what is speaking and move to the next entry. Distinct from a pause: this one is a
	 * decision about THIS message, so the run continues. */
	suspend fun skipPlayback() {
		// try/finally, because a bare return inside `withLock` leaves the whole function - the surfaces
		// would keep showing the state from before the skip until some later terminal happened to
		// correct them.
		try {
			advanceMutex.withLock {
				// A pause retires the head and parks the message at the FRONT of the queue, so after one
				// there is no head to skip - the thing being skipped is that parked entry. Promoting it
				// first means Skip discards it, rather than resuming the very message it was asked to
				// move past.
				val head = queue.playing() ?: queue.startNext() ?: return@withLock
				retireHead(head)
			}
		} finally {
			transportChanged()
		}
	}

	fun transportState(): Pair<Boolean, Boolean> = reads.transportState()

	fun queueRows(): List<QueueRow> = reads.queueRows()

	fun failedRows(): List<QueueRow> = reads.failedRows()

	/** Take one entry out of the queue. The tile's trash, and the same action as a swipe on the bubble.
	 * Routed through skip when it is the HEAD: the head is installed in the engine, so removing it
	 * without retiring the request would strand a playback whose terminal has nothing to advance. */
	suspend fun dropFromQueue(entry: QueueEntry) {
		// ONE critical section, and it names the entry throughout. Deciding head-vs-not under the lock
		// and then acting outside it would let the head advance in between, so the trash could discard
		// whatever had become current rather than the tile that was tapped.
		try {
			advanceMutex.withLock {
				if (queue.playing() == entry) {
					retireHead(entry)
					return@withLock
				}
				queue.drop(entry)
				// Giving up on a message gives up on where it had got to, exactly as a skip does - which
				// the abandon is told outright rather than left to work out from the outcome.
				playback.stts.abandon(entry.team, entry.at, entry.tier, remember = false)
				playback.stts.forgetPosition(entry.team, entry.at, entry.tier)
				// A way to EMPTY the queue has to be a way to release a pause. Trashing the entry a pause
				// parked otherwise leaves the flag set over an idle queue, refusing every later run on
				// every team with no enabled control left to clear it.
				resumeIfSilent()
			}
		} finally {
			transportChanged()
		}
	}

	/** Retire a NAMED head and start whatever follows it. The shared body of skip and of trashing the
	 * tile that is speaking, so the two cannot drift; both must already hold [advanceMutex]. */
	private fun retireHead(head: QueueEntry) {
		markerInFlight?.let { playback.stts.abandonGeneration(it) }
		clearMarkers()
		playback.stts.forgetPosition(head.team, head.at, head.tier)
		playback.stts.abandon(head.team, head.at, head.tier, remember = false)
		// STOPPED, not COMPLETED. The queue advances on both, but only COMPLETED means "heard" - and a
		// skip that claimed it did cleared the message out of the failures list, telling the user they
		// had heard the very thing they had just given up on.
		val next = queue.advance(head, SttsPlayer.Outcome.STOPPED).next ?: return
		// Skip means "move past this one", NEVER "start playing". Clearing the pause here made the
		// lockscreen's own next button start the phone talking out loud from a state the user had
		// deliberately silenced - and every media app on the platform advances without sounding.
		//
		// The promoted entry has to be parked rather than left alone, because `advance` installs it as
		// the head BEFORE handing it back: declining to speak it would strand an entry the engine never
		// received and no terminal will ever retire. PREEMPTED puts it back at the front, which is
		// exactly where a resume should find it.
		if (transportPaused) {
			queue.advance(next, SttsPlayer.Outcome.PREEMPTED)
		} else {
			speak(next)
		}
	}

	/** Acknowledge one failure. "Seen", not "resolved" - the message was never spoken and this does not
	 * pretend otherwise; it only stops the alert asking again. */
	suspend fun acknowledgeFailure(entry: QueueEntry) {
		advanceMutex.withLock { queue.forgetFailure(entry) }
		transportChanged()
	}

	fun playbackPosition(): Position? = reads.playbackPosition()

	fun heldPosition(): Long? = reads.heldPosition()

	/** Move the current body. Named, so a bar built a moment ago cannot seek whatever took the sound
	 * since - a marker, or the next message. */
	fun seekPlayback(ms: Long) {
		val snap = playbackPosition() ?: return
		playback.stts.seekTo(snap.owner, ms)
	}

	/** Open the thread a queue entry belongs to, returning the CANONICAL key its tab is filed under.
	 * Revealing the message is the caller's half: only the view layer can scroll, and this class holds none. */
	fun jumpTo(entry: QueueEntry): String = collaborators.openThread(entry.team)

	fun queueCounts(): Triple<Int, Boolean, Int> = reads.queueCounts()

	/** Hand an entry to the engine, and synthesise its terminal ourselves if the engine would not take
	 * it. Without that, an entry the engine silently declines leaves the head un-retired and every
	 * message behind it unspoken for the life of the process. */
	private fun speak(entry: QueueEntry) {
		// Markers first when this entry is owed any. Their terminals chain the body behind them, so
		// this returns having started the boundary rather than the message. Markers staged for a
		// DIFFERENT entry are discarded: they name a session, and announcing the wrong one is worse
		// than announcing none.
		val resuming = parkedAnnounced == entry
		parkedAnnounced = null
		if (!resuming && markersFor != entry) queueMarkers(entry, chime = false)
		if (nextMarkerStarted()) return
		speakBody(entry)
	}

	private fun speakBody(entry: QueueEntry) {
		val tier = entry.tier
		if (tier == null) {
			repoScope.launch { onPlaybackEnded(entry, SttsPlayer.Outcome.SYNTH_ERROR, reason = "no tier to speak") }
			return
		}
		// Yielding: by the time this reaches the player the user may have started something of their
		// own, and autoplay stands down rather than talking over it.
		playback.stts.post {
			startPlayback(entry.team, entry.at, tier, yielding = true, attributed = false)?.let { why ->
				repoScope.launch { onPlaybackEnded(entry, SttsPlayer.Outcome.SYNTH_ERROR, reason = why) }
			}
		}
	}

	/** Map the autoPlay pref string to its tier, or null for "off"/unknown. */
	// internal (not private): the poll loop's own burst-handling (PollDrain.start) reads
	// the autoplay tier to decide whether to queue an arriving burst.
	internal fun autoPlayTier(value: String): SttsPlayer.Tier? = when (value) {
		"title" -> SttsPlayer.Tier.TITLE
		"summary" -> SttsPlayer.Tier.SUMMARY
		"full" -> SttsPlayer.Tier.FULL
		else -> null
	}

	/** Pre-synthesize every tier of a message into the cache so a later Play is
	 * instant. Blocking; runs off the poll loop on an IO thread. Silent on any
	 * failure - the notification fires regardless and Play falls back to live
	 * synthesis. No-op when unconfigured or the message is gone. */
	// internal (not private): the poll loop (PollDrain.start) preloads the first message of
	// an eligible burst before the notification fires.
	internal fun preloadMessage(team: String, at: Long) {
		val client = playback.sttsClient() ?: return
		val provider = playback.currentProvider() ?: return
		val msg = state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe } ?: return
		val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		playback.stts.cache.preloadTiers(
			client,
			provider,
			voice,
			team,
			at,
			ttsTextFramed(state.value, msg, SttsPlayer.Tier.TITLE),
			ttsTextFramed(state.value, msg, SttsPlayer.Tier.SUMMARY),
			ttsTextFramed(state.value, msg, SttsPlayer.Tier.FULL),
			rowKey = "${msg.epoch}-${msg.seq}",
		)
	}

	/** Settings voice preview with the current provider/voice. */
	fun playSttsSample() {
		playback.stts.post {
			val client = playback.sttsClient() ?: return@post
			val provider = playback.currentProvider() ?: return@post
			val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
			playback.stts.playSample(client, provider, voice, "This is your switchboard voice.", playback.sttsVolume)
		}
	}
}
