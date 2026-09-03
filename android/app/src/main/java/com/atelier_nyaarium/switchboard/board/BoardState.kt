package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import kotlinx.serialization.Serializable

/** Distinguishes refused writes from terminal drops. */
@Serializable
data class BoardRefusal(
	val entryId: String?,
	val reason: String,
	val kind: BoardNoticeKind = BoardNoticeKind.REFUSED,
)

@Serializable
enum class BoardNoticeKind {
	REFUSED,
	DROPPED,
}

@Serializable
data class BoardBlob(
	/** Router revision used for CAS. */
	val routerRevision: Long = 0,
	/** Sealed Router entries. */
	val stored: List<BoardStoredEntry> = emptyList(),
	/** Cached text survives epoch rotation. */
	val text: Map<String, BoardCachedText> = emptyMap(),
	/** Optimistic writes, oldest first. */
	val pending: List<PendingWrite> = emptyList(),
	val lastRouterSyncAt: Long = 0,
	// Persist notices across background drains.
	val notices: List<BoardRefusal> = emptyList(),
)

val BOARD_REFUSALS = setOf(
	"entry_missing", "parent_missing", "cycle", "held", "would_orphan", "board_full", "bad_rank",
	"attachment_missing", "session_missing", "durability_failure", "operation_id_reused",
)
