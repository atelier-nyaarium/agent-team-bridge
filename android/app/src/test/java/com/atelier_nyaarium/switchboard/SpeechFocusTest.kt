package com.atelier_nyaarium.switchboard

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Test

/** What a focus change means for a run ([focusAction]). */
class SpeechFocusTest {
	@Test
	fun aDuckableLossKeepsSpeaking() {
		// What a notification ping raises. Pausing on it killed every run: the transport releases
		// focus while paused, so no GAIN could arrive to lift it.
		assertEquals(FocusAction.KEEP, focusAction(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
	}

	@Test
	fun aCallPausesAndAPermanentLossStops() {
		assertEquals(FocusAction.PAUSE, focusAction(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT))
		assertEquals(FocusAction.STOP, focusAction(AudioManager.AUDIOFOCUS_LOSS))
	}

	@Test
	fun focusComingBackIsItsOwnAnswer() {
		assertEquals(FocusAction.REGAINED, focusAction(AudioManager.AUDIOFOCUS_GAIN))
	}

	@Test
	fun aFocusPauseKeepsTheRequestSoTheGainCanLiftIt() {
		// Releasing drops the listener, so the pause a call caused could never be lifted and the run
		// sat there until someone pressed play.
		assertEquals(FocusHold.KEEP, focusHold(active = true, paused = true, pausedByFocus = true))
	}

	@Test
	fun aHandPauseStillGivesTheUsersMusicBack() {
		assertEquals(FocusHold.RELEASE, focusHold(active = true, paused = true, pausedByFocus = false))
	}

	@Test
	fun nothingLeftToResumeReleasesEitherWay() {
		// Otherwise a finished run keeps its request registered forever, waiting on a GAIN with an
		// empty queue behind it.
		assertEquals(FocusHold.RELEASE, focusHold(active = false, paused = true, pausedByFocus = true))
		assertEquals(FocusHold.RELEASE, focusHold(active = false, paused = false, pausedByFocus = false))
	}

	@Test
	fun aRunningQueueHoldsTheSound() {
		assertEquals(FocusHold.ACQUIRE, focusHold(active = true, paused = false, pausedByFocus = false))
	}

	@Test
	fun anUnknownChangeNeverSilencesTheRun() {
		// The transient variants of GAIN land here, and none of them is a reason to stop.
		assertEquals(FocusAction.KEEP, focusAction(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT))
		assertEquals(FocusAction.KEEP, focusAction(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK))
		assertEquals(FocusAction.KEEP, focusAction(0))
	}
}
