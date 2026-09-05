package com.atelier_nyaarium.switchboard

internal class PlaybackReadModels(
	private val state: kotlinx.coroutines.flow.MutableStateFlow<ChatState>,
	private val playback: PlaybackPort,
	private val queue: PlaybackQueue,
	// Use the owner accessor so paused idle queues normalize consistently.
	private val paused: () -> Boolean,
) {
	fun playStatesFor(team: String): Map<Long, String> {
		// Derive states from the settled queue, not an event stream.
		val states = mutableMapOf<Long, String>()
		for (entry in queue.queued()) {
			if (entry.team != team) continue
			states[entry.at] = when {
				playback.stts.isPlayingMessage(entry.team, entry.at) -> "playing"
				entry == queue.playing() -> "loading"
				else -> "queued"
			}
		}
		return states
	}

	fun transportState(): Pair<Boolean, Boolean> = Pair(!queue.isIdle(), paused())

	fun queueCounts(): Triple<Int, Boolean, Int> {
		// Failure count survives after the playable queue drains.
		val queued = queue.queued()
		val head = queue.playing()
		val generating = head != null && !playback.stts.isPlayingMessage(head.team, head.at)
		return Triple(queued.size, generating, queue.remembered().size)
	}

	fun queueRows(): List<QueueRow> {
		val head = queue.playing()
		val current = playbackPosition()
		// Read once so every row shares one playback position.
		val generating = head != null && !playback.stts.isPlayingMessage(head.team, head.at)
		// Only the head can be generating.
		return queue.queued().distinct().map { entry ->
			row(
				entry,
				isCurrent = entry == head,
				durationMs = current?.takeIf { it.entry == entry }?.durationMs
					?: playback.stts.cache.warmedDuration(entry.team, entry.at, entry.tier),
				generating = generating && entry == head,
			)
		}
	}

	fun failedRows(): List<QueueRow> =
		queue.remembered().map {
			row(it, isCurrent = false, durationMs = null, gaveUp = true, reason = shortCause(queue.reasonFor(it)))
		}

	private fun shortCause(reason: String?): String {
		// Bound HTTP failure text before showing it in a tile.
		val raw = reason?.trim().orEmpty()
		return when {
			raw.isEmpty() -> "not spoken"
			raw.contains("401") || raw.contains("403", true) -> "voice key rejected"
			raw.contains("429") -> "voice service busy"
			raw.contains("timeout", true) || raw.contains("timed out", true) -> "voice service timed out"
			raw.contains("playback failed", true) -> "audio would not play"
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
		val msg = state.value.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe }
		return QueueRow(
			entry = entry,
			sessionLabel = state.value.label(entry.team),
			title = msg?.let { SttsPlayer.ttsText(it, SttsPlayer.Tier.TITLE) }.orEmpty(),
			durationMs = durationMs,
			isCurrent = isCurrent,
			generating = generating,
			gaveUp = gaveUp,
			reason = reason,
		)
	}

	// Markers have no seekable timeline.
	fun playbackPosition(): Position? =
		playback.stts.positionSnapshot()?.takeIf { it.entry == queue.playing() }

	fun heldPosition(): Long? {
		// Keep the parked position visible while paused.
		if (!paused()) return null
		val parked = queue.queued().firstOrNull() ?: return null
		return playback.stts.heldPosition(parked.team, parked.at, parked.tier)
	}
}
