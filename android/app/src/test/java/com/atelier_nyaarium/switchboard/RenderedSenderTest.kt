package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The sender label `ThreadRenderer` shows for a row: this is the exact logic that previously
 * existed only inline inside `toJson()`, duplicated (and out of sync with) a second copy inside
 * `fingerprint()` - a peer-mirror row's "from -> to" framing was computed for cache-invalidation
 * purposes but never actually reached the rendered JSON. Extracted as a pure function so the
 * rendered output itself has direct test coverage, not just the fingerprint that was supposed to
 * track it.
 *
 * Pure function tests, no Android context (no Robolectric).
 */
class RenderedSenderTest {
	private val identity: (String) -> String = { it }

	@Test
	fun ownRowShowsSelfName() {
		val m = Message(fromMe = true, text = "hi", at = 1000L)
		assertEquals("you", renderedSender(m, identity, "you"))
	}

	@Test
	fun ordinaryInboundRowShowsTheResolvedSender() {
		val m = Message(fromMe = false, text = "hi", at = 1000L, from = "alice.sakura.coollib.main")
		assertEquals("CoolLib", renderedSender(m, { "CoolLib" }, "you"))
	}

	@Test
	fun peerRowShowsFromArrowTo() {
		val m = Message(
			fromMe = false,
			text = "hi",
			at = 1000L,
			from = "alice.sakura.coolapp.main",
			to = "alice.sakura.coollib.main",
			isPeer = true,
		)
		val resolve: (String) -> String = { addr -> if (addr.contains("coolapp")) "CoolApp" else "CoolLib" }
		assertEquals("CoolApp → CoolLib", renderedSender(m, resolve, "you"))
	}

	@Test
	fun peerRowWithNoResolvedToFallsBackToBareFrom() {
		val m = Message(fromMe = false, text = "hi", at = 1000L, from = "alice.sakura.coolapp.main", to = null, isPeer = true)
		assertEquals("CoolApp", renderedSender(m, { "CoolApp" }, "you"))
	}

	@Test
	fun aResolverThatReturnsTheRawAddressStillDegradesGracefully() {
		// No crash, no blank string, when the caller's resolver is just the identity function
		// (ThreadRenderer's own fallback when resolveFrom is unset).
		val m = Message(
			fromMe = false,
			text = "hi",
			at = 1000L,
			from = "alice.sakura.coolapp.main",
			to = "alice.sakura.coollib.main",
			isPeer = true,
		)
		assertEquals("alice.sakura.coolapp.main → alice.sakura.coollib.main", renderedSender(m, identity, "you"))
	}
}
