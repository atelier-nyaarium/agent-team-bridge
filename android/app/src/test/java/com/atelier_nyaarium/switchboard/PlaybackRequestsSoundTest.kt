package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one audible slot: taking it, yielding for it, displacing whoever holds it, and reporting
 * which request a drop actually took the sound away from.
 */
class PlaybackRequestsSoundTest {
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
	fun `taking the sound reports the request it displaced`() {
		val r = requests()
		val first = r.claim(team, at, SttsPlayer.Tier.TITLE)!!
		r.sound(first)
		val second = r.claim(team, at, SttsPlayer.Tier.FULL)!!

		val drop = r.sound(second)!!

		assertEquals(listOf(SttsPlayer.Outcome.PREEMPTED), drop.events.map { it.outcome })
		assertEquals(SttsPlayer.Tier.TITLE, drop.events.single().tier)
		assertEquals(first, drop.soundingEnded)
		assertFalse(r.isLive(first))
	}

	@Test
	fun `a yielding request stands down instead of interrupting`() {
		val r = requests()
		val heard = Heard()
		heard.subscribe(r)
		val mine = r.claim(team, at, SttsPlayer.Tier.FULL)!!
		r.sound(mine)
		r.started(mine)

		// Handed to the player before the person acted, and only now ready: displacing here has no
		// caller left to ask, so it must yield instead.
		val auto = r.claim(team, at + 1, SttsPlayer.Tier.TITLE)!!
		val drop = r.sound(auto, yielding = true)

		assertNull(drop)
		assertTrue(r.isLive(mine))
		assertTrue(r.isSoundingForMessage(team, at))
		// It reports its OWN terminal on the way out, so a queue waiting on it is not left hanging.
		assertFalse(r.isLive(auto))
		assertEquals(
			listOf("start:FULL:1", "end:TITLE:2:PREEMPTED"),
			heard.transcript(),
		)
	}

	@Test
	fun `a yielding request takes silence`() {
		val r = requests()
		val auto = r.claim(team, at, tier)!!

		// Yielding is about not INTERRUPTING. With nothing audible there is nothing to yield to.
		assertNotNull(r.sound(auto, yielding = true))
		assertTrue(r.isSoundingForMessage(team, at))
	}

	@Test
	fun `a request the user made still displaces`() {
		val r = requests()
		val auto = r.claim(team, at, SttsPlayer.Tier.TITLE)!!
		r.sound(auto)

		val mine = r.claim(team, at + 1, SttsPlayer.Tier.FULL)!!
		val drop = r.sound(mine)!!

		// The asymmetry IS the rule: autoplay yields to a person, a person never yields to autoplay.
		assertEquals(auto, drop.soundingEnded)
		assertTrue(r.isSoundingForMessage(team, at + 1))
	}

	@Test
	fun `a request abandoned before it reaches the player never takes the sound`() {
		val r = requests()
		val id = r.claim(team, at, tier)!!
		r.finishEntry(team, at, tier, SttsPlayer.Outcome.PREEMPTED)

		assertNull(r.sound(id))
	}

	@Test
	fun `a bulk drop reports whether it took the sounding request`() {
		val r = requests()
		val silent = r.claim(team, at, SttsPlayer.Tier.TITLE)!!

		val quiet = r.finishTeam(team, SttsPlayer.Outcome.PREEMPTED)
		assertNull(quiet.soundingEnded)

		val loud = r.claim(team, at, SttsPlayer.Tier.FULL)!!
		r.sound(loud)
		assertEquals(loud, r.finishTeam(team, SttsPlayer.Outcome.PREEMPTED).soundingEnded)
		assertFalse(r.isLive(silent))
	}

	@Test
	fun `ending the sounding request leaves other claims running`() {
		val r = requests()
		val loud = r.claim(team, at, SttsPlayer.Tier.FULL)!!
		r.sound(loud)
		val silent = r.claim(team, at, SttsPlayer.Tier.TITLE)!!

		val drop = r.finishSounding(SttsPlayer.Outcome.STOPPED)

		assertEquals(listOf(SttsPlayer.Outcome.STOPPED), drop.events.map { it.outcome })
		assertEquals(loud, drop.soundingEnded)
		assertTrue(r.isLive(silent))
	}

	@Test
	fun `a drop names the request that lost the sound`() {
		val r = requests()
		val loud = r.claim(team, at, tier)!!
		r.sound(loud)

		val drop = r.finishSounding(SttsPlayer.Outcome.STOPPED)

		// The caller releases the player under a different lock than the one this decision was taken
		// under, so it needs the identity to check its player against, not a yes.
		assertEquals(loud, drop.soundingEnded)
		assertNull(r.finishSounding(SttsPlayer.Outcome.STOPPED).soundingEnded)
	}

	@Test
	fun `a drop that misses the sounding request names nothing`() {
		val r = requests()
		val loud = r.claim(team, at, SttsPlayer.Tier.FULL)!!
		r.sound(loud)
		r.claim(team, at, SttsPlayer.Tier.TITLE)!!

		val drop = r.finishEntry(team, at, SttsPlayer.Tier.TITLE, SttsPlayer.Outcome.PREEMPTED)

		// Naming a request here would have the caller release a player this drop never took.
		assertNull(drop.soundingEnded)
		assertTrue(r.isLive(loud))
	}

	@Test
	fun `a second tap while synthesizing does not cancel it`() {
		val r = requests()
		val id = r.claim(team, at, tier)!!

		// The impatient double-tap. Cancelling here left the message permanently silent: the tap read
		// as a stop, and single-flight then refused the re-claim it never made.
		val drop = r.finishIfSounding(team, at, tier, SttsPlayer.Outcome.STOPPED)

		assertTrue(drop.events.isEmpty())
		assertTrue(r.isLive(id))
		assertNull(r.claim(team, at, tier))
	}

	@Test
	fun `stopping by sound ends the entry only once it is audible`() {
		val r = requests()
		val id = r.claim(team, at, tier)!!
		r.sound(id)

		val drop = r.finishIfSounding(team, at, tier, SttsPlayer.Outcome.STOPPED)

		assertEquals(listOf(SttsPlayer.Outcome.STOPPED), drop.events.map { it.outcome })
		assertEquals(id, drop.soundingEnded)
		// Naming a different entry must not end the audible one.
		assertNull(r.finishIfSounding(team, at + 1, tier, SttsPlayer.Outcome.STOPPED).soundingEnded)
	}

	@Test
	fun `a message sounds only while it is audible`() {
		val r = requests()
		val id = r.claim(team, at, tier)!!

		// Claimed but still synthesizing: live for the message, not yet audible. The row shows nothing
		// either way, which is why the button toggles on the second question and not the first.
		assertTrue(r.isLiveForMessage(team, at))
		assertFalse(r.isSoundingForMessage(team, at))

		r.sound(id)
		assertTrue(r.isSoundingForMessage(team, at))
		assertFalse(r.isSoundingForMessage(team, at + 1))

		r.finish(id, SttsPlayer.Outcome.COMPLETED)
		assertFalse(r.isSoundingForMessage(team, at))
	}
}
