package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/**
 * The pending outgoing message for one thread: what the composer shows and what Send consumes.
 *
 * Files are already-copied refs rather than live picker grants, so a draft outlives both the grant
 * and the process, matching the durability its text always had.
 *
 * `locations` is where each picked file came from, keyed by its src. It sits HERE rather than on
 * [MessageFile] so the conversion to an outgoing file, and from there to the wire, has nowhere to
 * put it: a device path names a user and a folder layout, and these cross a gateway to another
 * machine. Draft-only by construction rather than by promise.
 */
data class Draft(
	val text: String = "",
	val files: List<MessageFile> = emptyList(),
	val locations: Map<String, String> = emptyMap(),
) {
	val isOccupied: Boolean get() = text.isNotBlank() || files.isNotEmpty()
}

////////////////////////////////
//  Functions & Helpers

/** Write `team`'s draft, dropping the entry once it is no longer occupied. The single point that
 * keeps `drafts` sparse. */
internal fun ChatState.withDraft(team: String, draft: Draft): ChatState =
	copy(drafts = if (draft.isOccupied) drafts + (team to draft) else drafts - team)

/** The merge `takeBackIntoDraft` applies. Files always UNION, since a list has a
 * meaningful merge and no caller should drop a pick; text lands only on a blank draft, since it has
 * no merge and anything already typed wins. The taken-back files bring no locations of their own: a
 * sent file's origin was never recoverable, being read from a content Uri that is gone by then. */
internal fun mergeTakenBackDraft(current: Draft, text: String, files: List<MessageFile>): Draft =
	current.copy(
		text = if (current.text.isBlank()) text else current.text,
		files = (current.files + files).distinct(),
	)
