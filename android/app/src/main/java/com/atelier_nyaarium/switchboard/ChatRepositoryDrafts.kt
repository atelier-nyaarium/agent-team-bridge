package com.atelier_nyaarium.switchboard

import android.net.Uri
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.withContext

////////////////////////////////
//  Composer drafts
//
//  Extensions rather than members: the drafts map lives in ChatState, so none of this holds state
//  of its own.

// Per-thread composer state (ChatState.drafts), persisted so a power-management kill (or any
// process death) never loses a half-typed message or a picked-but-unsent file. Every writer
// below reads-modifies-writes the SAME _state.drafts map through withDraft and persists via
// persistence.persistDrafts, so text, files, and the two restore paths (cancelFailedSend,
// cancelScheduledSendForEdit) can never observe or clobber a stale copy of the map.

/** Set a team's composer text, replacing whatever text was there; files are untouched. */
fun ChatRepository.setDraftText(team: String, text: String) {
	val next = _state.updateAndGet { s ->
		s.withDraft(team, (s.drafts[team] ?: Draft()).copy(text = text))
	}.drafts
	persistence.persistDrafts(next)
}

/** Pick files into a team's draft, eagerly copying them into their own bucket - mirroring
 * scheduleSend's own eager copy at schedule time, since a transient content:// grant may not
 * outlive the wait between picking and Send. Each call mints its OWN bucket (never reused
 * across calls, unlike a row's single out-$opId bucket), so two picks that happen to share a
 * basename cannot overwrite each other on disk. */
suspend fun ChatRepository.addDraftFiles(team: String, uris: List<Uri>) = withContext(Dispatchers.IO) {
	// Admitted like any other pick: a draft is just a send that has not happened yet, so the
	// same admission bound applies here too.
	val (picked, refused) = admitPicked(uris, "pick-${UUID.randomUUID()}")
	if (refused != null) {
		_state.update { it.copy(error = refused.message()) }
		return@withContext
	}
	if (picked.isEmpty()) return@withContext
	// admitPicked is all-or-nothing, so on success these line up with the uris that produced them
	// and each picked file can be asked where it came from. Read now: the content Uri is gone
	// after this call and nothing downstream can recover it.
	val origins = uris.map { PickedLocation.of(it) }
	val paired = Attachments.storeOutgoingPaired(filesDir, "draft-${UUID.randomUUID()}", picked)
	val copied = paired.map { (_, stored) -> stored }
	val located = paired.mapNotNull { (out, stored) ->
		val src = stored.src ?: return@mapNotNull null
		origins.getOrNull(picked.indexOf(out))?.let { src to it }
	}.toMap()
	val next = _state.updateAndGet { s ->
		val current = s.drafts[team] ?: Draft()
		s.withDraft(team, current.copy(files = current.files + copied, locations = current.locations + located))
	}.drafts
	persistence.persistDrafts(next)
}

/** Drop one picked file from a team's draft (the attachment chip's remove) and delete its
 * now-unreferenced copy. */
fun ChatRepository.removeDraftFile(team: String, src: String) {
	val next = _state.updateAndGet { s ->
		val current = s.drafts[team] ?: return@updateAndGet s
		s.withDraft(
			team,
			current.copy(
				files = current.files.filterNot { it.src == src },
				locations = current.locations - src,
			),
		)
	}.drafts
	persistence.persistDrafts(next)
	attachments.scheduleAttachmentDelete(listOf(src))
}

/** Append text to a team's composer draft - the plugin seam (e.g. the Designer's "Reference in
 * chat"). Goes straight through the same drafts map every other writer here uses, so the team
 * binding is enforced by the call itself rather than incidental on an ambient composable var. */
fun ChatRepository.appendDraftText(team: String, insert: String) {
	val current = _state.value.drafts[team] ?: Draft()
	val spaced = current.text.isEmpty() || current.text.endsWith(" ") || current.text.endsWith("\n")
	setDraftText(team, (if (spaced) current.text else "${current.text} ") + insert)
}

/**
 * Hand a not-yet-sent message's content back to a thread's composer. Files always UNION: a list
 * has a meaningful merge, so no caller can drop a pick. Text lands only on a blank draft: it has
 * no merge, so anything already typed wins. Callers may disable their button as UX, but this
 * write is what makes destroying composer contents unexpressible.
 */
fun ChatRepository.takeBackIntoDraft(team: String, text: String, files: List<MessageFile>) {
	val next = _state.updateAndGet { s ->
		s.withDraft(team, mergeTakenBackDraft(s.drafts[team] ?: Draft(), text, files))
	}.drafts
	persistence.persistDrafts(next)
}

/**
 * Drop a team's draft. Every caller reaches here right after handing the draft's contents to a
 * send or a schedule.
 *
 * The draft's own copies of its picked files are deliberately NOT deleted. Send does re-bucket
 * its own copy under `out-$opId`, but it does that on a coroutine, and the Send handler clears
 * the draft on the tap thread immediately after launching it. So a delete here does not follow
 * the re-bucket, it races it, and the send loses: it opened a file that had existed a millisecond
 * earlier, got ENOENT, and dropped the attachment through a `mapNotNull` that raises nothing.
 * Every attachment sent from this composer was lost that way, with no error anywhere.
 *
 * Once the send has stored its own copy the draft's bucket is unreferenced, and the cold-start
 * `sweepOrphanAttachments` reclaims it. Discarding a single pick before sending stays immediate,
 * through [removeDraftFile], which races nothing.
 */
fun ChatRepository.clearDraft(team: String) {
	if (_state.value.drafts[team] == null) return
	val next = _state.updateAndGet { s -> s.copy(drafts = s.drafts - team) }.drafts
	persistence.persistDrafts(next)
}
