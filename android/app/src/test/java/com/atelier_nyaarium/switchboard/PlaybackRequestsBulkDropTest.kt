package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Bulk drops scoped by team, entry, message, or generation: each sweep must end exactly the
 * claims within its named scope and leave every claim outside it running.
 */
class PlaybackRequestsBulkDropTest {
	private val team = "local.gw.evie-bot.main"
	private val at = 1_753_900_000_000L
	private val tier = SttsPlayer.Tier.FULL

	private fun requests() = PlaybackRequests()

	@Test
	fun `dropping a team ends its claims even when none is playing`() {
		val r = requests()
		val mine = r.claim(team, at, SttsPlayer.Tier.FULL)!!
		val alsoMine = r.claim(team, at + 1, SttsPlayer.Tier.TITLE)!!
		val other = r.claim("local.gw.other.main", at, SttsPlayer.Tier.FULL)!!

		val ended = r.finishTeam(team, SttsPlayer.Outcome.PREEMPTED).events

		// The outcome is what a consumer branches on, so asserting only the count would let a bulk
		// path report COMPLETED and have a queue advance as though purged audio had been heard.
		assertEquals(listOf(SttsPlayer.Outcome.PREEMPTED, SttsPlayer.Outcome.PREEMPTED), ended.map { it.outcome })
		assertEquals(setOf(at, at + 1), ended.map { it.at }.toSet())
		assertTrue(ended.all { it.team == team })
		assertFalse(r.isLive(mine))
		assertFalse(r.isLive(alsoMine))
		assertTrue(r.isLive(other))
	}

	@Test
	fun `dropping everything ends every team's claims with the outcome given`() {
		val r = requests()
		val mine = r.claim(team, at, tier)!!
		val other = r.claim("local.gw.other.main", at, SttsPlayer.Tier.TITLE)!!

		val ended = r.finishAll(SttsPlayer.Outcome.PREEMPTED).events

		assertEquals(2, ended.size)
		assertTrue(ended.all { it.outcome == SttsPlayer.Outcome.PREEMPTED })
		assertFalse(r.isLive(mine))
		assertFalse(r.isLive(other))
		assertNotNull(r.claim(team, at, tier))
	}

	@Test
	fun `a claim dropped in bulk cannot still be played`() {
		val r = requests()
		val id = r.claim(team, at, tier)!!
		r.finishTeam(team, SttsPlayer.Outcome.PREEMPTED)

		// The synthesis that was already running must not resurrect a purged team's audio.
		assertNull(r.started(id))
		assertNull(r.finish(id, SttsPlayer.Outcome.COMPLETED))
	}

	@Test
	fun `abandoning one tier leaves the sibling tiers of the same message alone`() {
		val r = requests()
		val full = r.claim(team, at, SttsPlayer.Tier.FULL)!!
		val title = r.claim(team, at, SttsPlayer.Tier.TITLE)!!

		val ended = r.finishEntry(team, at, SttsPlayer.Tier.FULL, SttsPlayer.Outcome.PREEMPTED).events.single()

		assertEquals(SttsPlayer.Tier.FULL, ended.tier)
		assertTrue(r.isLive(title))
		assertNull(r.finish(full, SttsPlayer.Outcome.COMPLETED))
	}

	@Test
	fun `finishing by entry ends whichever generation is live`() {
		val r = requests()
		r.claim(team, at, tier)
		r.finishEntry(team, at, tier, SttsPlayer.Outcome.STOPPED)
		val second = r.claim(team, at, tier)!!

		val ended = r.finishEntry(team, at, tier, SttsPlayer.Outcome.PREEMPTED).events.single()

		assertEquals(SttsPlayer.Outcome.PREEMPTED, ended.outcome)
		assertNull(r.finish(second, SttsPlayer.Outcome.COMPLETED))
		assertNotNull(r.claim(team, at, tier))
	}

	@Test
	fun `a bulk drop leaves a newer claim for the same entry alone`() {
		val r = requests()
		val old = r.claim(team, at, tier)!!
		r.sound(old)
		val other = r.claim("local.gw.other.main", at, tier)!!
		r.finishTeam(team, SttsPlayer.Outcome.PREEMPTED)
		val fresh = r.claim(team, at, tier)!!
		r.sound(fresh)

		// Sweeping the OTHER team must not match the old terminal against the new sounding request and
		// release a player the new claim still owns, orphaning it with no terminal path left. The
		// sweep has to actually hit something, or this passes without exercising the comparison.
		val drop = r.finishTeam("local.gw.other.main", SttsPlayer.Outcome.PREEMPTED)

		assertEquals(listOf(other.at), drop.events.map { it.at })
		assertNull(drop.soundingEnded)
		assertTrue(r.isLive(fresh))
	}

	@Test
	fun `stopping a message ends the tier that is synthesizing, not whatever is audible`() {
		val r = requests()
		val other = r.claim("local.gw.other.main", at, SttsPlayer.Tier.FULL)!!
		r.sound(other)
		val mine = r.claim(team, at, SttsPlayer.Tier.SUMMARY)!!

		val drop = r.finishMessage(team, at, SttsPlayer.Outcome.STOPPED)

		// The button asks isLiveForMessage and must act on the same answer. Scoped to the sounding
		// request instead, this tap silenced an unrelated message and left the tapped one running.
		assertEquals(listOf(SttsPlayer.Outcome.STOPPED), drop.events.map { it.outcome })
		assertEquals(SttsPlayer.Tier.SUMMARY, drop.events.single().tier)
		assertNull(drop.soundingEnded)
		assertFalse(r.isLive(mine))
		assertTrue(r.isLive(other))
	}

	@Test
	fun `superseding a team spares the entry that is replacing it`() {
		val r = requests()
		val otherVoice = r.claim(SttsPlayer.SAMPLE_TEAM, 100, null)!!
		val thisVoice = r.claim(SttsPlayer.SAMPLE_TEAM, 200, null)!!

		val drop = r.finishTeamExcept(SttsPlayer.SAMPLE_TEAM, 200, null, SttsPlayer.Outcome.PREEMPTED)

		// Sweeping the whole team would end the synthesis a second tap is waiting on, and the re-claim
		// behind it would pay a provider twice for audio already in flight.
		assertEquals(listOf(100L), drop.events.map { it.at })
		assertFalse(r.isLive(otherVoice))
		assertTrue(r.isLive(thisVoice))
		assertNull(r.claim(SttsPlayer.SAMPLE_TEAM, 200, null))
	}

	@Test
	fun `a generation ends one request even when the entry key is reused`() {
		val r = requests()
		// A marker's key is derived from the words it speaks, so every run of one session shares it.
		// The generation is the only thing that tells two such requests apart.
		val first = r.claim(SttsPlayer.MARKER_TEAM, 77, null)!!
		r.finish(first, SttsPlayer.Outcome.PREEMPTED)
		val second = r.claim(SttsPlayer.MARKER_TEAM, 77, null)!!

		assertTrue(r.finishGeneration(first.gen, SttsPlayer.Outcome.PREEMPTED).events.isEmpty())
		assertTrue(r.isLive(second))

		val ended = r.finishGeneration(second.gen, SttsPlayer.Outcome.PREEMPTED).events.single()
		assertEquals(second.gen, ended.gen)
		assertFalse(r.isLive(second))
	}
}
