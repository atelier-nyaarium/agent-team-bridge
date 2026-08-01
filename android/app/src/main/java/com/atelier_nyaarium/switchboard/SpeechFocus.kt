package com.atelier_nyaarium.switchboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager

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
 * Every loss PAUSES, including the duckable one. That is the explicit choice the plan leaves open:
 * with `CONTENT_TYPE_SPEECH` the system does not auto-duck, and ducking speech underneath a
 * navigation prompt leaves two voices talking at once, which is worse than a gap. A pause holds the
 * queue intact and the run resumes when focus returns.
 *
 * Unplugging headphones is not a focus change at all, so it needs its own receiver. Without it, audio
 * routed to a headset re-routes to the phone's speaker and keeps reading agent messages aloud into
 * whatever room the user is standing in.
 */
class SpeechFocus(
	private val context: Context,
	private val onPause: () -> Unit,
	private val onResume: () -> Unit,
) {
	private val audio = context.getSystemService(AudioManager::class.java)
	private var request: AudioFocusRequest? = null

	// Whether the pause currently in force was ours. A user who paused by hand must not be un-paused by
	// focus coming back - the phone call ending is not permission to start talking again.
	private var pausedByFocus = false

	private val noisy = object : BroadcastReceiver() {
		override fun onReceive(context: Context?, intent: Intent?) {
			if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
			pausedByFocus = true
			onPause()
		}
	}
	private var noisyRegistered = false

	/** Ask for the sound. Returns whether it was granted; a refusal means something else is mid-call
	 * and speaking over it is exactly what this class exists to prevent. */
	fun acquire(): Boolean {
		if (request != null) return true
		val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
			.setAudioAttributes(
				AudioAttributes.Builder()
					.setUsage(AudioAttributes.USAGE_MEDIA)
					.setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
					.build(),
			)
			.setOnAudioFocusChangeListener { change -> onFocusChange(change) }
			.build()
		val granted = audio.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
		if (granted) {
			request = req
			registerNoisy()
		}
		return granted
	}

	fun release() {
		request?.let { audio.abandonAudioFocusRequest(it) }
		request = null
		pausedByFocus = false
		unregisterNoisy()
	}

	private fun onFocusChange(change: Int) {
		when (change) {
			AudioManager.AUDIOFOCUS_GAIN -> {
				if (!pausedByFocus) return
				pausedByFocus = false
				onResume()
			}
			// Permanent. Pause and stay paused: whatever took the sound means to keep it, and the queue
			// survives so the user can start it again themselves.
			AudioManager.AUDIOFOCUS_LOSS -> {
				pausedByFocus = false
				onPause()
			}
			AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
				pausedByFocus = true
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
