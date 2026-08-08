package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The queue reads outcomes to decide whether to advance, so the contract under test is what a
 * consumer OBSERVES: how many events an entry produces and in what order, not which fields the map
 * holds.
 */
class PlaybackRequestsListenerTest {
	private val team = "local.gw.evie-bot.main"
	private val at = 1_753_900_000_000L
	private val tier = SttsPlayer.Tier.FULL

	private fun requests() = PlaybackRequests()

	/** What a listener actually saw, in the order it saw it. The delivered transcript is the contract
	 * every consumer reads, and until delivery moved into the registry no test could reach it. */
	private class Heard {
		val events = mutableListOf<SttsPlayer.Event>()

		fun subscribe(r: PlaybackRequests) = r.addListener { events += it }

		fun transcript() = events.map {
			when (it) {
				is SttsPlayer.Event.Started -> "start:${it.tier}:${it.gen}"
				is SttsPlayer.Event.Ended -> "end:${it.tier}:${it.gen}:${it.outcome}"
			}
		}
	}

	@Test
	fun `a listener sees each transition once, in the order it happened`() {
		val r = requests()
		val heard = Heard()
		heard.subscribe(r)

		val id = r.claim(team, at, tier)!!
		r.sound(id)
		r.started(id)
		r.finish(id, SttsPlayer.Outcome.COMPLETED)

		assertEquals(listOf("start:FULL:1", "end:FULL:1:COMPLETED"), heard.transcript())
	}

	@Test
	fun `preemption is delivered before the start that caused it`() {
		val r = requests()
		val heard = Heard()
		heard.subscribe(r)

		val first = r.claim(team, at, SttsPlayer.Tier.TITLE)!!
		r.sound(first)
		r.started(first)
		val second = r.claim(team, at, SttsPlayer.Tier.FULL)!!
		r.sound(second)
		r.started(second)

		// The whole point of moving delivery in here. A consumer reading this transcript never has to
		// wonder whether a Started it just saw belongs to a request that already ended.
		assertEquals(
			listOf("start:TITLE:1", "end:TITLE:1:PREEMPTED", "start:FULL:2"),
			heard.transcript(),
		)
	}

	@Test
	fun `a request that ends before it sounds never reports a start`() {
		val r = requests()
		val heard = Heard()
		heard.subscribe(r)

		val id = r.claim(team, at, tier)!!
		r.finish(id, SttsPlayer.Outcome.STOPPED)
		r.started(id)

		// started() is refused after the terminal, so the stranded-row case cannot be delivered at all.
		assertEquals(listOf("end:FULL:1:STOPPED"), heard.transcript())
	}

	@Test
	fun `a listener that throws does not rob the others`() {
		val r = requests()
		val heard = Heard()
		r.addListener { error("subscriber blew up") }
		heard.subscribe(r)

		val id = r.claim(team, at, tier)!!
		r.finish(id, SttsPlayer.Outcome.COMPLETED)

		assertEquals(listOf("end:FULL:1:COMPLETED"), heard.transcript())
	}

	@Test
	fun `a removed listener stops hearing`() {
		val r = requests()
		val heard = Heard()
		val handle = heard.subscribe(r)

		r.claim(team, at, tier)!!.also { r.finish(it, SttsPlayer.Outcome.COMPLETED) }
		r.removeListener(handle)
		r.claim(team, at + 1, tier)!!.also { r.finish(it, SttsPlayer.Outcome.COMPLETED) }

		assertEquals(1, heard.events.size)
	}
}
