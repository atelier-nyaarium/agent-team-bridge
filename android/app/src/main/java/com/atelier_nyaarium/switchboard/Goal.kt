package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/** A goal armed against one team, waiting for that session's composer to be free. */
data class PendingGoal(
	/** Already through [sanitizeGoalText]: one line, trimmed, capped. */
	val text: String,
	val armedAt: Long,
	/** When the message this goal rides settled as sent. Nothing is typed before it is set. */
	val sentAt: Long? = null,
)

/** What the goal driver should do this pass. */
sealed interface GoalStep {
	data object Wait : GoalStep

	data object Inject : GoalStep

	/** `reason` is the phrase the user is told. */
	data class Expire(val reason: String) : GoalStep
}

////////////////////////////////
//  Functions & Helpers

/** Well under the tmux_send op's 4096-char bound, so the typed line cannot be refused for length. */
internal const val GOAL_MAX_CHARS = 500

/** Typed alone, or the CLI folds it into the paste that follows and reads no command. */
internal const val GOAL_COMMAND = "/goal "

/** Long enough to cover a cold wake, which is the only slow way to a usable composer. */
internal const val GOAL_TIMEOUT_MS = 10 * 60_000L

/** Above the gateway's own 300ms peek floor. */
internal const val GOAL_POLL_MS = 2_000L

/** One line, trimmed, capped. A newline would submit the composer halfway through. */
internal fun sanitizeGoalText(raw: String): String {
	val oneLine = raw.replace(Regex("\\s+"), " ").trim()
	if (oneLine.length <= GOAL_MAX_CHARS) return oneLine
	val cut = oneLine.take(GOAL_MAX_CHARS)
	// A cut between a surrogate pair would type half a character.
	return if (cut.lastOrNull()?.isHighSurrogate() == true) cut.dropLast(1) else cut
}

// Own strip rather than AgentScreen's, which is a twin of shared/agent-screen.ts and takes no
// console-only predicate. The LAST prompt row is the live composer: a message queued mid-turn draws
// its own prompt row above it, and wrapped content continues on indented rows.
private val ANSI_RE = Regex("\\u001B\\[[0-9;?]*[A-Za-z]")
private val COMPOSER_RE = Regex("^\\u276F(.*)$", RegexOption.MULTILINE)

/** Whether the composer is present and holds nothing. Typing appends, so a half-typed line the owner
 * left would be submitted joined to the goal. */
internal fun composerIsEmpty(screen: String): Boolean {
	val line = COMPOSER_RE.findAll(ANSI_RE.replace(screen, "")).lastOrNull() ?: return false
	return line.groupValues[1].isBlank()
}

/**
 * The whole wait rule. `screen` is null when there was nothing to peek at, which means keep waiting.
 *
 * A working session is NOT a reason to wait: the message went over the wire, not through the
 * composer, so the box is free the whole time. A line typed there is queued and runs when the turn
 * ends, which is the point.
 */
internal fun goalStep(rec: PendingGoal, now: Long, screen: String?): GoalStep {
	if (now - rec.armedAt >= GOAL_TIMEOUT_MS) return GoalStep.Expire("its terminal never took one")
	if (rec.sentAt == null || screen == null) return GoalStep.Wait
	// isReady rejects a pane held by a dialog, where a slash command would answer it instead.
	return if (AgentScreen.isReady(screen) && composerIsEmpty(screen)) GoalStep.Inject else GoalStep.Wait
}
