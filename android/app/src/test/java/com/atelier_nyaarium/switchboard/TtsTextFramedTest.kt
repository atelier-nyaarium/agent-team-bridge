package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `ttsTextFramed` prefixes a peer-mirror row's spoken text with "from to to" (the word, not an
 * arrow glyph - TTS engines render symbols unpredictably) so it never plays back as if addressed
 * to this console. Pure function test, no Android context (no Robolectric).
 */
class TtsTextFramedTest {
	private fun stateWith(labels: Map<String, String>) = ChatState(labels = labels)

	@Test
	fun ordinaryRowSpeaksThePlainTierText() {
		val m = Message(fromMe = false, text = "hello there", at = 1000L, from = "alice.sakura.coollib.main")
		assertEquals("hello there", ttsTextFramed(stateWith(emptyMap()), m, SttsPlayer.Tier.FULL))
	}

	@Test
	fun peerRowPrefixesWithFromToTo() {
		val m = Message(
			fromMe = false,
			text = "hello there",
			at = 1000L,
			from = "alice.sakura.coolapp.main",
			to = "alice.sakura.coollib.main",
			isPeer = true,
		)
		val state = stateWith(mapOf("alice.sakura.coolapp.main" to "CoolApp", "alice.sakura.coollib.main" to "CoolLib"))
		assertEquals("CoolApp to CoolLib: hello there", ttsTextFramed(state, m, SttsPlayer.Tier.FULL))
	}

	@Test
	fun peerRowWithNoResolvedToDropsTheToClause() {
		val m = Message(fromMe = false, text = "hello there", at = 1000L, from = "alice.sakura.coolapp.main", to = null, isPeer = true)
		val state = stateWith(mapOf("alice.sakura.coolapp.main" to "CoolApp"))
		assertEquals("CoolApp: hello there", ttsTextFramed(state, m, SttsPlayer.Tier.FULL))
	}

	@Test
	fun peerRowWithNoFromFallsBackToSomeone() {
		val m = Message(fromMe = false, text = "hello there", at = 1000L, from = null, to = "alice.sakura.coollib.main", isPeer = true)
		val state = stateWith(mapOf("alice.sakura.coollib.main" to "CoolLib"))
		assertEquals("someone to CoolLib: hello there", ttsTextFramed(state, m, SttsPlayer.Tier.FULL))
	}

	@Test
	fun peerFramingAppliesToEveryTierNotJustFull() {
		val m = Message(
			fromMe = false,
			text = "body text",
			at = 1000L,
			title = "the title",
			summary = "the summary",
			from = "alice.sakura.coolapp.main",
			to = "alice.sakura.coollib.main",
			isPeer = true,
		)
		val state = stateWith(mapOf("alice.sakura.coolapp.main" to "CoolApp", "alice.sakura.coollib.main" to "CoolLib"))
		assertEquals("CoolApp to CoolLib: the summary", ttsTextFramed(state, m, SttsPlayer.Tier.SUMMARY))
		assertEquals("CoolApp to CoolLib: the title", ttsTextFramed(state, m, SttsPlayer.Tier.TITLE))
	}
}
