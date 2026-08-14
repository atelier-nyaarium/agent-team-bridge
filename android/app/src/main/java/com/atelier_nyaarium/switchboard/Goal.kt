package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/** A goal armed against one team. The phase is read from the two instants, never stored. */
data class PendingGoal(
	/** Already through [sanitizeGoalText]: one line, trimmed, capped. */
	val text: String,
	val armedAt: Long,
	/** When the message this goal rides settled as sent. A reply that beat it is answering something else. */
	val sentAt: Long? = null,
	val replyAt: Long? = null,
)

/** What the goal driver should do this pass. */
sealed interface GoalStep {
	data object AwaitReply : GoalStep

	data object AwaitIdle : GoalStep

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

internal const val GOAL_REPLY_TIMEOUT_MS = 60 * 60_000L

/** A session that answered and then stayed busy this long is doing something else. */
internal const val GOAL_IDLE_TIMEOUT_MS = 3 * 60_000L

/** Above the gateway's own 300ms peek floor. */
internal const val GOAL_IDLE_POLL_MS = 2_000L

internal const val GOAL_REPLY_POLL_MS = 5_000L

/** One line, trimmed, capped. A newline would submit the composer halfway through. */
internal fun sanitizeGoalText(raw: String): String {
	val oneLine = raw.replace(Regex("\\s+"), " ").trim()
	if (oneLine.length <= GOAL_MAX_CHARS) return oneLine
	val cut = oneLine.take(GOAL_MAX_CHARS)
	// A cut between a surrogate pair would type half a character.
	return if (cut.lastOrNull()?.isHighSurrogate() == true) cut.dropLast(1) else cut
}

/** Whether a row is the session answering. A status row is delivery news, not the session speaking. */
internal fun isGoalReply(msg: Message): Boolean = !msg.isPeer && msg.status == null

// Own strip rather than AgentScreen's, which is a twin of shared/agent-screen.ts and takes no
// console-only predicate. Wrapped composer content continues on indented rows, so this line decides.
private val ANSI_RE = Regex("\\u001B\\[[0-9;?]*[A-Za-z]")
private val COMPOSER_RE = Regex("^\\u276F(.*)$", RegexOption.MULTILINE)

/**
 * Whether the composer is present and holds nothing. Typing appends, so a half-typed line the owner
 * left would be submitted joined to the goal.
 *
 * A future CLI painting a ghost hint into an empty composer would read as occupied here and expire
 * the goal unfired. That failure is visible and destroys nothing.
 */
internal fun composerIsEmpty(screen: String): Boolean {
	val line = COMPOSER_RE.findAll(ANSI_RE.replace(screen, "")).lastOrNull() ?: return false
	return line.groupValues[1].isBlank()
}

/** The whole wait rule. `screen` is null when there was nothing to peek at, which means keep waiting. */
internal fun goalStep(rec: PendingGoal, now: Long, screen: String?): GoalStep {
	if (rec.replyAt == null) {
		if (now - rec.armedAt >= GOAL_REPLY_TIMEOUT_MS) return GoalStep.Expire("it never replied")
		return GoalStep.AwaitReply
	}
	if (now - rec.replyAt >= GOAL_IDLE_TIMEOUT_MS) return GoalStep.Expire("its terminal never went idle")
	if (rec.sentAt == null) return GoalStep.AwaitIdle
	if (screen == null) return GoalStep.AwaitIdle
	// isWorking is false for a pane held by a dialog, where a slash command would answer it instead.
	val typable = AgentScreen.isReady(screen) && !AgentScreen.isWorking(screen) && composerIsEmpty(screen)
	return if (typable) GoalStep.Inject else GoalStep.AwaitIdle
}
