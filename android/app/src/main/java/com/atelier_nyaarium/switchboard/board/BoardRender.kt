package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardAttachment
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardStateAttachment
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import kotlinx.serialization.Serializable

/** Cached text survives key loss. */
@Serializable
data class BoardCachedText(val title: String, val body: String? = null)

data class BoardRendered(
	val entries: List<BoardEntry>,
	val unavailable: Set<String>,
	val cache: Map<String, BoardCachedText>,
)

/** Distinguishes unreadable text from an empty title. */
const val BOARD_TEXT_UNAVAILABLE = "Unavailable on this device"

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
		// Do not resurrect deleted bodies.
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

/** Blob id stands in for the missing filename. */
private fun BoardStateAttachment.toUi() = BoardAttachment(
	blobId = blobId,
	blobGateway = blobGateway,
	filename = blobId,
	mime = mime,
	size = size,
)
