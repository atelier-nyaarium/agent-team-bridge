package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The gateway mirrors one agent-to-agent exchange into BOTH local participants' own threads as
 * separate `"peer"` mailbox entries (see AGENTS.md's Agent-to-agent mirroring). Both copies reach
 * the poll loop's burst map as `fromMe = false`, so without `isDuplicatePeerAutoPlay` the same
 * exchange gets auto-played twice over whenever both threads are simultaneously followed. These
 * tests pin the dedup decision in isolation, no Android context (no Robolectric).
 */
class DuplicatePeerAutoPlayTest {

	private fun peerMessage(from: String, to: String, at: Long = 1000L) =
		Message(fromMe = false, text = "hi", at = at, from = from, to = to, isPeer = true)

	private fun ordinaryMessage(at: Long = 1000L) = Message(fromMe = false, text = "hi", at = at)

	@Test
	fun mirroredCopiesAreDuplicatesEvenThoughTheirTimestampsDiffer() {
		val seen = mutableSetOf<String>()
		val from = "alice.sakura.coolapp.main"
		val to = "alice.sakura.coollib.main"

		// The two copies are re-stamped independently as they land, so `at` is exactly the field that
		// cannot identify an exchange. Body and files are what both copies share.
		assertFalse(isDuplicatePeerAutoPlay(peerMessage(from, to, at = 1000L), seen))
		assertTrue(isDuplicatePeerAutoPlay(peerMessage(from, to, at = 1007L), seen))
	}

	@Test
	fun twoDifferentMessagesBetweenOnePairBothPlay() {
		val seen = mutableSetOf<String>()
		val from = "alice.sakura.coolapp.main"
		val to = "alice.sakura.coollib.main"
		val first = Message(fromMe = false, text = "first", at = 1000L, from = from, to = to, isPeer = true)
		val second = Message(fromMe = false, text = "second", at = 1001L, from = from, to = to, isPeer = true)

		// Keyed on the pair alone, the second would be suppressed - which was correct only while a pass
		// could speak one message, and silently drops messages once every one of them is queued.
		assertFalse(isDuplicatePeerAutoPlay(first, seen))
		assertFalse(isDuplicatePeerAutoPlay(second, seen))
	}

	@Test
	fun oneExchangeWithFilesIsStillOneExchange() {
		val seen = mutableSetOf<String>()
		val from = "alice.sakura.coolapp.main"
		val to = "alice.sakura.coollib.main"
		fun copy(at: Long) = Message(
			fromMe = false,
			text = "here",
			at = at,
			from = from,
			to = to,
			isPeer = true,
			files = listOf(MessageFile(name = "shot.png", mime = "image/png", size = 12L)),
		)

		assertFalse(isDuplicatePeerAutoPlay(copy(1000L), seen))
		assertTrue(isDuplicatePeerAutoPlay(copy(1009L), seen))
	}

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
