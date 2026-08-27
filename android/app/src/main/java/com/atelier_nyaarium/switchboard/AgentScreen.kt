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
	// The composer glyph. Linux Claude draws U+276F; the WINDOWS build draws U+003E. Same binary version
	// on the same machine renders both, so this is the build's own difference, not version drift.
	private const val COMPOSER_GLYPH = "[\\u276F>]"
	private val composerRe = Regex("^$COMPOSER_GLYPH")
	private const val WORKING_HINT = "· esc"
	// A queued/in-progress task or plan item also renders in the footer while a turn is in flight,
	// e.g. "◯ idle-pushback" - same signal as the esc hint, checked in the same bounded region.
	private const val WORKING_CIRCLE_HINT = "◯"
	// Whitespace spelled OUT, never \s. JS's \s matches U+00A0 and the JVM's default does not, and the
	// Windows build emits U+00A0 right after the glyph - so a shorthand here would make this twin
	// disagree with agent-screen.ts on a real frame, silently.
	private const val SPACE = "[ \\t\\u00A0]"

	// A rule RUN, not a rule LINE. capture-pane -J welds a wrapped row onto its neighbour, and on
	// Windows-hosted panes the composer's rules arrive welded to the rows beside them: the top rule to
	// the composer row always, the bottom rule to the footer after a resize (and peekPane resizes on
	// every peek). Two notions kept distinct: TOOLBAR is the composer's own boundary, U+2500 only;
	// ANY covers any divider including the limit dialog's U+2594 block element.
	private val toolbarRunRe = Regex("\\u2500{3,}")
	private val anyRuleRunRe = Regex("[\\u2500-\\u259F]{3,}")
	// The historical divider predicate: the whole trimmed line is rule characters, one or more. Kept
	// EXACTLY as it was and tried first, so limitNotice's Linux behaviour is byte-identical.
	private val anyRuleLineRe = Regex("^[\\u2500-\\u259F]+$")
	private val titledBorderRe = Regex("^[\\u2500-\\u259F]{3,}")
	// An INDENTED prompt followed by a numbered option, i.e. a selectable dialog holds the pane.
	// Column 0 would be the composer, so the leading whitespace is load-bearing.
	private val menuCursorRe = Regex("^$SPACE+$COMPOSER_GLYPH$SPACE*\\d+\\.", RegexOption.MULTILINE)
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
	// Rows to read above the divider. Panes are pinned narrow, where a short reset-time
	// headline fits on one row and a long admin/org suffix wraps onto a second or third.
	private const val LIMIT_WINDOW_ROWS = 3

	// The peek runs capture-pane -e, so the screen carries SGR color escapes. Strip them before
	// matching: an escape at the start of a line defeats the composer anchor, and one splitting a
	// phrase defeats a substring check. Twin of stripAnsi in tmuxCore.ts.
	private val ansiRe = Regex("\\u001B\\[[0-9;?]*[A-Za-z]")

	private fun strip(screen: String): String = ansiRe.replace(screen, "")

	/**
	 * What follows the LAST rule run on a line, or null when the line carries none.
	 *
	 * Empty string when the run ends the line (the ordinary unjoined shape) - distinct from null, and
	 * the distinction is the point: "" means a boundary is here with nothing after it, null means no
	 * boundary at all. The run is not assumed to start the line: an unresized Windows composer row
	 * carries a span of spaces before it. Twin of afterRuleRun in agent-screen.ts.
	 */
	private fun afterRuleRun(line: String, runRe: Regex): String? {
		val match = runRe.findAll(line).lastOrNull() ?: return null
		return line.substring(match.range.last + 1)
	}

	/**
	 * The region a footer reader may look at: whatever follows the last toolbar rule run, plus every
	 * line below it. The one place that knows a rule can share its line with text.
	 *
	 * The last-two-lines fallback is applied UNIFORMLY here, which is a fix in itself: it used to live
	 * in isWorking alone, while isLoggedOut computed drop(lastRule + 1) with lastRule at -1 and so read
	 * drop(0) - the ENTIRE screen, transcript included, which is exactly what scoping this region
	 * exists to prevent. Twin of footerRegion in agent-screen.ts.
	 */
	private fun footerRegion(lines: List<String>): List<String> {
		for (i in lines.indices.reversed()) {
			val after = afterRuleRun(lines[i], toolbarRunRe) ?: continue
			return listOf(after) + lines.drop(i + 1)
		}
		return lines.takeLast(2)
	}

	fun isReady(screen: String): Boolean =
		strip(screen).split("\n").any { line ->
			// Column 0, the unjoined shape; or welded to the rule above it, which is EVERY Windows frame.
			// Anchoring on the post-rule remainder keeps menus rejected, since an indented "  ❯ 1." keeps
			// its indentation across the join and still fails the anchor.
			composerRe.containsMatchIn(line) || afterRuleRun(line, toolbarRunRe)?.let { composerRe.containsMatchIn(it) } == true
		}

	fun isWorking(screen: String): Boolean =
		footerRegion(strip(screen).split("\n")).any { it.contains(WORKING_HINT) || it.contains(WORKING_CIRCLE_HINT) }

	fun isLoggedOut(screen: String): Boolean {
		val footer = footerRegion(strip(screen).split("\n")).joinToString("\n")
		return footer.contains("Not logged in") || footer.contains("Run /login")
	}

	/** The headline of a usage-limit dialog plus the text after its middle dot, e.g. "resets 5pm". */
	/** `headline` is null when it has already scrolled off the pane, which is common. The dialog itself
	 * is what proves the session is blocked, so neither field is load-bearing. */
	data class LimitNotice(val headline: String?, val detail: String?)

	/**
	 * The usage-limit dialog, i.e. the agent has stopped and cannot progress until the choice is
	 * answered. Twin of limitNotice in agent-screen.ts, held equivalent by
	 * tests/fixtures/limit-notice/vectors.json.
	 *
	 * The DIALOG is the signal, never the headline. Both below-divider markers are required, since
	 * neither is sufficient alone: the dialog title is reused by unrelated dialogs and a numbered menu
	 * is just as present on a permission prompt, but together they appear nowhere else.
	 *
	 * The headline only enriches the notice and is frequently absent, since the dialog is pinned to the
	 * bottom of the pane and the headline has usually scrolled past. Requiring it missed the common case.
	 */
	fun limitNotice(screen: String): LimitNotice? {
		val lines = strip(screen).split("\n")
		// Lowest divider whose region below carries both signals. Not simply the last rule: a dialog
		// that draws its own bottom border would put that border last, leaving the menu above unseen.
		// Its OWN loop, not footerRegion: that answers "the last toolbar boundary", and this needs the
		// lowest divider whose region below carries both signals, which is not the same line.
		//
		// TWO PASSES, strictly ordered. Pass 1 is the historical predicate unchanged, so any frame that
		// used to resolve still resolves to the SAME divider. Widening it in place looked equivalent and
		// was not: a text-bearing rule line (a titled border is that shape) would newly qualify, and
		// since the search takes the bottom-most match the divider could move DOWN past the real one,
		// after which the upward headline walk stops on the true divider and returns null where a
		// headline was found before. Pass 2 runs only when pass 1 finds nothing and admits a rule welded
		// to text - the Windows shape, purely additive, and UNPROVEN since no Windows limit-dialog frame
		// has been captured. Twin of the two-pass search in agent-screen.ts.
		fun findDivider(accept: (String) -> String?): Int {
			for (i in lines.indices.reversed()) {
				val after = accept(lines[i]) ?: continue
				val below = (listOf(after) + lines.drop(i + 1)).joinToString("\n")
				if (menuCursorRe.containsMatchIn(below) && below.contains(LIMIT_MENU_HINT)) return i
			}
			return -1
		}
		var divider = findDivider { if (anyRuleLineRe.matches(it.trim())) "" else null }
		if (divider < 0) divider = findDivider { afterRuleRun(it, anyRuleRunRe) }
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
		// Blocked regardless: the dialog is up, the headline just is not on screen to say why.
		return LimitNotice(null, null)
	}
}
