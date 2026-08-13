package com.atelier_nyaarium.switchboard

/**
 * What a playback surface asks: the queue as the sheet, the bubble and a thread row read it.
 *
 * Nothing here takes [PlaybackOps]'s advance mutex, because nothing here mutates. Every answer is
 * derived from the settled queue rather than accumulated from the event stream, which is what keeps a
 * surface from disagreeing with the queue itself.
 */
internal class PlaybackReadModels(
	private val repo: ChatRepository,
	private val queue: PlaybackQueue,
	// Read through its owner's accessor rather than copied. That accessor is what normalizes a pause
	// over an idle queue, and a copy here would make the bad state observable again.
	private val paused: () -> Boolean,
) {
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

	/** What a transport surface should show: whether anything is queued at all, and whether it is
	 * currently held. */
	fun transportState(): Pair<Boolean, Boolean> = Pair(!queue.isIdle(), paused())

	/** What the bubble draws: how many are still to speak, whether the current one is still being
	 * generated, and how many gave up. The failure count outlives a drained queue, which is why it is
	 * reported separately rather than folded into the total. */
	fun queueCounts(): Triple<Int, Boolean, Int> {
		val queued = queue.queued()
		val head = queue.playing()
		val generating = head != null && !repo.stts.isPlayingMessage(head.team, head.at)
		return Triple(queued.size, generating, queue.remembered().size)
	}

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
					?: repo.stts.cache.warmedDuration(entry.team, entry.at, entry.tier),
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

	/** Where the current BODY is and how long it is, for the sheet's one bar. Scoped to the head, so the
	 * bar is null through the chime and the sentinel too: neither marker gets a timeline, and a bar
	 * running over one would invite a seek with nowhere useful to land. */
	fun playbackPosition(): Position? =
		repo.stts.positionSnapshot()?.takeIf { it.entry == queue.playing() }

	/** Where the run would pick up while it is held. A pause has no player, so the live snapshot is
	 * null and the sheet showed nothing at all - blanking the timeline at precisely the moment the
	 * preserved position is the thing worth seeing. Duration stays unknown until audio exists again. */
	fun heldPosition(): Long? {
		if (!paused()) return null
		val parked = queue.queued().firstOrNull() ?: return null
		return repo.stts.heldPosition(parked.team, parked.at, parked.tier)
	}
}
