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

internal class PlaybackOps(
	private val state: MutableStateFlow<ChatState>,
	private val repoScope: CoroutineScope,
	private val playback: PlaybackPort,
	private val collaborators: PlaybackOpsCollaborators,
) : ClearsOnReprovision {
	/** One mutex serializes terminals and user transport actions. */
	private val queue = PlaybackQueue()

	/** Every advance reads and mutates the head under this lock. */
	private val advanceMutex = Mutex()

	private val reads = PlaybackReadModels(state, playback, queue) { transportPaused }

	init {
		playback.stts.addListener { event ->
			if (event is Event.Ended) {
				val entry = QueueEntry(event.team, event.at, event.tier)
				// Generation identifies the exact request that ended.
				repoScope.launch { onPlaybackEnded(entry, event.outcome, event.gen, event.reason) }
			}
		}
	}

	fun playMessage(team: String, at: Long, tier: SttsPlayer.Tier) {
		playback.stts.post { startPlayback(team, at, tier) }
	}

	private fun startPlayback(
		team: String,
		at: Long,
		tier: SttsPlayer.Tier,
		yielding: Boolean = false,
		attributed: Boolean = true,
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

	private val pendingMarkers = ArrayDeque<Marker>()

	private var markersFor: QueueEntry? = null

	private var parkedAnnounced: QueueEntry? = null

	private var markerInFlight: Long? = null

	private sealed interface Marker {
		data object Chime : Marker

		data class Spoken(val text: String) : Marker
	}

	suspend fun enqueueForPlay(
		team: String,
		at: Long,
		tier: SttsPlayer.Tier,
		announceRun: Boolean,
		requireFollowed: Boolean = true,
	) {
		val entry = QueueEntry(team, at, tier)
		advanceMutex.withLock {
			// Recheck followed state under the advance lock.
			if (requireFollowed && team !in state.value.openTabs) return
			val beginsRun = queue.isIdle()
			if (!queue.enqueue(entry)) return
			if (beginsRun) queueMarkers(entry, chime = announceRun)
			resumeIfSilent()
		}
		transportChanged()
	}

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

	private fun nextMarkerStarted(): Boolean {
		while (pendingMarkers.isNotEmpty()) {
			val started = when (val marker = pendingMarkers.removeFirst()) {
				is Marker.Chime -> chimeSource?.invoke()?.let { playback.stts.playChime(it, playback.sttsChimeVolume) }
				is Marker.Spoken -> speakMarker(marker.text)
			}
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

	@Volatile
	var chimeSource: (() -> File?)? = null

	private suspend fun onPlaybackEnded(
		entry: QueueEntry,
		outcome: SttsPlayer.Outcome,
		gen: Long = 0L,
		reason: String? = null,
	) {
		try {
			advanceEnded(entry, outcome, gen, reason)
		} finally {
			transportChanged()
		}
	}

	private suspend fun advanceEnded(entry: QueueEntry, outcome: SttsPlayer.Outcome, gen: Long, reason: String?) {
		advanceMutex.withLock {
			if (entry.team == SttsPlayer.MARKER_TEAM) {
				// Ignore terminals from torn-down marker runs.
				if (gen != markerInFlight) return
				markerInFlight = null
				val head = queue.playing()
				if (head == null || markersFor != head) {
					clearMarkers()
					resumeIfSilent()
					return
				}
				// Capture the entry before the gap callback runs.
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
				speak(step.next)
				return
			}
			if (step.standDown) return
			resumeIfSilent()
		}
	}

	suspend fun dropQueuedFor(team: String) {
		advanceMutex.withLock {
			// Drop before stopping, so the stop terminal cannot advance removed work.
			queue.dropTeam(team)?.let { playback.stts.abandon(it.team, it.at, it.tier, remember = false) }
			playback.stts.forgetTeamPositions(team)
			if (markersFor?.team == team) {
				markerInFlight?.let { playback.stts.abandonGeneration(it) }
				clearMarkers()
			}
			resumeIfSilent()
		}
		transportChanged()
	}

	override suspend fun clearInMemory() {
		advanceMutex.withLock {
			queue.clear()
			clearMarkers()
			parkedAnnounced = null
			pausedFlag = false
		}
		transportChanged()
	}

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

	@Volatile
	var onTransportChanged: (() -> Unit)? = null

	val queueRevision: kotlinx.coroutines.flow.StateFlow<Int> get() = _queueRevision
	private val _queueRevision = kotlinx.coroutines.flow.MutableStateFlow(0)

	private fun transportChanged() {
		_queueRevision.value = _queueRevision.value + 1
		warmQueued()
		runCatching { onTransportChanged?.invoke() }
	}

	private fun warmQueued() {
		val client = playback.sttsClient() ?: return
		val provider = playback.currentProvider() ?: return
		val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		val state = state.value
		for (entry in queue.queued()) {
			val tier = entry.tier ?: continue
			val msg = state.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe } ?: continue
			val text = ttsTextFramed(state, msg, tier, attributed = false)
			if (text.isNotBlank()) playback.stts.cache.warm(client, provider, voice, entry.team, entry.at, tier, text, "${msg.epoch}-${msg.seq}")
		}
	}

	private fun resumeIfSilent() {
		if (transportPaused || queue.playing() != null || playback.stts.isSounding()) return
		queue.startNext()?.let { speak(it) }
	}

	suspend fun pausePlayback() {
		advanceMutex.withLock {
			// An idle queue has no terminal to clear a pause flag.
			if (queue.isIdle()) return@withLock
			transportPaused = true
			markerInFlight?.let { playback.stts.abandonGeneration(it) }
			clearMarkers()
			val head = queue.playing()
			if (head != null) {
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

	suspend fun skipPlayback() {
		try {
			advanceMutex.withLock {
				// Promote a parked head so skip discards it instead of resuming it.
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

	suspend fun dropFromQueue(entry: QueueEntry) {
		try {
			advanceMutex.withLock {
				if (queue.playing() == entry) {
					retireHead(entry)
					return@withLock
				}
				queue.drop(entry)
				playback.stts.abandon(entry.team, entry.at, entry.tier, remember = false)
				playback.stts.forgetPosition(entry.team, entry.at, entry.tier)
				resumeIfSilent()
			}
		} finally {
			transportChanged()
		}
	}

	// Skips advance as stopped, never completed.
	private fun retireHead(head: QueueEntry) {
		markerInFlight?.let { playback.stts.abandonGeneration(it) }
		clearMarkers()
		playback.stts.forgetPosition(head.team, head.at, head.tier)
		playback.stts.abandon(head.team, head.at, head.tier, remember = false)
		val next = queue.advance(head, SttsPlayer.Outcome.STOPPED).next ?: return
		if (transportPaused) {
			queue.advance(next, SttsPlayer.Outcome.PREEMPTED)
		} else {
			speak(next)
		}
	}

	suspend fun acknowledgeFailure(entry: QueueEntry) {
		advanceMutex.withLock { queue.forgetFailure(entry) }
		transportChanged()
	}

	fun playbackPosition(): Position? = reads.playbackPosition()

	fun heldPosition(): Long? = reads.heldPosition()

	fun seekPlayback(ms: Long) {
		val snap = playbackPosition() ?: return
		playback.stts.seekTo(snap.owner, ms)
	}

	fun jumpTo(entry: QueueEntry): String = collaborators.openThread(entry.team)

	fun queueCounts(): Triple<Int, Boolean, Int> = reads.queueCounts()

	private fun speak(entry: QueueEntry) {
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
		playback.stts.post {
			startPlayback(entry.team, entry.at, tier, yielding = true, attributed = false)?.let { why ->
				repoScope.launch { onPlaybackEnded(entry, SttsPlayer.Outcome.SYNTH_ERROR, reason = why) }
			}
		}
	}

	internal fun autoPlayTier(value: String): SttsPlayer.Tier? = when (value) {
		"title" -> SttsPlayer.Tier.TITLE
		"summary" -> SttsPlayer.Tier.SUMMARY
		"full" -> SttsPlayer.Tier.FULL
		else -> null
	}

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

	fun playSttsSample() {
		playback.stts.post {
			val client = playback.sttsClient() ?: return@post
			val provider = playback.currentProvider() ?: return@post
			val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
			playback.stts.playSample(client, provider, voice, "This is your switchboard voice.", playback.sttsVolume)
		}
	}
}
