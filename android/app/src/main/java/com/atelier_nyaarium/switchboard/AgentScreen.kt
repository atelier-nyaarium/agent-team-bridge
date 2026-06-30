package com.atelier_nyaarium.switchboard

/**
 * Whether a captured tmux pane shows the agent idle/ready, actively working a turn, or logged out.
 * Twin of the markers in src/mcp/devcontainer/tmuxCore.ts (isAgentReady / isAgentWorking / isLoggedOut).
 * isReady: the REPL composer prompt (U+276F) sits at column 0; the dev-channels / folder-trust /
 * resume-picker menus show an indented cursor, so the line-start anchor matches only the real
 * composer. isWorking: the last line carrying the settled spinner (U+273B) shows the ellipsis
 * (U+2026) or "Waiting for"; a settled "✻ Brewed for Ns" line (neither) is the done summary. A pane
 * with NO spinner line is treated as working: the spinner is momentarily between animation frames or
 * pushed off by tool output, so a missing spinner means mid-turn, not idle.
 * isLoggedOut: the bottom toolbar (below the composer's lower
 * rule of U+2500 dashes) prints "Not
 * logged in" / "Run /login"; checked separately since a logged-out session still shows a composer,
 * and detectable at any peek including a mid-session token expiry.
 */
object AgentScreen {
	private val composerRe = Regex("^\\u276F", RegexOption.MULTILINE)
	private const val TOOLBAR_RULE = "───"

	// The peek runs capture-pane -e, so the screen carries SGR color escapes. Strip them before
	// matching: an escape at the start of a line defeats the composer anchor, and one splitting a
	// phrase defeats a substring check. Twin of stripAnsi in tmuxCore.ts.
	private val ansiRe = Regex("\\u001B\\[[0-9;?]*[A-Za-z]")

	private fun strip(screen: String): String = ansiRe.replace(screen, "")

	fun isReady(screen: String): Boolean = composerRe.containsMatchIn(strip(screen))

	fun isWorking(screen: String): Boolean {
		// No spinner line means it is between frames or scrolled off by tool output, so it is mid-turn.
		val status = strip(screen).split("\n").lastOrNull { it.contains('✻') } ?: return true
		return status.contains('…') || status.contains("...") || status.contains("Waiting for")
	}

	fun isLoggedOut(screen: String): Boolean {
		val lines = strip(screen).split("\n")
		val lastRule = lines.indexOfLast { it.contains(TOOLBAR_RULE) }
		val footer = lines.drop(lastRule + 1).joinToString("\n")
		return footer.contains("Not logged in") || footer.contains("Run /login")
	}
}
