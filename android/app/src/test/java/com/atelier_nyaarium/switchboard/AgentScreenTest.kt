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
		// The "esc to interrupt" hint in the bottom status line means working.
		assertEquals(true, AgentScreen.isWorking("✻ Prestidigitating… (12s · esc to interrupt)"))
		// It can land on either of the last two lines depending on how the pane wraps.
		assertEquals(true, AgentScreen.isWorking("✻ Prestidigitating…\n(12s · esc to interrupt)"))
		assertEquals(true, AgentScreen.isWorking("(12s · esc to interrupt)\n✻ Prestidigitating…"))
		// A settled "✻ Brewed for Ns" line with no hint, or no hint at all, is not working.
		assertEquals(false, AgentScreen.isWorking("✻ Brewed for 7s"))
		assertEquals(false, AgentScreen.isWorking(""))
		assertEquals(false, AgentScreen.isWorking("Claude Code v2.1.0\n❯ "))
		// A line more than two back does not count - ONLY absent a rule to bound the search by; see
		// findsTheWorkingHintAnyDistanceBelowTheRule below for the same distance with a rule present.
		assertEquals(false, AgentScreen.isWorking("(12s · esc to interrupt)\n✻ Prestidigitating…\n❯ "))
	}

	@Test
	fun workingHintBoundedByTheRuleRatherThanAFixedLineCount() {
		val rule = "─".repeat(40)
		// The footer's height is dynamic (terminal width/wrapping): the hint sits 3 lines above the
		// very bottom here, past the old fixed "last 2 lines" heuristic, but it IS below the rule, so
		// the properly-bounded footer search still finds it.
		assertEquals(
			true,
			AgentScreen.isWorking(
				"❯ \n$rule\n✻ Prestidigitating… (12s · esc to interrupt)\n  ⏵⏵ bypass permissions on\n  ← for agents",
			),
		)
		// A hint ABOVE the rule is transcript/history, not the live footer - never counts, even when
		// it would fall within some arbitrary distance of the bottom.
		assertEquals(
			false,
			AgentScreen.isWorking("✻ Prestidigitating… (12s · esc to interrupt)\n$rule\n❯ "),
		)
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
		assertEquals(
			true,
			AgentScreen.isWorking("${esc}[38;5;1m✻${esc}[0m Prestidigitating${esc}[2m… (12s ${esc}[2m·${esc}[0m esc to interrupt)"),
		)
		val ruleAnsi = "${esc}[2m" + "─".repeat(40) + "${esc}[0m"
		assertEquals(
			true,
			AgentScreen.isLoggedOut("❯ \n$ruleAnsi\n  for agents  ${esc}[33mNot logged in${esc}[0m · Run /login"),
		)
	}
}
