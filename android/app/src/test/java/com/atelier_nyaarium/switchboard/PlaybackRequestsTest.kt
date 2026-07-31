package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The queue reads outcomes to decide whether to advance, so the contract under test is what a
 * consumer OBSERVES: how many events an entry produces and in what order, not which fields the map
 * holds.
 */
class PlaybackRequestsTest {
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
	fun `taking the sound reports the request it displaced`() {
		val r = requests()
		val first = r.claim(team, at, SttsPlayer.Tier.TITLE)!!
		r.sound(first)
		val second = r.claim(team, at, SttsPlayer.Tier.FULL)!!

		val drop = r.sound(second)!!

		// Preemption reporting the predecessor was one of the reasons to extract this; until the
		// sounding pointer moved in here it sat inside playFile where no test could reach it.
		assertEquals(listOf(SttsPlayer.Outcome.PREEMPTED), drop.events.map { it.outcome })
		assertEquals(SttsPlayer.Tier.TITLE, drop.events.single().tier)
		assertEquals(first, drop.soundingEnded)
		assertFalse(r.isLive(first))
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
	fun `a preload does not make its message read as playing`() {
		val r = requests()
		r.claim(team, at, tier, PlaybackRole.PRELOAD)!!

		// Pre-generation used to share the play entry, so the button read "playing" for the whole
		// synthesis: it stopped whatever else was audible instead of starting this.
		assertFalse(r.isLiveForMessage(team, at))
		assertFalse(r.isLive(team, at, tier))
	}

	@Test
	fun `a play request and a preload of the same tier coexist`() {
		val r = requests()
		val warm = r.claim(team, at, tier, PlaybackRole.PRELOAD)!!

		// A tap landing mid-preload has to start audio, not be refused by the warm-up's claim.
		val play = r.claim(team, at, tier)!!
		assertTrue(r.isLive(warm))
		assertTrue(r.isLive(play))
		assertNotEquals(warm, play)
	}

	@Test
	fun `stopping an entry leaves its preload running`() {
		val r = requests()
		val warm = r.claim(team, at, tier, PlaybackRole.PRELOAD)!!
		r.claim(team, at, tier)!!

		val ended = r.finishEntry(team, at, tier, SttsPlayer.Outcome.STOPPED).events.single()

		// STOPPED is the outcome a queue does not advance on, so it must name the request the user
		// stopped and never the cache warm-up behind it.
		assertEquals(SttsPlayer.Outcome.STOPPED, ended.outcome)
		assertTrue(r.isLive(warm))
	}

	@Test
	fun `a purge reaches a preload but reports no terminal for it`() {
		val r = requests()
		val warm = r.claim(team, at, tier, PlaybackRole.PRELOAD)!!

		val drop = r.finishTeam(team, SttsPlayer.Outcome.PREEMPTED)

		// Swept, so its hand-off cannot recreate the directory the purge just deleted - but silent,
		// because no consumer ever saw it start and its Ended would clear a glyph it never lit.
		assertFalse(r.isLive(warm))
		assertTrue(drop.events.isEmpty())
		assertNull(r.finish(warm, SttsPlayer.Outcome.COMPLETED))
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
	fun `stopping a message spares its preload`() {
		val r = requests()
		val warm = r.claim(team, at, tier, PlaybackRole.PRELOAD)!!
		r.claim(team, at, tier)!!

		val drop = r.finishMessage(team, at, SttsPlayer.Outcome.STOPPED)

		assertEquals(1, drop.events.size)
		assertTrue(r.isLive(warm))
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
