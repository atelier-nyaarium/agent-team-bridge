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
	fun anUnknownChangeNeverSilencesTheRun() {
		// The transient variants of GAIN land here, and none of them is a reason to stop.
		assertEquals(FocusAction.KEEP, focusAction(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT))
		assertEquals(FocusAction.KEEP, focusAction(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK))
		assertEquals(FocusAction.KEEP, focusAction(0))
	}
}
