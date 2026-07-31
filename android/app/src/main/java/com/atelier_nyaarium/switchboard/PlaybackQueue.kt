package com.atelier_nyaarium.switchboard

/** One thing to speak, in the tier chosen when it was enqueued. */
data class QueueEntry(val team: String, val at: Long, val tier: SttsPlayer.Tier?)

/**
 * What an outcome did to the queue. The caller reads [next] to know what to play; a null next with
 * [paused] false means the queue ran dry, and with [paused] true means it is holding position.
 */
data class QueueStep(val next: QueueEntry?, val paused: Boolean, val failed: QueueEntry? = null)

/**
 * The autoplay queue with no player in it: enqueue, one head at a time, advance on an outcome.
 *
 * Advancing is ONE operation. A player completion and a user swipe can arrive together, and an advance
 * that read the head and then mutated across two calls would let both act on the same head - one entry
 * played twice, or skipped without ever being spoken.
 */
class PlaybackQueue {
	private val pending = ArrayDeque<QueueEntry>()
	private var head: QueueEntry? = null

	// Entries that failed once and were sent to the tail. A second failure drops them, so a message
	// whose audio will never decode cannot hold the queue in a retry loop.
	private val retried = mutableSetOf<QueueEntry>()

	// Dropped after their retry. Kept so the UI can show an alert and offer a jump to the session,
	// which is why a team's teardown has to take these too - otherwise they point at a removed thread.
	private val failures = mutableListOf<QueueEntry>()

	@Synchronized
	fun queued(): List<QueueEntry> = listOfNotNull(head) + pending

	@Synchronized
	fun playing(): QueueEntry? = head

	@Synchronized
	fun remembered(): List<QueueEntry> = failures.toList()

	/** Append unless this entry is already queued or playing. Returns whether it was taken, so a caller
	 * can tell "queued" from "already had it" without asking a second question. */
	@Synchronized
	fun enqueue(entry: QueueEntry): Boolean {
		if (head == entry || pending.contains(entry)) return false
		pending.addLast(entry)
		return true
	}

	/** Take the next entry when nothing is playing. Null when the queue is empty or already has a head,
	 * so a caller cannot start a second playback by asking twice. */
	@Synchronized
	fun startNext(): QueueEntry? {
		if (head != null) return null
		head = pending.removeFirstOrNull()
		return head
	}

	/**
	 * Retire the head according to `outcome` and hand back what to play next, as one operation.
	 *
	 * `id` names the entry the outcome belongs to. An outcome for anything other than the current head
	 * is ignored: a terminal can arrive from a request that was already replaced, and acting on it
	 * would advance past an entry nobody has heard.
	 */
	@Synchronized
	fun advance(entry: QueueEntry, outcome: SttsPlayer.Outcome): QueueStep {
		if (head != entry) return QueueStep(null, paused = false)
		return when (outcome) {
			// The user stopped it. Hold position: this entry is still the head and still theirs to resume.
			SttsPlayer.Outcome.STOPPED -> QueueStep(null, paused = true)

			SttsPlayer.Outcome.COMPLETED, SttsPlayer.Outcome.PREEMPTED -> {
				retired(entry)
				QueueStep(takeNext(), paused = false)
			}

			SttsPlayer.Outcome.PLAYBACK_ERROR, SttsPlayer.Outcome.SYNTH_ERROR -> {
				retired(entry)
				if (retried.add(entry)) {
					pending.addLast(entry)
					QueueStep(takeNext(), paused = false)
				} else {
					retried.remove(entry)
					failures.add(entry)
					QueueStep(takeNext(), paused = false, failed = entry)
				}
			}
		}
	}

	/** Resume the held head after a pause. Null when nothing is held. */
	@Synchronized
	fun resume(): QueueEntry? = head ?: pending.removeFirstOrNull()?.also { head = it }

	/**
	 * Forget everything belonging to one team: queued, playing, and remembered.
	 *
	 * Returns whether the HEAD was taken, so the caller can stop the player knowing this queue no
	 * longer points at it. Dropping before stopping is what keeps a stop's own terminal from advancing
	 * into an entry whose audio the same call is deleting.
	 */
	@Synchronized
	fun dropTeam(team: String): Boolean {
		pending.removeAll { it.team == team }
		retried.removeAll { it.team == team }
		failures.removeAll { it.team == team }
		val wasPlaying = head?.team == team
		if (wasPlaying) head = null
		return wasPlaying
	}

	@Synchronized
	fun forgetFailure(entry: QueueEntry): Boolean = failures.remove(entry)

	@Synchronized
	fun clear() {
		pending.clear()
		retried.clear()
		failures.clear()
		head = null
	}

	private fun retired(entry: QueueEntry) {
		if (head == entry) head = null
	}

	private fun takeNext(): QueueEntry? {
		head = pending.removeFirstOrNull()
		return head
	}
}
