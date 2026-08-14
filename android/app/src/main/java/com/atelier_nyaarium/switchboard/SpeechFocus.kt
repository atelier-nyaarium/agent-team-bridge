package com.atelier_nyaarium.switchboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager

////////////////////////////////
//  Interfaces & Types

/** What a focus change means for a run. */
internal enum class FocusAction {
	/** Keep speaking. */
	KEEP,

	/** Pause, and resume when focus comes back. */
	PAUSE,

	/** Pause and give the request up: whatever took the sound means to keep it. */
	STOP,

	/** Focus is back. */
	REGAINED,
}

////////////////////////////////
//  Functions & Helpers

/**
 * Pure so every branch is testable without an AudioManager.
 *
 * A DUCKABLE loss keeps speaking. It is what a notification ping raises, and pausing on it killed
 * every run: the transport releases focus while paused, so no GAIN could arrive to lift it, and
 * autoplay is triggered by the same arriving message that pings.
 */
internal fun focusAction(change: Int): FocusAction = when (change) {
	AudioManager.AUDIOFOCUS_GAIN -> FocusAction.REGAINED
	AudioManager.AUDIOFOCUS_LOSS -> FocusAction.STOP
	AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> FocusAction.PAUSE
	else -> FocusAction.KEEP
}

////////////////////////////////
//  Class

/**
 * The right to speak out loud, and the duty to stop.
 *
 * Held for a RUN rather than per playback: a burst is one continuous act of speaking, and requesting
 * per file would drop and retake focus in every marker gap, which other apps see as a stutter of
 * ducking.
 *
 * TRANSIENT gain, because a run speaks and ends - permanent gain stops the user's music for good
 * rather than letting it come back when the queue drains.
 *
 * What each loss means is [focusAction]'s call.
 *
 * Unplugging headphones is not a focus change at all, so it needs its own receiver. Without it, audio
 * routed to a headset re-routes to the phone's speaker and keeps reading agent messages aloud into
 * whatever room the user is standing in.
 */
class SpeechFocus(
	private val context: Context,
	private val alreadyPaused: () -> Boolean,
	private val onPause: () -> Unit,
	private val onResume: () -> Unit,
) {
	private val audio = context.getSystemService(AudioManager::class.java)
	private var request: AudioFocusRequest? = null

	// Whether we are actually HOLDING focus, which is not the same as having a request object. A
	// permanent loss takes the sound away while the request lives on, and treating the object as proof
	// of ownership meant every later acquire short-circuited and the app spoke holding nothing.
	private var held = false

	// Whether the pause in force is one WE caused and should undo. Set only when we pause something
	// that was not already paused: a user who paused by hand must not be started up again by a call
	// ending, and an unplugged headset must not resume onto the loudspeaker when focus returns.
	private var pausedByFocus = false

	private val noisy = object : BroadcastReceiver() {
		override fun onReceive(context: Context?, intent: Intent?) {
			if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
			// Deliberately NOT pausedByFocus. Headphones coming back out of a pocket is not consent to
			// start speaking into a room.
			pausedByFocus = false
			onPause()
		}
	}
	private var noisyRegistered = false

	/** Ask for the sound. Returns whether it was granted; a refusal means something else is mid-call
	 * and speaking over it is exactly what this class exists to prevent. */
	fun acquire(): Boolean {
		if (held) return true
		val req = request ?: build().also { request = it }
		held = audio.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
		// Registered even on refusal. The unplug guard protects whatever is routed to the headset,
		// which on a refusal is somebody else's audio and no less worth stopping.
		registerNoisy()
		return held
	}

	fun release() {
		request?.let { audio.abandonAudioFocusRequest(it) }
		request = null
		held = false
		pausedByFocus = false
		unregisterNoisy()
	}

	private fun build(): AudioFocusRequest =
		AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
			.setAudioAttributes(
				AudioAttributes.Builder()
					.setUsage(AudioAttributes.USAGE_MEDIA)
					.setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
					.build(),
			)
			.setOnAudioFocusChangeListener { change -> onFocusChange(change) }
			.build()

	private fun onFocusChange(change: Int) {
		when (focusAction(change)) {
			FocusAction.KEEP -> Unit
			FocusAction.REGAINED -> {
				held = true
				if (!pausedByFocus) return
				pausedByFocus = false
				onResume()
			}
			// Holding a dead request would make the next acquire believe it still owns the sound.
			FocusAction.STOP -> {
				held = false
				pausedByFocus = false
				request?.let { audio.abandonAudioFocusRequest(it) }
				request = null
				onPause()
			}
			FocusAction.PAUSE -> {
				held = false
				// Only ours to undo if it was not already held. Setting this unconditionally meant a call
				// arriving during a hand pause armed a resume, and the phone spoke when the call ended.
				pausedByFocus = !alreadyPaused()
				onPause()
			}
		}
	}

	private fun registerNoisy() {
		if (noisyRegistered) return
		context.registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
		noisyRegistered = true
	}

	private fun unregisterNoisy() {
		if (!noisyRegistered) return
		runCatching { context.unregisterReceiver(noisy) }
		noisyRegistered = false
	}
}
