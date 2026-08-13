package com.atelier_nyaarium.switchboard

/**
 * Where a playback is, whose it is, and which AUDIO it is in.
 *
 * The owner rides along so a caller never has to guess whose position it just read; asking the
 * queue instead names the wrong sound for the whole marker sequence at the head of a run.
 *
 * `audio` is the cache file's name, and it is not redundant with the owner. One message is spoken
 * two ways - attributed when played by hand, unattributed inside a run where the sentinel already
 * said the session - so an offset filed under the entry alone would be handed to a DIFFERENT
 * recording of the same message, of a different length.
 */
data class Position(val owner: PlaybackId, val audio: String, val positionMs: Long, val durationMs: Long) {
	/** The (team, at, tier) this playback belongs to, for comparing against a queue entry. */
	val entry: QueueEntry get() = QueueEntry(owner.team, owner.at, owner.tier)

	internal val key: ResumeKey get() = ResumeKey(entry, audio)
}

/** What a resume offset is filed under: the message it belongs to AND the recording it points
 * into. The entry half keeps forget-by-message and purge-by-team expressible; the audio half is
 * what stops one rendering's offset being applied to another's. */
internal data class ResumeKey(val entry: QueueEntry, val audio: String)
