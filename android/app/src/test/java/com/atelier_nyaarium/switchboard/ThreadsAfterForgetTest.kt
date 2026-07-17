package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `threadsAfterForget` drops the forgotten team's own thread AND sweeps every remaining thread for
 * a peer-mirror row naming it as a real party - the gateway mirrors an agent-to-agent exchange into
 * both participants' mailboxes as separate thread keys, so Forget must reach both copies.
 */
class ThreadsAfterForgetTest {
	private fun ordinary(text: String, from: String? = null) = Message(fromMe = false, text = text, at = 1000L, from = from)

	private fun peer(text: String, from: String?, to: String?) =
		Message(fromMe = false, text = text, at = 1000L, from = from, to = to, isPeer = true)

	@Test
	fun dropsTheForgottenTeamsOwnThread() {
		val threads = mapOf("alice.sakura.coolapp.main" to listOf(ordinary("hi")))
		val result = threadsAfterForget(threads, "alice.sakura.coolapp.main")
		assertFalse("alice.sakura.coolapp.main" in result.threads)
	}

	@Test
	fun leavesUnrelatedSiblingThreadsUntouched() {
		val threads = mapOf(
			"alice.sakura.coolapp.main" to listOf(ordinary("hi")),
			"bob.sakura.other.main" to listOf(ordinary("unrelated")),
		)
		val result = threadsAfterForget(threads, "alice.sakura.coolapp.main")
		assertEquals(listOf(ordinary("unrelated")), result.threads["bob.sakura.other.main"])
	}

	@Test
	fun sweepsAPeerRowNamingTheForgottenTeamAsFrom() {
		val forgotten = "alice.sakura.coolapp.main"
		val threads = mapOf(
			forgotten to listOf(peer("mirrored", from = forgotten, to = "alice.sakura.coollib.main")),
			"alice.sakura.coollib.main" to listOf(peer("mirrored", from = forgotten, to = "alice.sakura.coollib.main")),
		)
		val result = threadsAfterForget(threads, forgotten)
		assertTrue(result.threads.getValue("alice.sakura.coollib.main").isEmpty())
	}

	@Test
	fun sweepsAPeerRowNamingTheForgottenTeamAsTo() {
		val forgotten = "alice.sakura.coollib.main"
		val threads = mapOf(
			forgotten to listOf(peer("mirrored", from = "alice.sakura.coolapp.main", to = forgotten)),
			"alice.sakura.coolapp.main" to listOf(peer("mirrored", from = "alice.sakura.coolapp.main", to = forgotten)),
		)
		val result = threadsAfterForget(threads, forgotten)
		assertTrue(result.threads.getValue("alice.sakura.coolapp.main").isEmpty())
	}

	@Test
	fun keepsOtherRowsInASiblingThreadThatSweepsOnlyOneRow() {
		val forgotten = "alice.sakura.coolapp.main"
		val keptRow = ordinary("still here")
		val threads = mapOf(
			"alice.sakura.coollib.main" to listOf(
				peer("mirrored", from = forgotten, to = "alice.sakura.coollib.main"),
				keptRow,
			),
		)
		val result = threadsAfterForget(threads, forgotten)
		assertEquals(listOf(keptRow), result.threads["alice.sakura.coollib.main"])
	}

	@Test
	fun neverSweepsAnOrdinaryRowEvenIfItsFromHappensToMatch() {
		// isPeer, not from/to alone, is the discriminator - an ordinary row is never persisted with a
		// real from in practice, but the sweep must not rely on that; it must check isPeer explicitly.
		val forgotten = "alice.sakura.coolapp.main"
		val lookalike = ordinary("not actually a peer row", from = forgotten)
		val threads = mapOf("bob.sakura.other.main" to listOf(lookalike))
		val result = threadsAfterForget(threads, forgotten)
		assertEquals(listOf(lookalike), result.threads["bob.sakura.other.main"])
	}

	@Test
	fun droppedCollectsTheForgottenTeamsOwnRowsPlusEverySweptPeerRow() {
		val forgotten = "alice.sakura.coolapp.main"
		val ownRow = ordinary("own thread row")
		val sweptRow = peer("mirrored", from = forgotten, to = "alice.sakura.coollib.main")
		val keptRow = ordinary("stays")
		val threads = mapOf(
			forgotten to listOf(ownRow),
			"alice.sakura.coollib.main" to listOf(sweptRow, keptRow),
		)
		val result = threadsAfterForget(threads, forgotten)
		assertEquals(setOf(ownRow, sweptRow), result.dropped.toSet())
	}

	@Test
	fun droppedIsEmptyWhenNothingMatchesTheForgottenKey() {
		val threads = mapOf("bob.sakura.other.main" to listOf(ordinary("unrelated")))
		val result = threadsAfterForget(threads, "alice.sakura.coolapp.main")
		assertTrue(result.dropped.isEmpty())
	}
}
