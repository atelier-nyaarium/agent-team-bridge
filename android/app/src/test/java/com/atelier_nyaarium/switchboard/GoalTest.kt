package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The goal wait's whole rule (see [goalStep]) and the text that eventually gets typed. Every branch
 * here decides whether a slash command lands in a live terminal, so each one is stated rather than
 * left to the driver's own sequencing.
 */
class GoalTest {
	private val rule = "─".repeat(40)
	private val idlePane = "Claude Code v2.1.0\n❯ "
	private val busyPane = "❯ \n$rule\n✻ Prestidigitating… (12s · esc to interrupt)\n  ⏵⏵ bypass permissions on"

	// A dialog holds the pane: no composer at column 0, and no working hint either. Neither "ready"
	// nor "working" alone describes it, which is why both halves of the gate are checked.
	private val dialogPane = "  ❯ 1. Yes, allow this"

	private fun armed(sentAt: Long? = 1L, replyAt: Long? = null) =
		PendingGoal(text = "Complete the plan", armedAt = 0L, sentAt = sentAt, replyAt = replyAt)

	////////////////////////////////
	//  The typed text

	@Test
	fun everyWhitespaceRunCollapsesSoTheLineCannotSubmitItself() {
		assertEquals("Complete the plan then tell me", sanitizeGoalText("  Complete the plan\nthen\ttell  me \n"))
		assertEquals("", sanitizeGoalText("   \n\t "))
	}

	@Test
	fun anOverlongGoalIsCappedWithoutLeavingHalfACharacter() {
		assertEquals(GOAL_MAX_CHARS, sanitizeGoalText("a".repeat(GOAL_MAX_CHARS * 2)).length)
		// The cap lands mid-pair here (each emoji is two chars, so char GOAL_MAX_CHARS is a leading
		// surrogate): dropping it is what keeps the typed text made of whole characters.
		val emoji = "🚀".repeat(GOAL_MAX_CHARS)
		val capped = sanitizeGoalText("a" + emoji)
		assertEquals("a lone surrogate must never end the typed text", false, capped.last().isHighSurrogate())
		assertEquals(GOAL_MAX_CHARS - 1, capped.length)
	}

	////////////////////////////////
	//  What counts as the session answering

	@Test
	fun onlyTheSessionsOwnUnstatusedWordStartsThePaneWait() {
		val reply = Message(fromMe = false, text = "done", at = 5L)
		assertEquals(true, isGoalReply(reply))
		// A peer mirror is two agents talking, shown here for visibility only.
		assertEquals(false, isGoalReply(reply.copy(isPeer = true)))
		// A status row is the console being told about delivery. Counting a failed wake as an answer
		// would start the short pane budget while the session is still minutes from having a pane.
		assertEquals(false, isGoalReply(reply.copy(status = "error")))
		assertEquals(false, isGoalReply(reply.copy(status = "running")))
	}

	////////////////////////////////
	//  The wait

	@Test
	fun nothingIsPeekedAtUntilTheSessionHasAnswered() {
		// Even handed an idle pane: a session that has not replied has not done the work the goal is
		// meant to follow, and the driver deliberately supplies no screen in this phase.
		assertEquals(GoalStep.AwaitReply, goalStep(armed(), now = 1_000L, screen = idlePane))
	}

	@Test
	fun aSessionThatNeverAnswersRetiresTheGoal() {
		assertEquals(GoalStep.AwaitReply, goalStep(armed(), now = GOAL_REPLY_TIMEOUT_MS - 1, screen = null))
		assertTrue(goalStep(armed(), now = GOAL_REPLY_TIMEOUT_MS, screen = null) is GoalStep.Expire)
	}

	@Test
	fun aBusyPaneIsWaitedOutRatherThanTypedInto() {
		assertEquals(GoalStep.AwaitIdle, goalStep(armed(replyAt = 10L), now = 20L, screen = busyPane))
	}

	@Test
	fun aPaneHeldByADialogIsNotIdleEitherEvenThoughNothingIsWorking() {
		assertEquals(GoalStep.AwaitIdle, goalStep(armed(replyAt = 10L), now = 20L, screen = dialogPane))
	}

	@Test
	fun aFailedCaptureWaitsRatherThanTypingBlind() {
		assertEquals(GoalStep.AwaitIdle, goalStep(armed(replyAt = 10L), now = 20L, screen = null))
	}

	@Test
	fun aReplyThatBeatTheSendDoesNotUnlockTyping() {
		// The record exists from before the send lands, so an answer to an EARLIER message can set
		// replyAt first. Until the send this goal rides on has settled, an idle pane proves nothing.
		assertEquals(GoalStep.AwaitIdle, goalStep(armed(sentAt = null, replyAt = 10L), now = 20L, screen = idlePane))
	}

	@Test
	fun aComposerHoldingSomeoneElsesHalfTypedLineIsNotTypedInto() {
		// Captured shape from a real pane. Typing appends, so this would submit their fragment with the
		// goal joined onto it - which is exactly what happened when this was probed by hand.
		val occupied = "Claude Code v2.1.232\n❯ what I was in the middle of"
		assertEquals(false, composerIsEmpty(occupied))
		assertEquals(GoalStep.AwaitIdle, goalStep(armed(replyAt = 10L), now = 20L, screen = occupied))
		// An empty composer is the prompt and trailing spaces, colour escapes included. Built from
		// Char(27) rather than written as an escape, so the file stays greppable either way.
		val esc = Char(27)
		assertEquals(true, composerIsEmpty("$esc[2m❯$esc[0m   "))
		// No composer at all is not "empty", or a booting pane would read as ready to type into.
		assertEquals(false, composerIsEmpty("Loading development channels..."))
	}

	@Test
	fun anIdlePaneAfterTheReplyIsWhatTypesIt() {
		assertEquals(GoalStep.Inject, goalStep(armed(replyAt = 10L), now = 20L, screen = idlePane))
	}

	@Test
	fun aPaneThatNeverGoesIdleRetiresTheGoalToo() {
		val rec = armed(replyAt = 10L)
		assertEquals(GoalStep.AwaitIdle, goalStep(rec, now = 10L + GOAL_IDLE_TIMEOUT_MS - 1, screen = busyPane))
		assertTrue(goalStep(rec, now = 10L + GOAL_IDLE_TIMEOUT_MS, screen = busyPane) is GoalStep.Expire)
		// The idle deadline is timed from the REPLY, not from arming, or a session that took an hour
		// to answer would have spent its whole pane budget before anyone looked at the pane.
		val slowToAnswer = armed(replyAt = GOAL_REPLY_TIMEOUT_MS * 2)
		assertEquals(GoalStep.Inject, goalStep(slowToAnswer, now = GOAL_REPLY_TIMEOUT_MS * 2, screen = idlePane))
	}
}
