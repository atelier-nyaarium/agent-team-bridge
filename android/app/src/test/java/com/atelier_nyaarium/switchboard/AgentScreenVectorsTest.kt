package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drives the hand-authored AgentScreen twin through the same real captures the vitest suite reads
 * (tests/fixtures/agent-screen/vectors.json), so the twin cannot drift from the TS classifiers.
 *
 * Every frame came off a live tmux server at the daemon's geometry through `capture-pane -e -J -p`,
 * from the same Claude Code build on Linux and Windows - so a difference between two vectors is a
 * rendering difference, never version drift. Three separable causes made the Windows frames
 * unreadable: the composer glyph is U+003E rather than U+276F; the TOP rule arrives welded to the
 * composer row always; and the BOTTOM rule arrives welded to the footer after a resize, which
 * peekPane performs on every peek.
 *
 * This matters more on this side than the TS one: the console gates what it shows on these reads, and
 * the Kotlin tests only run AFTER merge, so a drift here ships before anything catches it.
 */
class AgentScreenVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("agent-screen/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["vectors"]!!.jsonArray

	@Test
	fun agentScreenVectors() {
		val all = vectors()
		// Vacuity guard: an empty or truncated corpus must fail rather than pass by iterating nothing.
		assertTrue("corpus should carry both platforms", all.size >= 6)

		var linux = 0
		var windows = 0
		for (element in all) {
			val v = element.jsonObject
			val name = v["name"]!!.jsonPrimitive.content
			val screen = v["screen"]!!.jsonPrimitive.content
			val expectReady = v["expectReady"]!!.jsonPrimitive.boolean
			val expectWorking = v["expectWorking"]!!.jsonPrimitive.boolean
			when (v["platform"]!!.jsonPrimitive.content) {
				"linux" -> linux++
				"windows" -> windows++
			}
			// Raw captures, so every frame carries the ESC bytes -e produced. A corpus that lost them in a
			// rewrite would still parse and would quietly stop exercising the ANSI strip.
			assertTrue("$name: frame should carry ANSI escapes", screen.contains("["))
			assertEquals("$name: isReady", expectReady, AgentScreen.isReady(screen))
			assertEquals("$name: isWorking", expectWorking, AgentScreen.isWorking(screen))
		}
		assertTrue("corpus should carry Linux frames", linux > 0)
		assertTrue("corpus should carry Windows frames", windows > 0)
	}
}
