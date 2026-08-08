package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A single request's identity and lifecycle: claim mints an id, started/finish gate on it, a
 * live entry refuses a second claim, finish is idempotent under racing callers, and a stale
 * hand-off from a replaced generation cannot drive the request that replaced it.
 */
class PlaybackRequestsLifecycleTest {
	private val team = "local.gw.evie-bot.main"
	private val at = 1_753_900_000_000L
	private val tier = SttsPlayer.Tier.FULL

	private fun requests() = PlaybackRequests()

	@Test
	fun `an entry runs to completion and frees itself for a later claim`() {
		val r = requests()
		val id = r.claim(team, at, tier)!!
		assertNotNull(r.started(id))
		val ended = r.finish(id, SttsPlayer.Outcome.COMPLETED)

		assertEquals(SttsPlayer.Outcome.COMPLETED, ended?.outcome)
		assertNotNull(r.claim(team, at, tier))
	}

	@Test
	fun `a re-claim is a different request from the one it replaced`() {
		val r = requests()
		val first = r.claim(team, at, tier)!!
		r.finish(first, SttsPlayer.Outcome.STOPPED)
		val second = r.claim(team, at, tier)!!

		// Without a distinct generation these would be interchangeable, and a stale hand-off naming
		// the first would silently drive the second.
		assertNotEquals(first, second)
		assertFalse(r.isLive(first))
		assertTrue(r.isLive(second))
	}

	@Test
	fun `a copied id is still the same request`() {
		val r = requests()
		val id = r.claim(team, at, tier)!!

		// Identity is structural, so passing a copy across a boundary must not silently stop matching.
		assertTrue(r.isLive(id.copy()))
		assertNotNull(r.finish(id.copy(), SttsPlayer.Outcome.COMPLETED))
	}

	@Test
	fun `an entry reports one terminal however many callers race to end it`() {
		val r = requests()
		val id = r.claim(team, at, tier)!!

		val terminals = listOf(
			r.finish(id, SttsPlayer.Outcome.COMPLETED),
			r.finish(id, SttsPlayer.Outcome.PREEMPTED),
			r.finish(id, SttsPlayer.Outcome.STOPPED),
		).filterNotNull()

		assertEquals(1, terminals.size)
		assertEquals(SttsPlayer.Outcome.COMPLETED, terminals.single().outcome)
	}

	@Test
	fun `a started is refused once the entry has already ended`() {
		val r = requests()
		val id = r.claim(team, at, tier)!!
		r.finish(id, SttsPlayer.Outcome.PREEMPTED)

		// Otherwise a Started could trail its own terminal and strand the consumer believing an
		// ended entry is still playing, with nothing left that could ever clear it.
		assertNull(r.started(id))
	}

	@Test
	fun `a second claim for a live entry is refused and leaves the first untouched`() {
		val r = requests()
		val first = r.claim(team, at, tier)!!

		assertNull(r.claim(team, at, tier))
		assertTrue(r.isLive(first))
		assertNotNull(r.finish(first, SttsPlayer.Outcome.COMPLETED))
	}

	@Test
	fun `a stale hand-off cannot drive the entry that replaced it`() {
		val r = requests()
		val stale = r.claim(team, at, tier)!!
		r.finish(stale, SttsPlayer.Outcome.PREEMPTED)
		val fresh = r.claim(team, at, tier)!!

		// The late arrival names a generation that is gone, so it neither plays nor reports.
		assertNull(r.started(stale))
		assertNull(r.finish(stale, SttsPlayer.Outcome.COMPLETED))
		assertTrue(r.isLive(fresh))
	}

	@Test
	fun `a team address containing a dash keeps its tier`() {
		val r = requests()
		val id = r.claim(team, at, SttsPlayer.Tier.SUMMARY)!!

		// The tier is carried rather than parsed back out of a composite key, so a dash inside the
		// team segment cannot swallow it.
		assertEquals(SttsPlayer.Tier.SUMMARY, r.started(id)?.tier)
		assertEquals(SttsPlayer.Tier.SUMMARY, r.finish(id, SttsPlayer.Outcome.COMPLETED)?.tier)
	}

	@Test
	fun `a message reads as playing while any of its tiers is claimed`() {
		val r = requests()
		assertFalse(r.isLiveForMessage(team, at))

		val id = r.claim(team, at, SttsPlayer.Tier.SUMMARY)!!
		// The button toggles by message because it cannot know which tier an autoplay chose, so this
		// must answer for any tier - and must not answer for a neighbouring message.
		assertTrue(r.isLiveForMessage(team, at))
		assertFalse(r.isLiveForMessage(team, at + 1))
		assertFalse(r.isLiveForMessage("local.gw.other.main", at))

		r.finish(id, SttsPlayer.Outcome.COMPLETED)
		assertFalse(r.isLiveForMessage(team, at))
	}

	@Test
	fun `a request reports its own failure without ending the one that replaced it`() {
		val r = requests()
		val first = r.claim(team, at, tier)!!
		r.finish(first, SttsPlayer.Outcome.STOPPED)
		val second = r.claim(team, at, tier)!!

		val drop = r.finishRequest(first, SttsPlayer.Outcome.PLAYBACK_ERROR, "decode failed")

		// Entry-scoped, this would kill `second`: a late callback from a dead player would take down
		// the playback that replaced it and report an error the user never saw.
		assertTrue(drop.events.isEmpty())
		assertTrue(r.isLive(second))
	}

	@Test
	fun `events name the request so a stale terminal is distinguishable`() {
		val r = requests()
		val first = r.claim(team, at, tier)!!
		val started = r.started(first)!!
		val ended = r.finish(first, SttsPlayer.Outcome.PREEMPTED)!!
		val second = r.claim(team, at, tier)!!

		assertEquals(first.gen, started.gen)
		assertEquals(first.gen, ended.gen)
		// Same team, same at, same tier, different request. Without the generation a consumer holding
		// the second one cannot tell the first one's terminal from its own.
		assertNotEquals(ended.gen, r.started(second)!!.gen)
	}

	@Test
	fun `the sample entry has no tier and still reports its own outcome`() {
		val r = requests()
		val id = r.claim(SttsPlayer.SAMPLE_TEAM, 0, null)!!

		val ended = r.finish(id, SttsPlayer.Outcome.SYNTH_ERROR, "no key")

		assertEquals(SttsPlayer.SAMPLE_TEAM, ended?.team)
		assertNull(ended?.tier)
		assertEquals("no key", ended?.reason)
	}
}
