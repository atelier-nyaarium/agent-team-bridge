package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The boundary marker names who is about to speak. It depends only on the speaker, never on the
 * message, which is what lets one synthesis serve every message in that session. Pure function test,
 * no Android context.
 */
class SentinelTextTest {
	private val team = "alice.sakura.coollib.main"

	private fun stateWith(labels: Map<String, String>) = ChatState(labels = labels)

	private fun ordinary() = Message(fromMe = false, text = "hello there", at = 1000L, from = team)

	private fun peer(from: String?, to: String?) = Message(
		fromMe = false,
		text = "hello there",
		at = 1000L,
		from = from,
		to = to,
		isPeer = true,
	)

	@Test
	fun anOrdinaryRowIsAnnouncedByItsSessionLabel() {
		val state = stateWith(mapOf(team to "CoolLib"))
		assertEquals("CoolLib", sentinelText(state, ordinary(), team))
	}

	@Test
	fun anUnlabelledSessionFallsBackToItsLeaf() {
		// Never blank: the marker exists to say who is speaking, so an unresolved label still names
		// something a listener can place.
		assertEquals("main", sentinelText(stateWith(emptyMap()), ordinary(), team))
	}

	@Test
	fun aPeerRowNamesBothParties() {
		val state = stateWith(mapOf("alice.sakura.coolapp.main" to "CoolApp", team to "CoolLib"))
		val m = peer(from = "alice.sakura.coolapp.main", to = team)

		// Neither party is this console's own team, so announcing only one would be misleading about
		// who is talking to whom.
		assertEquals("CoolApp on CoolLib", sentinelText(state, m, team))
	}

	@Test
	fun aPeerRowWithNoAuthorStillAnnouncesSomething() {
		val state = stateWith(mapOf(team to "CoolLib"))
		assertEquals("someone on CoolLib", sentinelText(state, peer(from = null, to = team), team))
	}

	@Test
	fun aPeerRowWithNoRecipientNamesOnlyTheAuthor() {
		val state = stateWith(mapOf("alice.sakura.coolapp.main" to "CoolApp"))
		assertEquals("CoolApp", sentinelText(state, peer(from = "alice.sakura.coolapp.main", to = null), team))
	}

	@Test
	fun theMarkerIgnoresTheMessageItPrecedes() {
		val state = stateWith(mapOf(team to "CoolLib"))
		val first = Message(fromMe = false, text = "first", at = 1000L, from = team)
		val second = Message(fromMe = false, text = "second and much longer", at = 2000L, from = team)

		// The cache key is the speaker, not the message. If these ever differed, every message in a
		// session would pay for its own synthesis of the same spoken words.
		assertEquals(sentinelText(state, first, team), sentinelText(state, second, team))
	}
}
