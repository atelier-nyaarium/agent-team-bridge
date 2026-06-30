package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/** Mirrors the tmuxCore isAgentReady/isAgentWorking markers so the chip and the daemon agree. */
class AgentScreenTest {
	@Test
	fun ready() {
		assertEquals(false, AgentScreen.isReady(""))
		assertEquals(false, AgentScreen.isReady("Loading development channels..."))
		// An indented menu cursor is the dev-channels prompt, not the composer.
		assertEquals(false, AgentScreen.isReady("  ❯ 1. I am using this for local development"))
		assertEquals(true, AgentScreen.isReady("Claude Code v2.1.0\n❯ "))
		// A resumed session whose header scrolled off still shows the composer.
		assertEquals(true, AgentScreen.isReady("...restored conversation...\n❯ "))
	}

	@Test
	fun working() {
		// An active "✻ verb…" / "Waiting for" line is working; a settled "✻ Brewed for Ns" line is done.
		assertEquals(true, AgentScreen.isWorking("✻ Prestidigitating…"))
		assertEquals(true, AgentScreen.isWorking("✻ Waiting for 1 dynamic workflow to finish"))
		assertEquals(false, AgentScreen.isWorking("✻ Brewed for 7s"))
		assertEquals(false, AgentScreen.isWorking("✻ Brewed for 19s · 1 monitor still running"))
		// No spinner line means mid-turn (between frames or scrolled off), so working.
		assertEquals(true, AgentScreen.isWorking(""))
		assertEquals(true, AgentScreen.isWorking("Claude Code v2.1.0\n❯ "))
	}

	@Test
	fun loggedOut() {
		val rule = "─".repeat(40)
		// Auth footer in the toolbar below the last rule.
		assertEquals(
			true,
			AgentScreen.isLoggedOut("❯ \n$rule\n  ⏵⏵ bypass permissions on · ← for agents    Not logged in · Run /login"),
		)
		// Logged in: no auth footer.
		assertEquals(false, AgentScreen.isLoggedOut("❯ \n$rule\n  ⏵⏵ bypass permissions on · ← for agents"))
		// The phrase above the last rule (transcript or composer) does not count.
		assertEquals(
			false,
			AgentScreen.isLoggedOut("● The DB said: Not logged in. Run /login.\n$rule\n❯ Run /login\n$rule\n  ⏵⏵ for agents"),
		)
	}

	@Test
	fun stripsAnsi() {
		// A real capture-pane -e screen wraps cells in SGR escapes; build ESC without a source escape.
		val esc = 27.toChar().toString()
		assertEquals(true, AgentScreen.isReady("${esc}[39m❯ ${esc}[2mTry${esc}[0m"))
		assertEquals(true, AgentScreen.isWorking("${esc}[38;5;1m✻${esc}[0m Prestidigitating${esc}[2m…${esc}[0m"))
		val ruleAnsi = "${esc}[2m" + "─".repeat(40) + "${esc}[0m"
		assertEquals(
			true,
			AgentScreen.isLoggedOut("❯ \n$ruleAnsi\n  for agents  ${esc}[33mNot logged in${esc}[0m · Run /login"),
		)
	}
}
