package com.atelier_nyaarium.switchboard

import java.io.File
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The playback surface: the autoplay queue, the chime/sentinel marker sequence in front of it, and
 * every transport control and read model a UI surface asks about either one. PlaybackOps is the
 * single owner of the whole playback serialization boundary - the queue, its advance mutex, and every
 * piece of state that boundary protects. */
internal class PlaybackOps(private val repo: ChatRepository) {
	/** What autoplay still has to speak. This class owns it and advances it; [SttsPlayer] stays a
	 * one-shot engine that knows nothing about what comes next. */
	private val queue = PlaybackQueue()

	/** Serializes every advance. A player terminal and a user gesture can arrive together, and both
	 * read the head before mutating it; `scheduledSendFireMutex` guards the same shape for sends. */
	private val advanceMutex = Mutex()

	// The queue advances off terminals, so it subscribes for the process's lifetime rather than with a
	// screen: a backgrounded burst has no UI listening and must still walk forward.
	init {
		repo.stts.addListener { event ->
			if (event is SttsPlayer.Event.Ended) {
				val entry = QueueEntry(event.team, event.at, event.tier)
				// `gen` is carried, not dropped: it is the only field that says WHICH request ended,
				// and a marker's entry key is shared by every run of the same session.
				repo.repoScope.launch { onPlaybackEnded(entry, event.outcome, event.gen, event.reason) }
			}
		}
	}

