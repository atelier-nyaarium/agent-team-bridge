package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The queue is read through what it hands back to play next, so that is what these assert. Which
 * outcome advances and which holds is the whole contract: a decode failure that retires an entry as
 * though it were heard loses a message silently.
 */
class PlaybackQueueTest {
	private val team = "local.gw.evie-bot.main"
	private val other = "local.gw.other.main"

	private fun entry(at: Long, team: String = this.team) = QueueEntry(team, at, SttsPlayer.Tier.FULL)

	private fun queueOf(vararg entries: QueueEntry) = PlaybackQueue().apply { entries.forEach { enqueue(it) } }

	@Test
	fun `a burst speaks every message in the order it arrived`() {
		val q = queueOf(entry(1), entry(2), entry(3))

		val spoken = mutableListOf<QueueEntry>()
		var current = q.startNext()
		while (current != null) {
			spoken += current
			current = q.advance(current, SttsPlayer.Outcome.COMPLETED).next
		}

		assertEquals(listOf(entry(1), entry(2), entry(3)), spoken)
	}

	@Test
	fun `a paused entry comes back before everything waiting`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!

		// Pausing stops the audio, which ends the request and retires it. Putting it back at the front
		// is what makes resume replay the paused message rather than skip to the next one.
		q.requeueFront(head)
		q.advance(head, SttsPlayer.Outcome.PREEMPTED)

