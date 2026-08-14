package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The goal wait ([goalStep]) and the text it types. Every branch decides whether a slash command
 * lands in a live terminal. */
class GoalTest {
	private val rule = "─".repeat(40)
	private val idlePane = "Claude Code v2.1.0\n❯ "

	// Working, with the composer free: the message went over the wire, not through the box.
	private val busyPane = "❯ \n$rule\n✻ Prestidigitating… (12s · esc to interrupt)\n  ⏵⏵ bypass permissions on"

	// A dialog holds the pane: no composer at column 0.
	private val dialogPane = "  ❯ 1. Yes, allow this"

	private fun armed(sentAt: Long? = 1L) = PendingGoal(text = "Complete the plan", armedAt = 0L, sentAt = sentAt)

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
		// The cap lands mid-pair here, since each emoji is two chars.
		val emoji = "🚀".repeat(GOAL_MAX_CHARS)
		val capped = sanitizeGoalText("a" + emoji)
		assertEquals("a lone surrogate must never end the typed text", false, capped.last().isHighSurrogate())
		assertEquals(GOAL_MAX_CHARS - 1, capped.length)
	}

	////////////////////////////////
	//  The wait

	@Test
	fun aWorkingSessionIsTypedIntoAnywayAndTheCliQueuesIt() {
		assertEquals(GoalStep.Inject, goalStep(armed(), now = 20L, screen = busyPane))
	}

	@Test
	fun anIdlePaneIsTypedIntoTheSameWay() {
		assertEquals(GoalStep.Inject, goalStep(armed(), now = 20L, screen = idlePane))
	}

	@Test
	fun nothingIsTypedUntilTheMessageItRidesHasGoneOut() {
		assertEquals(GoalStep.Wait, goalStep(armed(sentAt = null), now = 20L, screen = idlePane))
	}

	@Test
	fun aFailedCaptureWaitsRatherThanTypingBlind() {
		assertEquals(GoalStep.Wait, goalStep(armed(), now = 20L, screen = null))
	}

	@Test
	fun aPaneHeldByADialogIsWaitedOut() {
		assertEquals(GoalStep.Wait, goalStep(armed(), now = 20L, screen = dialogPane))
	}

	@Test
	fun aComposerHoldingSomeoneElsesHalfTypedLineIsNotTypedInto() {
		// Typing appends, so this would submit their fragment with the goal joined onto it.
		val occupied = "Claude Code v2.1.232\n❯ what I was in the middle of"
		assertEquals(false, composerIsEmpty(occupied))
		assertEquals(GoalStep.Wait, goalStep(armed(), now = 20L, screen = occupied))
		// Empty is the prompt and trailing spaces, colour escapes included.
		val esc = Char(27)
		assertEquals(true, composerIsEmpty("$esc[2m❯$esc[0m   "))
		// No composer at all is not empty, or a booting pane would read as ready to type into.
		assertEquals(false, composerIsEmpty("Loading development channels..."))
	}

	@Test
	fun theLiveComposerIsTheLastPromptRowNotAQueuedMessagesOwn() {
		// A message queued mid-turn draws its own prompt row above the live, empty composer.
		val queued = "❯ queued text\n$rule\n❯ \n$rule\n  ⏵⏵ bypass permissions on"
		assertEquals(true, composerIsEmpty(queued))
		assertEquals(GoalStep.Inject, goalStep(armed(), now = 20L, screen = queued))
	}

	@Test
	fun aTerminalThatNeverTakesOneRetiresTheGoal() {
		assertEquals(GoalStep.Wait, goalStep(armed(), now = GOAL_TIMEOUT_MS - 1, screen = dialogPane))
		assertTrue(goalStep(armed(), now = GOAL_TIMEOUT_MS, screen = dialogPane) is GoalStep.Expire)
	}
}
