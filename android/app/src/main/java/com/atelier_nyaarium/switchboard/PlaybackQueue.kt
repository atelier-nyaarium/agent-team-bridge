package com.atelier_nyaarium.switchboard

/** One thing to speak, in the tier chosen when it was enqueued. */
data class QueueEntry(val team: String, val at: Long, val tier: SttsPlayer.Tier?)

/**
 * What an outcome did to the queue.
 *
 * [standDown] is the difference between "nothing to play" and "do not play". It is set when the head
 * gave up the sound to something outside the queue, and the caller must not fill the silence: an empty
 * head reads identical to an idle queue, so without this flag a caller that restarts whenever the
 * queue looks idle speaks straight over whatever displaced it.
 */
data class QueueStep(val next: QueueEntry?, val failed: QueueEntry? = null, val standDown: Boolean = false)

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

	/** Nothing playing and nothing waiting. Asked BEFORE an autoplay enqueue, this is what makes the
	 * chime sound once for a run rather than once per message: mid-run the queue is never idle, and it
	 * becomes idle again only after the last entry has been spoken. */
	@Synchronized
	fun isIdle(): Boolean = head == null && pending.isEmpty()

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
		if (head != entry) return QueueStep(null)
		return when (outcome) {
			// The user stopped THIS message, which is not the same as stopping the run. It is retired
			// and the queue carries on; a real pause needs a control that says so, and there is none.
			SttsPlayer.Outcome.COMPLETED, SttsPlayer.Outcome.STOPPED -> {
				retired(entry)
				QueueStep(takeNext())
			}

			// Something outside the queue took the sound. Retire the head but start nothing: speaking
			// now would talk over whatever the user just asked for. The queue picks up again when that
			// playback reports its own terminal.
			SttsPlayer.Outcome.PREEMPTED -> {
				retired(entry)
				QueueStep(null, standDown = true)
			}

			SttsPlayer.Outcome.PLAYBACK_ERROR, SttsPlayer.Outcome.SYNTH_ERROR -> {
				retired(entry)
				if (retried.add(entry)) {
					pending.addLast(entry)
					QueueStep(takeNext())
				} else {
					retried.remove(entry)
					failures.add(entry)
					QueueStep(takeNext(), failed = entry)
				}
			}
		}
	}

	/**
	 * Forget everything belonging to one team: queued, playing, and remembered.
	 *
	 * Returns the entry it took the sound from, or null. NAMING it lets the caller stop that request by
	 * identity instead of stopping whatever happens to be audible, which may belong to another team.
	 * Dropping before stopping is what keeps a stop's own terminal from advancing into an entry whose
	 * audio the same call is deleting.
	 */
	@Synchronized
	fun dropTeam(team: String): QueueEntry? {
		pending.removeAll { it.team == team }
		retried.removeAll { it.team == team }
		failures.removeAll { it.team == team }
		val dropped = head?.takeIf { it.team == team }
		if (dropped != null) head = null
		return dropped
	}

	/** Put an entry back at the FRONT, ahead of everything waiting. A pause stops the audio by ending
	 * the request, which retires it - so without this, resuming would skip the very message that was
	 * paused. There is no seek yet, so it resumes from the start. */
	@Synchronized
	fun requeueFront(entry: QueueEntry) {
		// Deliberately allowed while it is still the head: a pause requeues BEFORE the stop retires it,
		// which is the only moment the caller still knows what was playing. Guarded on `pending` alone,
		// so requeueing something already waiting cannot make it speak twice.
		if (pending.contains(entry)) return
		pending.addFirst(entry)
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
