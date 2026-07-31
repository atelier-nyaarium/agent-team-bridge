package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The queue is read through what it hands back to play next, so that is what these assert. Which
 * outcome advances and which holds is the contract Phase 1 rests on: a decode failure that retires an
 * entry as though it were heard loses a message silently.
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
	fun `a pause holds its place instead of walking forward`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!

		val step = q.advance(head, SttsPlayer.Outcome.STOPPED)

		assertTrue(step.paused)
		assertNull(step.next)
		assertEquals(entry(1), q.playing())
		assertEquals(entry(1), q.resume())
	}

	@Test
	fun `being replaced advances, because something else is already speaking`() {
		val q = queueOf(entry(1), entry(2))
		val head = q.startNext()!!

		val step = q.advance(head, SttsPlayer.Outcome.PREEMPTED)

		assertFalse(step.paused)
		assertEquals(entry(2), step.next)
	}

	@Test
	fun `a failure goes to the tail once, then is dropped and remembered`() {
		val q = queueOf(entry(1), entry(2))
		val first = q.startNext()!!

		// Behind everything already waiting, not ahead of it: a transient failure must not starve the
		// messages queued after it.
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

		// A terminal from a request that was already replaced. Acting on it would retire entry 2
		// without it ever being spoken.
		val late = q.advance(entry(1), SttsPlayer.Outcome.COMPLETED)

		assertNull(late.next)
		assertEquals(entry(2), q.playing())
	}

	@Test
	fun `two advances for one head cannot both move the queue`() {
		val q = queueOf(entry(1), entry(2), entry(3))
		val head = q.startNext()!!

		// A player completion and a user swipe arriving together. Read-head-then-mutate would let both
		// through and skip entry 2 entirely.
		val a = q.advance(head, SttsPlayer.Outcome.COMPLETED)
		val b = q.advance(head, SttsPlayer.Outcome.COMPLETED)

		assertEquals(entry(2), a.next)
		assertNull(b.next)
		assertEquals(entry(2), q.playing())
	}

	@Test
	fun `dropping a team takes its queued, playing and remembered entries`() {
		val q = queueOf(entry(1), entry(2, other), entry(3))
		val head = q.startNext()!!
		q.advance(head, SttsPlayer.Outcome.PLAYBACK_ERROR)
		q.advance(entry(2, other), SttsPlayer.Outcome.COMPLETED)
		q.advance(entry(3), SttsPlayer.Outcome.COMPLETED)
		q.advance(entry(1), SttsPlayer.Outcome.PLAYBACK_ERROR)
		assertEquals(listOf(entry(1)), q.remembered())

		q.enqueue(entry(4))
		q.startNext()
		val tookPlaying = q.dropTeam(team)

		// A remembered failure is no longer queued, so a teardown scoped to queued entries alone would
		// leave it pointing at a thread forget has already removed.
		assertTrue(tookPlaying)
		assertTrue(q.remembered().isEmpty())
		assertTrue(q.queued().isEmpty())
	}

	@Test
	fun `dropping a team leaves another team playing`() {
		val q = queueOf(entry(1, other), entry(2))
		val head = q.startNext()!!

		val tookPlaying = q.dropTeam(team)

		assertFalse(tookPlaying)
		assertEquals(head, q.playing())
		assertEquals(listOf(entry(1, other)), q.queued())
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
