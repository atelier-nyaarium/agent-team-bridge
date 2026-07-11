package com.atelier_nyaarium.switchboard

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The transcript payload `ThreadRenderer` evals into the bundled web app, exercised through the
 * extracted pure serializer with a fake decorator standing in for the plugin registry. Behavior
 * under test: a decorated file gains exactly a `decoration: {title, kind}` object, an undecorated
 * one stays byte-identical to the pre-seam shape, and titles ride JSONObject escaping (no
 * eval-injection through a hostile title). Real org.json on the test classpath (see
 * build.gradle.kts), no Android context.
 */
class MessagesToJsonTest {
	private val displayFrom: (Message) -> String = { if (it.fromMe) "you" else "agent" }

	private fun msg(files: List<MessageFile>) = Message(fromMe = false, text = "here", at = 1000L, id = 7, files = files)

	@Test
	fun decoratedFileCarriesTitleAndKindUndecoratedStaysPlain() {
		val json = messagesToJson(
			listOf(msg(listOf(MessageFile("card.html", "text/html", "https://x/attachments/1-1/card.html"), MessageFile("notes.txt", "text/plain", null)))),
			displayFrom,
			playEnabled = false,
		) { f -> if (f.name == "card.html") ChipDecoration("Editor Form", "designer") else null }
		val files = JSONArray(json).getJSONObject(0).getJSONArray("files")
		val deco = files.getJSONObject(0).getJSONObject("decoration")
		assertEquals("Editor Form", deco.getString("title"))
		assertEquals("designer", deco.getString("kind"))
		assertFalse(files.getJSONObject(1).has("decoration"))
	}

	@Test
	fun aNullDecoratorLeavesThePayloadIdenticalToTheUndecoratedShape() {
		val messages = listOf(msg(listOf(MessageFile("a.png", "image/png", "https://x/attachments/1-1/a.png"))))
		val without = messagesToJson(messages, displayFrom, playEnabled = false) { null }
		val file = JSONArray(without).getJSONObject(0).getJSONArray("files").getJSONObject(0)
		assertEquals("a.png", file.getString("name"))
		assertEquals("image/png", file.getString("mime"))
		assertEquals("https://x/attachments/1-1/a.png", file.getString("src"))
		assertFalse(file.has("decoration"))
	}

	@Test
	fun aHostileTitleSurvivesTheRoundTripAsInertText() {
		// The payload is eval-wrapped on the Kotlin side; a title full of quotes, backslashes, and
		// script tags must come back out as the same literal string, proving it rode JSON escaping
		// rather than string concatenation.
		val hostile = """"><script>alert(1)</script>\"; window.x='"""
		val json = messagesToJson(
			listOf(msg(listOf(MessageFile("card.html", "text/html", "https://x/attachments/1-1/card.html")))),
			displayFrom,
			playEnabled = false,
		) { ChipDecoration(hostile, "designer") }
		val title = JSONArray(json).getJSONObject(0).getJSONArray("files").getJSONObject(0)
			.getJSONObject("decoration").getString("title")
		assertEquals(hostile, title)
	}

	@Test
	fun messagesWithoutFilesCarryNoFilesArray() {
		val json = messagesToJson(
			listOf(Message(fromMe = true, text = "hi", at = 1000L, id = 3)),
			displayFrom,
			playEnabled = false,
		) { ChipDecoration("never", "consulted") }
		val row = JSONArray(json).getJSONObject(0)
		assertFalse(row.has("files"))
		assertEquals("you", row.getString("from"))
	}

	@Test
	fun agentRowGainsCanPlayOnlyWhenEnabled() {
		val messages = listOf(msg(emptyList()))
		val on = JSONArray(messagesToJson(messages, displayFrom, playEnabled = true) { null }).getJSONObject(0)
		val off = JSONArray(messagesToJson(messages, displayFrom, playEnabled = false) { null }).getJSONObject(0)
		assertTrue(on.getBoolean("canPlay"))
		assertFalse(off.has("canPlay"))
	}

	@Test
	fun selfRowNeverGainsCanPlayEvenWhenPlayIsEnabled() {
		val self = listOf(Message(fromMe = true, text = "hi", at = 1000L, id = 3))
		val row = JSONArray(messagesToJson(self, displayFrom, playEnabled = true) { null }).getJSONObject(0)
		assertFalse(row.has("canPlay"))
	}
}
