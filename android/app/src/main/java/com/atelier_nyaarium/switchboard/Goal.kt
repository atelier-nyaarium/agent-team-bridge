package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/**
 * A goal armed against one team: the description to type once that session has answered the message
 * the goal rode in on, and the two instants the wait is timed from.
 *
 * The phase is READ from the two nullable instants rather than stored as its own field, so a record
 * restored from disk cannot disagree with itself about how far along it is.
 */
data class PendingGoal(
	/** The description, already through [sanitizeGoalText]: one line, trimmed, capped. Typed as its
	 * own paste after the "/goal " prefix, never joined to it. */
	val text: String,
	val armedAt: Long,
	/** When the message this goal rides settled as sent. Null while that send is still in flight;
	 * nothing may be typed before it is set, because a reply that beat the send is answering
	 * something else. */
	val sentAt: Long? = null,
	/** When the session first said something back. Null while the reply is still awaited. */
	val replyAt: Long? = null,
)

/** What the goal driver should do this pass. [GoalStep.Expire] carries the phrase the user is told. */
sealed interface GoalStep {
	/** The session has not answered yet. Nothing to peek at - a session mid-turn is not idle in any
	 * sense this cares about. */
	data object AwaitReply : GoalStep

	/** It answered; the pane is not ready to take a slash command yet. */
	data object AwaitIdle : GoalStep

	/** Type it. */
	data object Inject : GoalStep

	data class Expire(val reason: String) : GoalStep
}

////////////////////////////////
//  Functions & Helpers

/** The composer field's own limit, and the backstop [sanitizeGoalText] caps at. Well under the
 * tmux_send op's 4096-char text bound, so the typed line can never be refused for length. */
internal const val GOAL_MAX_CHARS = 500

/** Typed alone, so the CLI reads it as a command rather than folding it into the paste that follows. */
internal const val GOAL_COMMAND = "/goal "

/** How long a session has to say something back before the goal is dropped. Generous: the whole
 * point is to arm one against work that takes a while. */
internal const val GOAL_REPLY_TIMEOUT_MS = 60 * 60_000L

/** How long after that reply the pane has to become ready. Short by comparison: a session that
 * answered and then stayed busy this long is doing something else, and typing a goal into it now
 * would land in the middle of that instead. */
internal const val GOAL_IDLE_TIMEOUT_MS = 3 * 60_000L

/** Peek cadence while waiting for the pane. Comfortably above the gateway's own 300ms peek floor. */
internal const val GOAL_IDLE_POLL_MS = 2_000L

/** Re-read cadence while waiting for the reply. Costs no network at all - the arriving reply is
 * what actually advances the record, and this only decides how soon the driver notices. */
internal const val GOAL_REPLY_POLL_MS = 5_000L

/**
 * One line, trimmed, capped. A newline would submit the composer halfway through the description, so
 * every whitespace run (tabs and newlines included) collapses to a single space rather than being
 * rejected - a pasted paragraph is a reasonable goal, just not a reasonable set of keystrokes.
 *
 * Returns empty for a blank goal, which the caller refuses to arm.
 */
internal fun sanitizeGoalText(raw: String): String {
	val oneLine = raw.replace(Regex("\\s+"), " ").trim()
	if (oneLine.length <= GOAL_MAX_CHARS) return oneLine
	// A cut landing between a surrogate pair would type a lone half of one, which is not a character
	// on either side of the wire.
	val cut = oneLine.take(GOAL_MAX_CHARS)
	return if (cut.lastOrNull()?.isHighSurrogate() == true) cut.dropLast(1) else cut
}

/**
 * Whether an arriving row is the session ANSWERING, which is what the first half of the wait is for.
 *
 * A peer-mirror row is an agent-to-agent exchange shown for visibility, never an answer to the
 * console - the same distinction appendInbound draws before it clears a cold-wake notice. A row
 * carrying a status is the console being told about delivery (a failed wake, a run state), not the
 * session speaking: a genuine `channel_reply` sends no status at all, and counting one would start
 * the short pane budget while a cold wake is still minutes from producing a pane.
 */
internal fun isGoalReply(msg: Message): Boolean = !msg.isPeer && msg.status == null

// The composer row: the prompt glyph at column 0 and whatever follows it on that line. Wrapped
// content continues on INDENTED rows, so this one line carries the answer. Its own strip rather than
// AgentScreen's, since that object is a twin of shared/agent-screen.ts and takes no console-only
// predicate (see its header).
private val ANSI_RE = Regex("\\u001B\\[[0-9;?]*[A-Za-z]")
private val COMPOSER_RE = Regex("^\\u276F(.*)$", RegexOption.MULTILINE)

/**
 * Whether the pane's composer is present AND holds nothing.
 *
 * Typing APPENDS to whatever is already in there. A line the owner half-typed and walked away from
 * would be submitted joined to the goal - measured, not theorized: probing this by hand produced
 * `Goal set: ...the /goal clear`, one command swallowed into the tail of another.
 *
 * The trade is stated rather than hidden: if a future CLI paints a ghost hint into an empty
 * composer, this reads as occupied and the goal expires unfired with its own notice. That is the
 * failure worth having - visible, and it destroys nothing.
 */
internal fun composerIsEmpty(screen: String): Boolean {
	val line = COMPOSER_RE.findAll(ANSI_RE.replace(screen, "")).lastOrNull() ?: return false
	return line.groupValues[1].isBlank()
}

/**
 * The whole wait/type/give-up rule, pure so every branch is reachable from a test: the driver only
 * supplies the clock and the pane it just captured.
 *
 * `screen` is the latest peek, or null when there was nothing to peek at (still awaiting the reply,
 * or the capture failed) - which is a reason to keep waiting, never to type blind.
 */
internal fun goalStep(rec: PendingGoal, now: Long, screen: String?): GoalStep {
	if (rec.replyAt == null) {
		if (now - rec.armedAt >= GOAL_REPLY_TIMEOUT_MS) return GoalStep.Expire("it never replied")
		return GoalStep.AwaitReply
	}
	if (now - rec.replyAt >= GOAL_IDLE_TIMEOUT_MS) return GoalStep.Expire("its terminal never went idle")
	// A reply can genuinely land before send() returns (the wire ack is not the answer's dependency),
	// so the send settling is its own precondition rather than something the reply implies.
	if (rec.sentAt == null) return GoalStep.AwaitIdle
	if (screen == null) return GoalStep.AwaitIdle
	// All three are load-bearing. isWorking alone is false for a pane holding a permission dialog or a
	// menu, where a typed slash command would answer the dialog instead of setting a goal; and a ready,
	// idle pane can still hold half a typed line that the goal would be submitted joined to.
	val typable = AgentScreen.isReady(screen) && !AgentScreen.isWorking(screen) && composerIsEmpty(screen)
	return if (typable) GoalStep.Inject else GoalStep.AwaitIdle
}
