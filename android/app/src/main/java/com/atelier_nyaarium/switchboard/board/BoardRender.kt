package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardAttachment
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardStateAttachment
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import kotlinx.serialization.Serializable

/** The last text this device read for an entry, so a key it no longer holds still renders. */
@Serializable
data class BoardCachedText(val title: String, val body: String? = null)

/**
 * Rendered board plus the entries whose text this device cannot read.
 *
 * Unavailability is this device's keyring state, not board truth, so it rides beside the entries
 * rather than in the wire model every other client shares.
 */
data class BoardRendered(
	val entries: List<BoardEntry>,
	val unavailable: Set<String>,
	val cache: Map<String, BoardCachedText>,
)

/** Shown for an entry sealed at an epoch this device never held. Deliberately not blank: an empty
 * title is indistinguishable from one the owner left empty, and this state is not the owner's doing. */
const val BOARD_TEXT_UNAVAILABLE = "Unavailable on this device"

/**
 * Opens every stored entry into the UI model.
 *
 * An entry sealed at a missing epoch falls back to [cache], and only an entry never read on this
 * device lands in `unavailable`. The returned cache carries forward exactly what rendered, so a key
 * rotation does not blank a board the owner was already reading.
 */
fun renderBoard(
	stored: List<BoardStoredEntry>,
	sealing: BoardSealing,
	cache: Map<String, BoardCachedText>,
): BoardRendered {
	val entries = mutableListOf<BoardEntry>()
	val unavailable = mutableSetOf<String>()
	val nextCache = mutableMapOf<String, BoardCachedText>()
	for (entry in stored) {
		val id = entry.clear.id
		val title = sealing.open(entry.sealed.title, BOARD_KIND_TITLE, id)
		val body = entry.sealed.body?.let { sealing.open(it, BOARD_KIND_BODY, id) }
		val cached = cache[id]
		val shownTitle = title ?: cached?.title
		// A body that opens is authoritative; one that does not falls back only when its envelope is
		// present, so a deleted body is not resurrected from the cache.
		val shownBody = body ?: entry.sealed.body?.let { cached?.body }
		if (shownTitle == null) unavailable += id
		if (shownTitle != null) nextCache[id] = BoardCachedText(shownTitle, shownBody)
		entries += BoardEntry(
			id = id,
			title = shownTitle ?: BOARD_TEXT_UNAVAILABLE,
			body = shownBody,
			state = entry.clear.state,
			parent = entry.clear.parent,
			rank = entry.clear.rank,
			sessionId = entry.clear.session?.sessionId,
			session = entry.clear.session,
			trashedAt = entry.clear.trashedAt,
			attachments = entry.clear.attachments?.map { it.toUi() },
		)
	}
	return BoardRendered(entries, unavailable, nextCache)
}

/** The Router's attachment record carries no filename, so the blob id stands in until it does. */
private fun BoardStateAttachment.toUi() = BoardAttachment(
	blobId = blobId,
	blobGateway = blobGateway,
	filename = blobId,
	mime = mime,
	size = size,
)