	/**
	 * Speak one message tier. The whole resolution (credential decrypt, message lookup, text prep)
	 * hops to the player's control lane so a broadcast receiver's main thread does zero disk or crypto
	 * work. Cache and single-flight live in SttsPlayer. No-op when unconfigured or the message is gone.
	 */
	fun playMessage(team: String, at: Long, tier: SttsPlayer.Tier) {
		repo.stts.post { startPlayback(team, at, tier) }
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
		val client = repo.sttsClient() ?: return "no voice key set"
		val provider = repo.currentProvider() ?: return "no voice provider set"
		val msg = repo._state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe }
			?: return "message is no longer here"
		val text = ttsTextFramed(repo._state.value, msg, tier, attributed)
		if (text.isBlank()) return "nothing to read aloud"
		val voice = repo.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		val taken = repo.stts.play(client, provider, voice, team, at, tier, text, repo.sttsVolume, yielding)
		return if (taken) null else "already speaking"
	}

	/** A QUERY, not something a consumer accumulates from the event stream: a row's state is derived
	 * from the queue, so anything rebuilding it from events can disagree with the queue itself. */
	fun playStatesFor(team: String): Map<Long, String> {
		val states = mutableMapOf<Long, String>()
		for (entry in queue.queued()) {
			if (entry.team != team) continue
			states[entry.at] = when {
				repo.stts.isPlayingMessage(entry.team, entry.at) -> "playing"
				entry == queue.playing() -> "loading"
				else -> "queued"
			}
		}
		return states
	}

	fun isMessagePlaying(team: String, at: Long): Boolean = repo.stts.isPlayingMessage(team, at)

	fun stopMessage(team: String, at: Long) = repo.stts.stopMessage(team, at)

	/** Advances on a terminal like the queue, not through a second mechanism. Held here, not on
	 * [QueueEntry]: what an entry consists of is not the queue's business. */
	private val pendingMarkers = ArrayDeque<Marker>()

	/** The entry [pendingMarkers] were staged for. A marker announces a specific session, so a queue
	 * that moved on while one was in flight must not let the leftovers introduce the wrong one. */
	private var markersFor: QueueEntry? = null

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
			if (requireFollowed && team !in repo._state.value.openTabs) return
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
		val msg = repo._state.value.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe } ?: return
		pendingMarkers.addLast(Marker.Spoken(sentinelText(repo._state.value, msg, entry.team)))
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
				is Marker.Chime -> chimeSource?.invoke()?.let { repo.stts.playChime(it, repo.sttsChimeVolume) }
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
		val client = repo.sttsClient() ?: return null
		val provider = repo.currentProvider() ?: return null
		val voice = repo.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		return repo.stts.playMarker(client, provider, voice, text, repo.sttsVolume)
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
				repo.stts.afterGap {
					repo.repoScope.launch {
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
			queue.dropTeam(team)?.let { repo.stts.abandon(it.team, it.at, it.tier, remember = false) }
			repo.stts.forgetTeamPositions(team)
			// A marker lives under its own reserved team, so dropping the message's team cannot reach
			// one already handed to the engine. Abandoned by its own identity rather than by stopping
			// whatever is audible: the marker may still be synthesizing and hold no sound yet, and
			// what IS audible may belong to a team nobody asked to silence.
			if (markersFor?.team == team) {
				markerInFlight?.let { repo.stts.abandonGeneration(it) }
				clearMarkers()
			}
			resumeIfSilent()
		}
		// A teardown changes what there is to show as surely as a terminal does. Without this, closing
		// a thread mid-run left the lockscreen holding a transport for a run that no longer exists.
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
		val client = repo.sttsClient() ?: return
		val provider = repo.currentProvider() ?: return
		val voice = repo.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		val state = repo._state.value
		for (entry in queue.queued()) {
			val tier = entry.tier ?: continue
			val msg = state.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe } ?: continue
			// The words the RUN will speak, not the attributed form a hand-play uses - the cache is keyed
			// on the text, so warming the other one would fill the cache and still synthesize live.
			val text = ttsTextFramed(state, msg, tier, attributed = false)
			if (text.isNotBlank()) repo.stts.warm(client, provider, voice, entry.team, entry.at, tier, text)
		}
	}

	/** Start the next entry only while nothing is audible. "The queue has no head" is not the same
	 * question: the queue is headless the instant it stands down, and answering the wrong one is how it
	 * ends up speaking over the playback it just yielded to. Callers hold [advanceMutex]. */
	private fun resumeIfSilent() {
		if (transportPaused || queue.playing() != null || repo.stts.isSounding()) return
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
			markerInFlight?.let { repo.stts.abandonGeneration(it) }
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
				repo.stts.abandon(head.team, head.at, head.tier, remember = true)
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

	/** What a transport surface should show: whether anything is queued at all, and whether it is
	 * currently held. */
	fun transportState(): Pair<Boolean, Boolean> = Pair(!queue.isIdle(), transportPaused)

	/** The queue as the sheet renders it, in speaking order, current entry first. Built here rather than
	 * in the UI so the sheet holds no state of its own - the ones that kept their own copy drifted. */
	fun queueRows(): List<QueueRow> {
		val head = queue.playing()
		// Read once rather than per row: it is the same answer for all of them, and asking inside the
		// loop would let the current entry change mid-list.
		val current = playbackPosition()
		// Only the HEAD can be mid-synthesis, and only until its audio starts. Everything behind it is
		// waiting its turn, which is a different thing and must not draw as work in progress.
		val generating = head != null && !repo.stts.isPlayingMessage(head.team, head.at)
		return queue.queued().distinct().map { entry ->
			row(
				entry,
				isCurrent = entry == head,
				// The live player for the one sounding, otherwise whatever warming measured - a queued
				// entry knows its own length as soon as its audio exists, which is the point of warming it early.
				durationMs = current?.takeIf { it.entry == entry }?.durationMs
					?: repo.stts.warmedDuration(entry.team, entry.at, entry.tier),
				generating = generating && entry == head,
			)
		}
	}

	/** The entries that gave up, for the alert's list. Separate from [queueRows] because these are no
	 * longer a run: nothing will speak them, and the only things offered are a jump and a dismissal. */
	fun failedRows(): List<QueueRow> =
		queue.remembered().map {
			row(it, isCurrent = false, durationMs = null, gaveUp = true, reason = shortCause(queue.reasonFor(it)))
		}

	/** The raw string is an HTTP body: paragraphs, internal endpoints, echoed request content - not
	 * what belongs on a tile. */
	private fun shortCause(reason: String?): String {
		val raw = reason?.trim().orEmpty()
		return when {
			raw.isEmpty() -> "not spoken"
			raw.contains("401") || raw.contains("403", true) -> "voice key rejected"
			raw.contains("429") -> "voice service busy"
			raw.contains("timeout", true) || raw.contains("timed out", true) -> "voice service timed out"
			raw.contains("playback failed", true) -> "audio would not play"
			// Already a phrase written for a person - the decline paths mint these themselves.
			raw.length <= 60 && !raw.contains('{') && !raw.contains('<') -> raw
			else -> raw.lineSequence().first().take(60)
		}
	}

	private fun row(
		entry: QueueEntry,
		isCurrent: Boolean,
		durationMs: Long?,
		generating: Boolean = false,
		gaveUp: Boolean = false,
		reason: String? = null,
	): QueueRow {
		val msg = repo._state.value.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe }
		return QueueRow(
			entry = entry,
			sessionLabel = repo._state.value.label(entry.team),
			title = msg?.let { SttsPlayer.ttsText(it, SttsPlayer.Tier.TITLE) }.orEmpty(),
			durationMs = durationMs,
			isCurrent = isCurrent,
			generating = generating,
			gaveUp = gaveUp,
			reason = reason,
		)
	}

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
				repo.stts.abandon(entry.team, entry.at, entry.tier, remember = false)
				repo.stts.forgetPosition(entry.team, entry.at, entry.tier)
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
		markerInFlight?.let { repo.stts.abandonGeneration(it) }
		clearMarkers()
		repo.stts.forgetPosition(head.team, head.at, head.tier)
		repo.stts.abandon(head.team, head.at, head.tier, remember = false)
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

	/** Where the current BODY is and how long it is, for the sheet's one bar. Scoped to the head, so the
	 * bar is null through the chime and the sentinel too: neither marker gets a timeline, and a bar
	 * running over one would invite a seek with nowhere useful to land. */
	fun playbackPosition(): SttsPlayer.Position? =
		repo.stts.positionSnapshot()?.takeIf { it.entry == queue.playing() }

	/** Where the run would pick up while it is held. A pause has no player, so the live snapshot is
	 * null and the sheet showed nothing at all - blanking the timeline at precisely the moment the
	 * preserved position is the thing worth seeing. Duration stays unknown until audio exists again. */
	fun heldPosition(): Long? {
		if (!transportPaused) return null
		val parked = queue.queued().firstOrNull() ?: return null
		return repo.stts.heldPosition(parked.team, parked.at, parked.tier)
	}

	/** Move the current body. Named, so a bar built a moment ago cannot seek whatever took the sound
	 * since - a marker, or the next message. */
	fun seekPlayback(ms: Long) {
		val snap = playbackPosition() ?: return
		repo.stts.seekTo(snap.owner, ms)
	}

	/** Open the thread a queue entry belongs to, returning the CANONICAL key its tab is filed under.
	 * Revealing the message is the caller's half: only the view layer can scroll, and this class holds none. */
	fun jumpTo(entry: QueueEntry): String = repo.openThread(entry.team)

	/** What the bubble draws: how many are still to speak, whether the current one is still being
	 * generated, and how many gave up. The failure count outlives a drained queue, which is why it is
	 * reported separately rather than folded into the total. */
	fun queueCounts(): Triple<Int, Boolean, Int> {
		val queued = queue.queued()
		val head = queue.playing()
		val generating = head != null && !repo.stts.isPlayingMessage(head.team, head.at)
		return Triple(queued.size, generating, queue.remembered().size)
	}

	/** Hand an entry to the engine, and synthesise its terminal ourselves if the engine would not take
	 * it. Without that, an entry the engine silently declines leaves the head un-retired and every
	 * message behind it unspoken for the life of the process. */
	private fun speak(entry: QueueEntry) {
		// Markers first when this entry is owed any. Their terminals chain the body behind them, so
		// this returns having started the boundary rather than the message. Markers staged for a
		// DIFFERENT entry are discarded: they name a session, and announcing the wrong one is worse
		// than announcing none.
		if (markersFor != entry) queueMarkers(entry, chime = false)
		if (nextMarkerStarted()) return
		speakBody(entry)
	}

	private fun speakBody(entry: QueueEntry) {
		val tier = entry.tier
		if (tier == null) {
			repo.repoScope.launch { onPlaybackEnded(entry, SttsPlayer.Outcome.SYNTH_ERROR, reason = "no tier to speak") }
			return
		}
		// Yielding: by the time this reaches the player the user may have started something of their
		// own, and autoplay stands down rather than talking over it.
		repo.stts.post {
			startPlayback(entry.team, entry.at, tier, yielding = true, attributed = false)?.let { why ->
				repo.repoScope.launch { onPlaybackEnded(entry, SttsPlayer.Outcome.SYNTH_ERROR, reason = why) }
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
		val client = repo.sttsClient() ?: return
		val provider = repo.currentProvider() ?: return
		val msg = repo._state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe } ?: return
		val voice = repo.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		repo.stts.preloadTiers(
			client,
			provider,
			voice,
			team,
			at,
			ttsTextFramed(repo._state.value, msg, SttsPlayer.Tier.TITLE),
			ttsTextFramed(repo._state.value, msg, SttsPlayer.Tier.SUMMARY),
			ttsTextFramed(repo._state.value, msg, SttsPlayer.Tier.FULL),
		)
	}

	/** Settings voice preview with the current provider/voice. */
	fun playSttsSample() {
		repo.stts.post {
			val client = repo.sttsClient() ?: return@post
			val provider = repo.currentProvider() ?: return@post
			val voice = repo.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
			repo.stts.playSample(client, provider, voice, "This is your switchboard voice.", repo.sttsVolume)
		}
	}
}
