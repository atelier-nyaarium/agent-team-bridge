package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The sender label `ThreadRenderer` shows for a row, as its own pure function rather than logic
 * inlined in `toJson()` or folded into `fingerprint()`'s cache-invalidation computation: the two
 * must not be conflated, since fingerprint's "from -> to" framing serves recomposition and is not
 * guaranteed to match what actually renders.
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
