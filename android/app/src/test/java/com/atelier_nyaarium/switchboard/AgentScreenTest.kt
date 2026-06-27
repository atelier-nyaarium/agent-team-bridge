package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/** Mirrors the tmuxCore isAgentReady/isAgentWorking markers so the chip and the daemon agree. */
class AgentScreenTest {
	@Test
	fun ready() {
		assertEquals(false, AgentScreen.isReady(""))
		assertEquals(false, AgentScreen.isReady("Claude Code v2.1.0\nChoose the text style"))
		assertEquals(true, AgentScreen.isReady("Claude Code v2.1.0\n> "))
		assertEquals(true, AgentScreen.isReady("...restored...\n? for shortcuts"))
	}

	@Test
	fun working() {
		assertEquals(true, AgentScreen.isWorking("✻ Thinking… (esc to interrupt)"))
		assertEquals(false, AgentScreen.isWorking(""))
		assertEquals(false, AgentScreen.isWorking("Claude Code v2.1.0\n> "))
	}
}