		assertEquals(entry(1), q.startNext())
		assertEquals(listOf(entry(1), entry(2)), q.queued())
	}

	@Test
	fun `skipping after a pause discards the paused entry rather than replaying it`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!

		// Pause: the entry is parked at the front and the head is retired, so there is no head left for
		// a later skip to act on.
		q.requeueFront(head)
		q.advance(head, SttsPlayer.Outcome.PREEMPTED)
		assertNull(q.playing())

		// Skip promotes the parked entry and retires it. Resuming instead would replay the very message
		// the user asked to move past - Skip doing the opposite of skip.
		val promoted = q.playing() ?: q.startNext()!!
		assertEquals(entry(1), promoted)
		assertEquals(entry(2), q.advance(promoted, SttsPlayer.Outcome.COMPLETED).next)
		assertEquals(listOf(entry(2)), q.queued())
	}

	@Test
	fun `requeueing something already waiting changes nothing`() {
		val q = queueOf(entry(1), entry(2))

		q.requeueFront(entry(2))

		// Otherwise a double pause, or a pause of an entry the queue never lost, speaks it twice.
		assertEquals(listOf(entry(1), entry(2)), q.queued())
	}

	@Test
	fun `a run is idle only before it starts and after it drains`() {
		val q = PlaybackQueue()
		assertTrue(q.isIdle())

		q.enqueue(entry(1))
		q.enqueue(entry(2))
		// Not idle mid-run, which is what keeps the boundary marker to once per run rather than once
		// per message.
		assertFalse(q.isIdle())

		val head = q.startNext()!!
		assertFalse(q.isIdle())
		val second = q.advance(head, SttsPlayer.Outcome.COMPLETED).next!!
		assertFalse(q.isIdle())

		q.advance(second, SttsPlayer.Outcome.COMPLETED)
		// Drained, so the next arrival begins a fresh run and marks itself again.
		assertTrue(q.isIdle())
	}

	@Test
	fun `a run that stood down is not idle`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!

		q.advance(head, SttsPlayer.Outcome.PREEMPTED)

		// The head is gone but the run is not over - entry 2 is still owed. Reading this as idle would
		// re-announce a run already in progress once the sound came free.
		assertFalse(q.isIdle())
	}

	@Test
	fun `the same message is not queued twice`() {
		val q = queueOf(entry(1))

		assertFalse(q.enqueue(entry(1)))
		q.startNext()
		// Still refused while it is the one playing, or a burst redelivery would speak it again behind
		// itself.
		assertFalse(q.enqueue(entry(1)))
		assertEquals(listOf(entry(1)), q.queued())
	}

	@Test
	fun `stopping one message retires it and carries on`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!

		val step = q.advance(head, SttsPlayer.Outcome.STOPPED)

		// The stop control says "not this one", not "not any more". Holding the head here ended the
		// run for the life of the process, because nothing resumes it.
		assertEquals(entry(2), step.next)
	}

	@Test
	fun `being displaced retires the head but starts nothing`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!

		val step = q.advance(head, SttsPlayer.Outcome.PREEMPTED)

		// Something outside the queue took the sound. Starting the next entry now would talk over
		// whatever the user just asked for; the queue waits for that playback to report its own end.
		assertNull(step.next)
		assertNull(q.playing())
		// And the displaced entry is still THERE, at the front. Yielding decides when to speak, not
		// whether to: dropping it let a settings voice sample eat the message the run had reached,
		// with no alert and no count to notice the loss by.
		assertEquals(listOf(entry(1), entry(2)), q.queued())
		// The flag, not the empty head, is what says "do not fill this silence". Asserting only the
		// two above passed while the caller restarted anyway, because a stood-down queue and an idle
		// one look identical from here.
		assertTrue(step.standDown)
	}

	@Test
	fun `only a stand-down forbids the caller from starting something`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!

		// A terminal for something the queue does not own carries no veto: the caller is free to check
		// whether the sound came free and pick the run back up.
		assertFalse(q.advance(QueueEntry("local.gw.manual.main", 99, SttsPlayer.Tier.FULL), SttsPlayer.Outcome.COMPLETED).standDown)
		assertFalse(q.advance(head, SttsPlayer.Outcome.COMPLETED).standDown)
	}

	@Test
	fun `the run picks up again once the sound is free`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!
		q.advance(head, SttsPlayer.Outcome.PREEMPTED)

		// The displacing playback ends. It is not the head, so it moves nothing by itself - the caller
		// sees an idle queue with a backlog and restarts it.
		val unrelated = q.advance(QueueEntry("local.gw.manual.main", 99, SttsPlayer.Tier.FULL), SttsPlayer.Outcome.COMPLETED)
		assertNull(unrelated.next)
		// Picking up on the message it was interrupted ON, not the one after it. The stored position
		// is what keeps that from restarting it at the top.
		assertEquals(entry(1), q.startNext())
	}

	@Test
	fun `a failure goes to the tail once, then is dropped and remembered`() {
		val q = queueOf(entry(1), entry(2))
		val first = q.startNext()!!

		val afterFirstFailure = q.advance(first, SttsPlayer.Outcome.SYNTH_ERROR)
		assertEquals(entry(2), afterFirstFailure.next)
		assertNull(afterFirstFailure.failed)

		val second = q.advance(entry(2), SttsPlayer.Outcome.COMPLETED).next
		assertEquals(entry(1), second)

		val afterRetry = q.advance(entry(1), SttsPlayer.Outcome.SYNTH_ERROR)
		assertNull(afterRetry.next)
		assertEquals(entry(1), afterRetry.failed)
		assertEquals(listOf(entry(1)), q.remembered())
	}

	@Test
	fun `an outcome for an entry that is no longer the head changes nothing`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!
		q.advance(head, SttsPlayer.Outcome.COMPLETED)

		val late = q.advance(entry(1), SttsPlayer.Outcome.COMPLETED)

		assertNull(late.next)
		assertEquals(entry(2), q.playing())
	}

	@Test
	fun `two advances for one head cannot both move the queue`() {
		val q = queueOf(entry(1), entry(2), entry(3))
		val head = q.startNext()!!

		// A player completion and a user swipe arriving together.
		val a = q.advance(head, SttsPlayer.Outcome.COMPLETED)
		val b = q.advance(head, SttsPlayer.Outcome.COMPLETED)

		assertEquals(entry(2), a.next)
		assertNull(b.next)
		assertEquals(entry(2), q.playing())
	}

	@Test
	fun `dropping a team takes its queued, playing and remembered entries`() {
		val q = queueOf(entry(1))
		val failing = q.startNext()!!
		q.advance(failing, SttsPlayer.Outcome.PLAYBACK_ERROR)
		q.advance(entry(1), SttsPlayer.Outcome.PLAYBACK_ERROR)
		assertEquals(listOf(entry(1)), q.remembered())

		// One of this team's entries must still be WAITING when the drop lands, or the queued half of
		// this assertion passes on an already-empty pending list and never exercises the removal.
		q.enqueue(entry(2))
		q.enqueue(entry(3, other))
		q.enqueue(entry(4))
		q.startNext()

		val tookPlaying = q.dropTeam(team)

		// Named, not just flagged: the caller stops that request by identity so a teardown cannot
		// silence a different team that happens to be the audible one.
		assertEquals(entry(2), tookPlaying)
		// A remembered failure is no longer a queued entry, so a teardown scoped to the queue alone
		// leaves it pointing at a thread forget has already removed.
		assertTrue(q.remembered().isEmpty())
		assertEquals(listOf(entry(3, other)), q.queued())
	}

	@Test
	fun `dropping a team leaves another team playing`() {
		val q = queueOf(entry(1, other), entry(2))
		val head = q.startNext()!!

		val tookPlaying = q.dropTeam(team)

		assertNull(tookPlaying)
		assertEquals(head, q.playing())
		assertEquals(listOf(entry(1, other)), q.queued())
	}

	@Test
	fun `dropping a waiting entry removes it and leaves the rest speaking in order`() {
		val q = queueOf(entry(1), entry(2), entry(3))
		val head = q.startNext()!!

		assertTrue(q.drop(entry(2)))

		assertEquals(head, q.playing())
		assertEquals(listOf(entry(1), entry(3)), q.queued())
	}

	@Test
	fun `dropping the head is refused, so nothing removes an entry the engine is already playing`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!

		// Removing it here would strand the playback: its terminal would find no entry to retire and
		// the run would stop on it. Giving up on the head is a skip, which retires it and starts the next.
		assertFalse(q.drop(head))
		assertEquals(head, q.playing())
	}

	@Test
	fun `a dropped entry that comes back counts as a first failure again`() {
		// TWO entries, because the mark has to be earned AND the marked entry has to still be waiting.
		// With one, the failure rotates it to the tail and `takeNext` promotes it straight back to head,
		// where `drop` correctly refuses it - so the original version of this test dropped an entry that
		// was never marked, and passed against a `drop` that cleared nothing at all.
		val q = queueOf(entry(1), entry(2))
		val first = q.startNext()!!
		assertNull(q.advance(first, SttsPlayer.Outcome.SYNTH_ERROR).failed)
		assertEquals(listOf(entry(2), entry(1)), q.queued())

		assertTrue(q.drop(entry(1)))
		q.enqueue(entry(1))
		q.advance(q.playing()!!, SttsPlayer.Outcome.COMPLETED)
		val revived = q.playing()!!

		// The mark went with the drop, so this counts as a first failure again - it rotates to the tail
		// rather than being discarded on what would look like its second.
		assertNull(q.advance(revived, SttsPlayer.Outcome.SYNTH_ERROR).failed)
	}

	@Test
	fun `speaking a remembered failure clears it from the alert`() {
		val q = queueOf(entry(1), entry(2))
		val first = q.startNext()!!
		q.advance(first, SttsPlayer.Outcome.SYNTH_ERROR)
		q.advance(q.playing()!!, SttsPlayer.Outcome.COMPLETED)
		val retryTarget = q.playing()!!
		q.advance(retryTarget, SttsPlayer.Outcome.SYNTH_ERROR)
		assertEquals(listOf(entry(1)), q.remembered())

		// Played by hand and actually heard. A message that has now been spoken has no business still
		// standing in the alert as one that never was - the list is about what the user MISSED.
		q.enqueue(entry(1))
		val revived = q.startNext()!!
		q.advance(revived, SttsPlayer.Outcome.COMPLETED)

		assertEquals(emptyList<QueueEntry>(), q.remembered())
	}

	@Test
	fun `skipping a remembered failure does not count as having heard it`() {
		val q = queueOf(entry(1), entry(2))
		val first = q.startNext()!!
		q.advance(first, SttsPlayer.Outcome.SYNTH_ERROR)
		q.advance(q.playing()!!, SttsPlayer.Outcome.COMPLETED)
		q.advance(q.playing()!!, SttsPlayer.Outcome.SYNTH_ERROR)
		assertEquals(listOf(entry(1)), q.remembered())

		// Re-queued and then SKIPPED. A skip retires the entry exactly as a completion does, which is
		// why the two share this branch - but only one of them means the user heard anything, and
		// clearing on both told them they had heard the very message they had just given up on.
		q.enqueue(entry(1))
		q.advance(q.startNext()!!, SttsPlayer.Outcome.STOPPED)

		assertEquals(listOf(entry(1)), q.remembered())
	}

	@Test
	fun `a failure remembers why, and the same message never doubles up`() {
		val q = queueOf(entry(1), entry(2))
		val first = q.startNext()!!
		q.advance(first, SttsPlayer.Outcome.SYNTH_ERROR, "no api key")
		q.advance(q.playing()!!, SttsPlayer.Outcome.COMPLETED)
		q.advance(q.playing()!!, SttsPlayer.Outcome.SYNTH_ERROR, "no api key")

		assertEquals("no api key", q.reasonFor(entry(1)))

		// Round two of the same outage. One row, not two: the sheet keys its list by entry and Compose
		// rejects a duplicate key outright rather than merely drawing oddly. Re-queued and failed
		// twice more, which is one rotation to the tail and then the drop - and because a single-entry
		// queue promotes its own rotation straight back to head, the second advance takes it directly.
		q.enqueue(entry(1))
		q.advance(q.startNext()!!, SttsPlayer.Outcome.SYNTH_ERROR, "no api key")
		q.advance(q.playing()!!, SttsPlayer.Outcome.SYNTH_ERROR, "still no api key")

		assertEquals(listOf(entry(1)), q.remembered())
		assertEquals("still no api key", q.reasonFor(entry(1)))
	}

	@Test
	fun `a dropped team's failure can no longer be retried into the queue`() {
		val q = queueOf(entry(1))
		val head = q.startNext()!!
		q.advance(head, SttsPlayer.Outcome.SYNTH_ERROR)

		q.dropTeam(team)
		q.enqueue(entry(1))
		val revived = q.startNext()!!

		// The retry mark went with the team, so this counts as a first failure again rather than
		// silently being dropped on what looks like its second.
		assertNull(q.advance(revived, SttsPlayer.Outcome.SYNTH_ERROR).failed)
	}
}
