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
		// The body carries no attribution: the sentinel announces the speaker as its own playback, so
		// prefixing here as well would say it twice.
		assertEquals("hello there", ttsTextFramed(state, m, SttsPlayer.Tier.FULL))
	}

	@Test
	fun anAttributedPeerRowNamesBothParties() {
		val m = Message(
			fromMe = false,
			text = "hello there",
			at = 1000L,
			from = "alice.sakura.coolapp.main",
			to = "alice.sakura.coollib.main",
			isPeer = true,
		)
		val state = stateWith(mapOf("alice.sakura.coolapp.main" to "CoolApp", "alice.sakura.coollib.main" to "CoolLib"))

		// A message played by hand gets no sentinel - a boundary marker delimits a run, and one message
		// is not a run - so without this a peer row plays back as if this console had been addressed.
		assertEquals("CoolApp to CoolLib: hello there", ttsTextFramed(state, m, SttsPlayer.Tier.FULL, attributed = true))
	}

	@Test
	fun anAttributedOrdinaryRowIsUnchanged() {
		val m = Message(fromMe = false, text = "hello there", at = 1000L, from = "alice.sakura.coollib.main")

		// Only a peer row has an ambiguous speaker. An ordinary row is from the thread you are reading.
		assertEquals("hello there", ttsTextFramed(stateWith(emptyMap()), m, SttsPlayer.Tier.FULL, attributed = true))
	}

	@Test
	fun peerRowWithNoResolvedToDropsTheToClause() {
		val m = Message(fromMe = false, text = "hello there", at = 1000L, from = "alice.sakura.coolapp.main", to = null, isPeer = true)
		val state = stateWith(mapOf("alice.sakura.coolapp.main" to "CoolApp"))
		assertEquals("hello there", ttsTextFramed(state, m, SttsPlayer.Tier.FULL))
	}

	@Test
	fun peerRowWithNoFromFallsBackToSomeone() {
		val m = Message(fromMe = false, text = "hello there", at = 1000L, from = null, to = "alice.sakura.coollib.main", isPeer = true)
		val state = stateWith(mapOf("alice.sakura.coollib.main" to "CoolLib"))
		assertEquals("hello there", ttsTextFramed(state, m, SttsPlayer.Tier.FULL))
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
		assertEquals("the summary", ttsTextFramed(state, m, SttsPlayer.Tier.SUMMARY))
		assertEquals("the title", ttsTextFramed(state, m, SttsPlayer.Tier.TITLE))
	}

	@Test
	fun fullTierSpeaksTheSpokenCopyOverTheBody() {
		val m = Message(
			fromMe = false,
			text = "# Report\n\n```kotlin\nval x = 1\n```\n\nYAY!",
			at = 1000L,
			title = "the title",
			summary = "the summary",
			fullSpoken = "The report, spoken. Yay!",
		)
		assertEquals("The report, spoken. Yay!", ttsTextFramed(stateWith(emptyMap()), m, SttsPlayer.Tier.FULL))
	}

	@Test
	fun fullTierFallsToSummaryThenTitleWhenNoSpokenCopy() {
		val withSummary = Message(fromMe = false, text = "body", at = 1000L, title = "the title", summary = "the summary")
		assertEquals("the summary", SttsPlayer.ttsText(withSummary, SttsPlayer.Tier.FULL))
		val titleOnly = Message(fromMe = false, text = "body", at = 1000L, title = "the title")
		assertEquals("the title", SttsPlayer.ttsText(titleOnly, SttsPlayer.Tier.FULL))
	}

	@Test
	fun tierlessRowSpeaksItsBodyWithUnspeakableStructuresStripped() {
		// A peer-mirrored ask carries no tiers and can be a full markdown brief: a fence is
		// replaced by its spoken mention, a link speaks its label, prose is spoken as written.
		val m = Message(
			fromMe = false,
			text = "Please review [the doc](https://example.com/doc).\n\n```js\nconsole.log(1)\n```\n\nThanks!",
			at = 1000L,
			from = "alice.sakura.coolapp.main",
			to = "alice.sakura.coollib.main",
			isPeer = true,
		)
		val state = stateWith(mapOf("alice.sakura.coolapp.main" to "CoolApp", "alice.sakura.coollib.main" to "CoolLib"))
		assertEquals(
			"Please review the doc.\n\n Code block omitted. \n\nThanks!",
			ttsTextFramed(state, m, SttsPlayer.Tier.FULL),
		)
	}

	@Test
	fun tierNormalizationTreatsBlankAsAbsent() {
		assertEquals(null, "".tierOrNull())
		assertEquals(null, "   ".tierOrNull())
		assertEquals(null, (null as String?).tierOrNull())
		assertEquals("kept", "kept".tierOrNull())
	}
}
