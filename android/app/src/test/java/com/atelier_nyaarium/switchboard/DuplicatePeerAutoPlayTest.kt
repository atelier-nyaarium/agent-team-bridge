package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The gateway mirrors one agent-to-agent exchange into BOTH local participants' own threads as
 * separate `"peer"` mailbox entries (see CLAUDE.md's Agent-to-agent mirroring). Both copies reach
 * the poll loop's burst map as `fromMe = false`, so without `isDuplicatePeerAutoPlay` the same
 * exchange gets auto-played twice over whenever both threads are simultaneously followed. These
 * tests pin the dedup decision in isolation, no Android context (no Robolectric).
 */
class DuplicatePeerAutoPlayTest {

	private fun peerMessage(from: String, to: String, at: Long = 1000L) =
		Message(fromMe = false, text = "hi", at = at, from = from, to = to, isPeer = true)

	private fun ordinaryMessage(at: Long = 1000L) = Message(fromMe = false, text = "hi", at = at)

	@Test
	fun firstCopyOfAPeerExchangeIsNotADuplicate() {
		val seen = mutableSetOf<String>()
		val a = peerMessage(from = "alice.sakura.coolapp.main", to = "alice.sakura.coollib.main")
		assertFalse(isDuplicatePeerAutoPlay(a, seen))
	}

	@Test
	fun secondMirroredCopyOfTheSameExchangeIsADuplicate() {
		val seen = mutableSetOf<String>()
		val fromCoolapp = peerMessage(from = "alice.sakura.coolapp.main", to = "alice.sakura.coollib.main")
		val fromCoollib = peerMessage(from = "alice.sakura.coolapp.main", to = "alice.sakura.coollib.main")
		assertFalse(isDuplicatePeerAutoPlay(fromCoolapp, seen))
		assertTrue("the same (from, to) pair claimed the slot already", isDuplicatePeerAutoPlay(fromCoollib, seen))
	}

	@Test
	fun aDifferentPeerPairInTheSamePassIsNotSuppressed() {
		val seen = mutableSetOf<String>()
		val coolappToCoollib = peerMessage(from = "alice.sakura.coolapp.main", to = "alice.sakura.coollib.main")
		val coolappToOther = peerMessage(from = "alice.sakura.coolapp.main", to = "alice.sakura.other.main")
		assertFalse(isDuplicatePeerAutoPlay(coolappToCoollib, seen))
		assertFalse("a genuinely different exchange must still auto-play", isDuplicatePeerAutoPlay(coolappToOther, seen))
	}

	@Test
	fun ordinaryNonPeerMessagesAreNeverSuppressed() {
		val seen = mutableSetOf<String>()
		val a = ordinaryMessage()
		val b = ordinaryMessage()
		assertFalse(isDuplicatePeerAutoPlay(a, seen))
		assertFalse("an ordinary message lands in exactly one thread, never a duplicate", isDuplicatePeerAutoPlay(b, seen))
	}

	@Test
	fun nullLastAgentIsNeverADuplicate() {
		val seen = mutableSetOf<String>()
		assertFalse(isDuplicatePeerAutoPlay(null, seen))
	}
}
