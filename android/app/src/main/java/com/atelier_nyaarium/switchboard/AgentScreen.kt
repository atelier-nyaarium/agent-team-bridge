package com.atelier_nyaarium.switchboard

/**
 * Whether a captured tmux pane shows the agent idle/ready, actively working a turn, or logged out.
 * Twin of the markers in src/mcp/devcontainer/tmuxCore.ts (isAgentReady / isAgentWorking / isLoggedOut
 * / isAtPrompt).
 * isReady: the REPL composer prompt (U+276F) sits at column 0; the dev-channels / folder-trust /
 * resume-picker menus show an indented cursor, so the line-start anchor matches only the real
 * composer. isWorking: either the "esc to interrupt" hint or a U+25EF task-bullet ("◯ <name>", a
 * queued/in-progress plan or task item) sits in the bottom status line, bounded by searching
 * everything below the last U+2500 rule line rather than a fixed line count, since the footer's
 * height is dynamic (terminal width/wrapping).
 * isLoggedOut: the bottom toolbar (below the composer's lower
 * rule of U+2500 dashes) prints "Not
 * logged in" / "Run /login"; checked separately since a logged-out session still shows a composer,
 * and detectable at any peek including a mid-session token expiry.
 * isAtPrompt: a row that (once trimmed) is ENTIRELY U+2500 dashes - the composer's box border itself,
 * present whether idle or mid-turn, so it distinguishes "a real composer is rendered" from a raw
 * shell / boot screen / menu that has none, rather than working from idle.
 */
object AgentScreen {
	private val composerRe = Regex("^\\u276F", RegexOption.MULTILINE)
	private const val WORKING_HINT = "· esc"
	// A queued/in-progress task or plan item also renders in the footer while a turn is in flight,
	// e.g. "◯ idle-pushback" - same signal as the esc hint, checked in the same bounded region.
	private const val WORKING_CIRCLE_HINT = "◯"
	private const val TOOLBAR_RULE = "───"
	// A stricter test than TOOLBAR_RULE's .contains(): the whole trimmed row must be the rule
	// character, so a stray few dashes inside transcript/tool-output text can't false-positive.
	private val fullRuleRe = Regex("^\\u2500+$")

	// The peek runs capture-pane -e, so the screen carries SGR color escapes. Strip them before
	// matching: an escape at the start of a line defeats the composer anchor, and one splitting a
	// phrase defeats a substring check. Twin of stripAnsi in tmuxCore.ts.
	private val ansiRe = Regex("\\u001B\\[[0-9;?]*[A-Za-z]")

	private fun strip(screen: String): String = ansiRe.replace(screen, "")

	fun isReady(screen: String): Boolean = composerRe.containsMatchIn(strip(screen))

	fun isWorking(screen: String): Boolean {
		val lines = strip(screen).split("\n")
		// The footer's height is dynamic (terminal width/wrapping), so a fixed line count is wrong in
		// general - bound the search by the actual rule instead, same as isLoggedOut. Falls back to
		// the last two lines only when no rule is present at all (a malformed/partial capture): with
		// no boundary to anchor on, that stays the safer guess over treating the whole screen as fair
		// game, which risks matching a stray "esc" sitting in scrollback/transcript text above.
		val lastRule = lines.indexOfLast { it.contains(TOOLBAR_RULE) }
		val footer = if (lastRule >= 0) lines.drop(lastRule + 1) else lines.takeLast(2)
		return footer.any { it.contains(WORKING_HINT) || it.contains(WORKING_CIRCLE_HINT) }
	}

	fun isLoggedOut(screen: String): Boolean {
		val lines = strip(screen).split("\n")
		val lastRule = lines.indexOfLast { it.contains(TOOLBAR_RULE) }
		val footer = lines.drop(lastRule + 1).joinToString("\n")
		return footer.contains("Not logged in") || footer.contains("Run /login")
	}

	fun isAtPrompt(screen: String): Boolean =
		strip(screen).split("\n").any { fullRuleRe.matches(it.trim()) }
}
