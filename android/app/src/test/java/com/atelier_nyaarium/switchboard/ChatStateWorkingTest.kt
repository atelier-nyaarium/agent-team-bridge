package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Which source answers "is this session working". Both exist and they disagree: the presence plane
 * keeps arriving, while a local peek only lands while that session's terminal is on screen.
 */
class ChatStateWorkingTest {
	private val team = "home.gw.app.dev"

	private fun state(working: Boolean? = null, needsLogin: Boolean? = null, peeked: Boolean? = null) =
		ChatState(
			teams = listOf(Team(team, "online", "channel", 0, working = working, needsLogin = needsLogin)),
			sessionWorking = peeked?.let { mapOf(team to it) } ?: emptyMap(),
			sessionNeedsLogin = peeked?.let { mapOf(team to it) } ?: emptyMap(),
		)

	@Test
	fun thePlaneOutranksAPeekThatMayBeHoursOld() {
		// A peek lands only while the terminal is open, so reading it first froze the thread's chip at
		// whatever it saw the last time that terminal was on screen.
		assertEquals(true, state(working = true, peeked = false).working(team))
		assertEquals(false, state(working = false, peeked = true).working(team))
		assertEquals(true, state(needsLogin = true, peeked = false).needsLogin(team))
	}

	@Test
	fun aPeekStillAnswersWhileThePlaneKnowsNothing() {
		// Null is unknown, not false: a daemon that just reconnected has derived nothing yet.
		assertEquals(true, state(peeked = true).working(team))
		assertEquals(true, state(peeked = true).needsLogin(team))
	}

	@Test
	fun aColdWakeReadsAsWorkingWithNeitherSource() {
		assertEquals(true, ChatState(wakingTeams = setOf(team)).working(team))
		assertEquals(false, ChatState().working(team))
		assertEquals(false, ChatState().needsLogin(team))
	}
}
