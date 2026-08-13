package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Purging a team or wiping everything marks in-flight work stale from a captured horizon, without
 * mistaking an ordinary preemption for a purge or a cache warm-up's horizon-only presence for a
 * claim.
 */
class PlaybackRequestsPurgeTest {
	private val team = "local.gw.evie-bot.main"
	private val at = 1_753_900_000_000L
	private val tier = SttsPlayer.Tier.FULL

	private fun requests() = PlaybackRequests()

	/** What a listener actually saw, in the order it saw it. The delivered transcript is the contract
	 * every consumer reads, and until delivery moved into the registry no test could reach it. */
	private class Heard {
		val events = mutableListOf<Event>()

		fun subscribe(r: PlaybackRequests) = r.addListener { events += it }

		fun transcript() = events.map {
			when (it) {
				is Event.Started -> "start:${it.tier}:${it.gen}"
				is Event.Ended -> "end:${it.tier}:${it.gen}:${it.outcome}"
			}
		}
	}

	@Test
	fun `a cache warm-up needs no claim to be reachable by a purge`() {
		val r = requests()
		val heard = Heard()
		heard.subscribe(r)
		// A warm-up holds nothing here. It captures the horizon and asks later, rather than holding a
		// claim, a role, or any other per-item marker.
		val horizon = r.purgeStamp()

		r.purgeTeam(team)

		assertTrue(r.purgedSince(team, horizon))
		// Silent by construction rather than by a suppression rule every bulk path had to remember:
		// nothing was claimed, so there is no request to report a terminal for.
		assertTrue(heard.transcript().isEmpty())
		// And it never made the message read as playing, which is what sharing the play entry did.
		assertFalse(r.isLiveForMessage(team, at))
	}

	@Test
	fun `a request claimed after its team was purged is stale`() {
		val r = requests()
		val before = r.claim(team, at, tier)!!
		assertFalse(r.isStale(before))

		r.purgeTeam(team)
		// Claimed in the gap AFTER the purge, so it holds a perfectly live claim and is still unwanted:
		// its synthesis would recreate the directory the purge just deleted.
		val after = r.claim(team, at, tier)!!

		assertTrue(r.isStale(before))
		assertFalse(r.isStale(after))
		assertFalse(r.isStale(r.claim("local.gw.other.main", at, tier)!!))
	}

	@Test
	fun `preempting a team is not a purge`() {
		val r = requests()
		val id = r.claim(team, at, tier)!!

		r.finishTeam(team, SttsPlayer.Outcome.PREEMPTED)

		// The voice sample preempts a whole team to supersede itself. Stamping there made an in-flight
		// synthesis read as purged and delete the audio it had just paid for.
		assertFalse(r.isStale(id))
	}

	@Test
	fun `a horizon captured before the first claim sees a purge between claims`() {
		val r = requests()
		val horizon = r.purgeStamp()
		r.claim(team, at, SttsPlayer.Tier.SUMMARY)!!.also { r.finish(it, SttsPlayer.Outcome.COMPLETED) }

		// The purge lands in the gap where a per-tier producer holds no claim, so nothing sweeps it and
		// the NEXT claim is minted after the stamp - which is why the horizon cannot be re-read.
		r.purgeTeam(team)
		val next = r.claim(team, at, SttsPlayer.Tier.FULL)!!

		assertFalse(r.isStale(next))
		assertTrue(r.purgedSince(team, horizon))
		assertFalse(r.purgedSince("local.gw.other.main", horizon))
	}

	@Test
	fun `a wipe makes every team's in-flight work stale`() {
		val r = requests()
		val mine = r.claim(team, at, tier)!!
		val other = r.claim("local.gw.other.main", at, tier)!!

		r.purgeEverything()

		assertTrue(r.isStale(mine))
		assertTrue(r.isStale(other))
		// A team that held no claim at the moment of the wipe is covered too, which is the whole gap:
		// a preload between two tiers owns nothing the sweep could have found.
		assertTrue(r.isStale(mine.copy(team = "local.gw.third.main")))
		assertFalse(r.isStale(r.claim(team, at + 1, tier)!!))
	}
}
