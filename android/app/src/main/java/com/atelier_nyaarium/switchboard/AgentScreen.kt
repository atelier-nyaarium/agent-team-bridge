package com.atelier_nyaarium.switchboard

/**
 * Whether a captured tmux pane shows the agent idle/ready, actively working a turn, or logged out.
 * Twin of the markers in src/shared/agent-screen.ts (isAgentReady / isAgentWorking / isLoggedOut),
 * which is where the constants to compare against live.
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
 */
object AgentScreen {
	private val composerRe = Regex("^\\u276F", RegexOption.MULTILINE)
	private const val WORKING_HINT = "· esc"
	// A queued/in-progress task or plan item also renders in the footer while a turn is in flight,
	// e.g. "◯ idle-pushback" - same signal as the esc hint, checked in the same bounded region.
	private const val WORKING_CIRCLE_HINT = "◯"
	private const val TOOLBAR_RULE = "───"

	// A rule row for the usage-limit check, as any run of box-drawing characters rather than the
	// specific glyph: that dialog's divider is heavier than the composer's U+2500 border, and a
	// restyle must not silently disable detection. titledBorderRe is the same run leading a row that
	// also carries text, which the composer's top border does once a session has a name.
	private val anyRuleRe = Regex("^[\\u2500-\\u257F]+$")
	private val titledBorderRe = Regex("^[\\u2500-\\u257F]{3,}")
	// An INDENTED prompt followed by a numbered option, i.e. a selectable dialog holds the pane.
	// Column 0 would be the composer, so the leading whitespace is load-bearing.
	private val menuCursorRe = Regex("^\\s+\\u276F\\s*\\d+\\.", RegexOption.MULTILINE)
	// The usage-limit dialog's own cancel choice. It collapses to a bare "Stop" on usage-based
	// billing, which is too generic to match, so that case is not detected.
	private const val LIMIT_MENU_HINT = "wait for limit to reset"
	private const val MIDDLE_DOT = '·'
	// Deliberately names no model, plan, seat kind, or billing period: those churn, and an enumeration
	// fails silently the first time one is renamed. Each branch is a literal prefix of one of the CLI's
	// own headline builders, so the variable part stays payload to display rather than something to
	// match. The apostrophe slot is \W so a straight or typographic quote both match.
	private val limitHeadlineRe = Regex(
		listOf(
			"You\\Wve (?:hit|reached) your\\b",
			"You\\Wre out of (?:extra )?usage\\b",
			"is out of usage\\b",
			"requires usage credits\\b",
			"seat type doesn\\Wt include\\b",
			"usage allocation has been disabled\\b",
			"usage limit is set to \\\$0",
			"This service is disabled for your org\\b",
		).joinToString("|"),
	)
	// Rows to read above the divider. Panes are pinned to 58 columns, where a short reset-time
	// headline fits on one row and a long admin/org suffix wraps onto a second or third.
	private const val LIMIT_WINDOW_ROWS = 3

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

	/** The headline of a usage-limit dialog plus the text after its middle dot, e.g. "resets 5pm". */
	data class LimitNotice(val headline: String, val detail: String?)

	/**
	 * The usage-limit dialog, i.e. the agent has stopped and cannot progress until the choice is
	 * answered. Twin of limitNotice in agent-screen.ts, held equivalent by
	 * tests/fixtures/limit-notice/vectors.json.
	 *
	 * Detected by POSITION rather than by scanning the screen, because the headline renders in the
	 * transcript and lingers in scrollback after the dialog closes; a whole-screen match would latch
	 * permanently and would also trip on a session that merely quotes the wording while discussing it.
	 * Both below-divider signals are required before the headline pattern runs, since neither is
	 * sufficient alone: the dialog title is reused by unrelated dialogs, and a numbered menu is just as
	 * present on a permission prompt.
	 */
	fun limitNotice(screen: String): LimitNotice? {
		val lines = strip(screen).split("\n")
		// Lowest divider whose region below carries both signals. Not simply the last rule: a dialog
		// that draws its own bottom border would put that border last, leaving the menu above unseen.
		var divider = -1
		for (i in lines.indices.reversed()) {
			if (!anyRuleRe.matches(lines[i].trim())) continue
			val below = lines.drop(i + 1).joinToString("\n")
			if (menuCursorRe.containsMatchIn(below) && below.contains(LIMIT_MENU_HINT)) {
				divider = i
				break
			}
		}
		if (divider < 0) return null
		// Walk up from the divider, stopping at the next border so a composer-present screen exposes
		// only the composer row. Blank rows do not spend budget; a wrapped headline needs the full one.
		val above = mutableListOf<String>()
		var i = divider - 1
		while (i >= 0 && above.size < LIMIT_WINDOW_ROWS) {
			val line = lines[i]
			if (titledBorderRe.containsMatchIn(line.trim())) break
			if (line.trim().isNotEmpty()) above.add(line)
			i--
		}
		// Grow the join upward a row at a time and take the first size that matches, so a single-row
		// headline stays clean while a wrapped one is rejoined far enough to recover a suffix that
		// landed on a continuation row. Rows join on a space because the renderer wraps on word
		// boundaries and drops the break itself.
		for (take in 1..above.size) {
			val headline = above.take(take).reversed().joinToString(" ") { it.trim() }
			if (!limitHeadlineRe.containsMatchIn(headline)) continue
			val dot = headline.indexOf(MIDDLE_DOT)
			val detail = if (dot < 0) null else headline.substring(dot + 1).trim().ifEmpty { null }
			return LimitNotice(headline, detail)
		}
		return null
	}
}
