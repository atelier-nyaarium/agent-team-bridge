package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `peerFramed` prefixes a peer-mirror row's notification/TTS text with "from -> to" so it never
 * reads as if addressed to this console. Pure function test, no Android context (no Robolectric).
 */
class PeerFramedTest {
	private fun stateWith(labels: Map<String, String>) = ChatState(labels = labels)

	@Test
	fun ordinaryRowPassesTextThroughUnchanged() {
		val m = Message(fromMe = false, text = "hi", at = 1000L, from = "alice.sakura.coollib.main")
		assertEquals("hi", peerFramed(stateWith(emptyMap()), m, "hi"))
	}

	@Test
	fun peerRowPrefixesWithFromArrowTo() {
		val m = Message(
			fromMe = false,
			text = "hi",
			at = 1000L,
			from = "alice.sakura.coolapp.main",
			to = "alice.sakura.coollib.main",
			isPeer = true,
		)
		val state = stateWith(mapOf("alice.sakura.coolapp.main" to "CoolApp", "alice.sakura.coollib.main" to "CoolLib"))
		assertEquals("CoolApp → CoolLib: hi", peerFramed(state, m, "hi"))
	}

	@Test
	fun peerRowWithNoResolvedToDropsTheArrow() {
		val m = Message(fromMe = false, text = "hi", at = 1000L, from = "alice.sakura.coolapp.main", to = null, isPeer = true)
		val state = stateWith(mapOf("alice.sakura.coolapp.main" to "CoolApp"))
		assertEquals("CoolApp: hi", peerFramed(state, m, "hi"))
	}

	@Test
	fun peerRowWithNoFromFallsBackToAQuestionMark() {
		val m = Message(fromMe = false, text = "hi", at = 1000L, from = null, to = "alice.sakura.coollib.main", isPeer = true)
		val state = stateWith(mapOf("alice.sakura.coollib.main" to "CoolLib"))
		assertEquals("? → CoolLib: hi", peerFramed(state, m, "hi"))
	}
}
