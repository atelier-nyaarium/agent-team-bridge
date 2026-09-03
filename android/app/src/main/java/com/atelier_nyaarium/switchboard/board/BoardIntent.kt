package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardOp
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.BoardStateAttachment
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Owner request, materialized against current state. */
@Serializable
sealed interface BoardIntent {
	val id: String

	@Serializable
	data class Create(
		override val id: String,
		val title: String,
		val body: String? = null,
		val state: String,
		val parent: String? = null,
		val rank: String,
		val session: BoardSession? = null,
	) : BoardIntent

	@Serializable data class SetTitle(override val id: String, val title: String) : BoardIntent

	@Serializable data class SetBody(override val id: String, val body: String? = null) : BoardIntent

	@Serializable data class SetState(override val id: String, val state: String) : BoardIntent

	@Serializable data class SetParent(override val id: String, val parent: String? = null, val rank: String) : BoardIntent

	@Serializable data class SetRank(override val id: String, val rank: String) : BoardIntent

	@Serializable data class SetSession(override val id: String, val session: BoardSession? = null) : BoardIntent

	@Serializable data class SetAttachments(override val id: String, val attachments: List<BoardStateAttachment>) : BoardIntent

	@Serializable data class Trash(override val id: String) : BoardIntent

	@Serializable data class Restore(override val id: String) : BoardIntent

	@Serializable data class Remove(override val id: String) : BoardIntent
}

/** Null means stale or unsealable. */
fun materialize(intent: BoardIntent, stored: Map<String, BoardStoredEntry>, sealing: BoardSealing): BoardOp? =
	when (intent) {
		is BoardIntent.Create -> {
			val title = sealing.seal(intent.title, BOARD_KIND_TITLE, intent.id)
			val body = intent.body?.let { sealing.seal(it, BOARD_KIND_BODY, intent.id) }
			title?.let {
				BoardOp.Upsert(
					id = intent.id,
					state = intent.state,
					parent = intent.parent,
					rank = intent.rank,
					session = intent.session,
					title = it,
					body = body,
				)
			}
		}
		// Preserve the untouched envelope.
		is BoardIntent.SetTitle -> stored[intent.id]?.let { entry ->
			sealing.seal(intent.title, BOARD_KIND_TITLE, intent.id)?.let {
				entry.upsert(title = it, body = entry.sealed.body)
			}
		}
		is BoardIntent.SetBody -> stored[intent.id]?.let { entry ->
			val body = intent.body?.let { sealing.seal(it, BOARD_KIND_BODY, intent.id) ?: return null }
			entry.upsert(title = entry.sealed.title, body = body)
		}
		is BoardIntent.SetState -> BoardOp.SetState(intent.id, intent.state)
		is BoardIntent.SetParent -> BoardOp.SetParent(intent.id, intent.parent, intent.rank)
		is BoardIntent.SetRank -> BoardOp.SetRank(intent.id, intent.rank)
		is BoardIntent.SetSession -> BoardOp.SetSession(intent.id, intent.session)
		is BoardIntent.SetAttachments -> BoardOp.SetAttachments(intent.id, intent.attachments)
		is BoardIntent.Trash -> BoardOp.Trash(intent.id)
		is BoardIntent.Restore -> BoardOp.Restore(intent.id)
		is BoardIntent.Remove -> BoardOp.Remove(intent.id)
	}

/** Replay identity pair. */
fun BoardOp.id(): String = when (this) {
	is BoardOp.Upsert -> id
	is BoardOp.Remove -> id
	is BoardOp.SetState -> id
	is BoardOp.SetParent -> id
	is BoardOp.SetRank -> id
	is BoardOp.SetAttachments -> id
	is BoardOp.SetSession -> id
	is BoardOp.Trash -> id
	is BoardOp.Restore -> id
}

fun BoardOp.kind(): String = when (this) {
	is BoardOp.Upsert -> "upsert"
	is BoardOp.Remove -> "remove"
	is BoardOp.SetState -> "set_state"
	is BoardOp.SetParent -> "set_parent"
	is BoardOp.SetRank -> "set_rank"
	is BoardOp.SetAttachments -> "set_attachments"
	is BoardOp.SetSession -> "set_session"
	is BoardOp.Trash -> "trash"
	is BoardOp.Restore -> "restore"
}

private fun BoardStoredEntry.upsert(title: ContentEnvelope, body: ContentEnvelope?) =
	BoardOp.Upsert(
		id = clear.id,
		state = clear.state,
		parent = clear.parent,
		rank = clear.rank,
		session = clear.session,
		trashedAt = clear.trashedAt,
		attachments = clear.attachments,
		names = clear.attachments?.let { attachments ->
			sealed.names?.let { names -> JsonObject(names.filterKeys { key -> attachments.any { it.blobId == key } }) }
		},
		title = title,
		body = body,
	)
