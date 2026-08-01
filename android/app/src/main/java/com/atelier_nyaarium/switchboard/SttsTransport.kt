package com.atelier_nyaarium.switchboard

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.session.MediaSession
import android.media.session.PlaybackState

/**
 * The lockscreen, shade, headphone and watch controls for the autoplay run.
 *
 * Platform `MediaSession` rather than a media library: `minSdk 33` puts this and `MediaStyle` in the
 * framework, and a transport this small does not justify a dependency tree in a project pinned to
 * exact versions.
 *
 * Owns no playback state of its own. It publishes what the repository says and turns button presses
 * back into repository calls - the same rule the in-thread row follows, so two surfaces cannot drift
 * apart by each keeping their own idea of what is playing.
 */
class SttsTransport(
	private val context: Context,
	private val channelId: String,
	private val onPlay: () -> Unit,
	private val onPause: () -> Unit,
	private val onSkip: () -> Unit,
) {
	private val session = MediaSession(context, "Switchboard").apply {
		setCallback(
			object : MediaSession.Callback() {
				override fun onPlay() = this@SttsTransport.onPlay()

				override fun onPause() = this@SttsTransport.onPause()

				override fun onSkipToNext() = this@SttsTransport.onSkip()

				/** A headset's single button reports as a stop on some devices. Treated as a pause, not
				 * a teardown: there is no way back from a stop, and the run is meant to be resumable. */
				override fun onStop() = this@SttsTransport.onPause()
			},
		)
	}

	val token: MediaSession.Token get() = session.sessionToken

	/**
	 * Publish what the run is doing. `active` false releases the session, which is what takes the
	 * controls off the lockscreen - leaving a session active with nothing to play puts a dead
	 * transport in front of the user on every unlock.
	 */
	fun publish(active: Boolean, paused: Boolean, speaking: String?) {
		session.isActive = active
		if (!active) return
		session.setPlaybackState(
			PlaybackState.Builder()
				.setActions(
					PlaybackState.ACTION_PLAY or
						PlaybackState.ACTION_PAUSE or
						PlaybackState.ACTION_PLAY_PAUSE or
						PlaybackState.ACTION_SKIP_TO_NEXT,
				)
				// Position is reported as unknown rather than zero: there is no seek yet, and a bar
				// pinned at the start reads as broken where an absent one reads as unavailable.
				.setState(
					if (paused) PlaybackState.STATE_PAUSED else PlaybackState.STATE_PLAYING,
					PlaybackState.PLAYBACK_POSITION_UNKNOWN,
					1f,
				)
				.build(),
		)
		session.setMetadata(
			android.media.MediaMetadata.Builder()
				.putString(android.media.MediaMetadata.METADATA_KEY_TITLE, speaking ?: "Switchboard")
				.putString(android.media.MediaMetadata.METADATA_KEY_ARTIST, "Agent messages")
				.build(),
		)
	}

	/** A media-style notification carrying the same three controls, for the shade. */
	fun notification(paused: Boolean, speaking: String?): Notification =
		Notification.Builder(context, channelId)
			.setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
			.setContentTitle(speaking ?: "Speaking")
			.setContentText("Agent messages")
			// Ongoing even while paused. A paused run is not a finished one, and making the notification
			// dismissible exactly when it is paused would let the only control that can un-pause be
			// swiped away - leaving autoplay held with nothing left to release it.
			.setOngoing(true)
			.addAction(
				if (paused) {
					action(android.R.drawable.ic_media_play, "Play", ACTION_PLAY)
				} else {
					action(android.R.drawable.ic_media_pause, "Pause", ACTION_PAUSE)
				},
			)
			.addAction(action(android.R.drawable.ic_media_next, "Skip", ACTION_SKIP))
			.setStyle(Notification.MediaStyle().setMediaSession(token).setShowActionsInCompactView(0, 1))
			.build()

	fun release() {
		session.isActive = false
		session.release()
	}

	private fun action(icon: Int, label: String, action: String): Notification.Action =
		Notification.Action.Builder(
			android.graphics.drawable.Icon.createWithResource(context, icon),
			label,
			PendingIntent.getBroadcast(
				context,
				action.hashCode(),
				// Explicit component. The receiver declares no intent-filter, so an action-only intent
				// resolves to nothing and the button silently does nothing.
				Intent(context, NotificationReceiver::class.java).setAction(action),
				PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
			),
		).build()

	companion object {
		const val ACTION_PLAY = "com.atelier_nyaarium.switchboard.TRANSPORT_PLAY"
		const val ACTION_PAUSE = "com.atelier_nyaarium.switchboard.TRANSPORT_PAUSE"
		const val ACTION_SKIP = "com.atelier_nyaarium.switchboard.TRANSPORT_SKIP"
	}
}
