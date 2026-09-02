package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardOp
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.BoardStateAttachment
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import kotlinx.serialization.Serializable

/**
 * What the owner asked for, held as intent rather than as a built op.
 *
 * There is no set_title or set_body op: text changes are full upserts carrying every other field.
 * So an op built against one revision would, on a lost CAS race, replay stale neighbours over the
 * board that won. Intent is re-materialized against whatever the Router now holds instead.
 */
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

/**
 * Builds the op for [intent] against the board as it now stands.
 *
 * Null means the intent no longer applies: an edit to an entry the board no longer has, or text this
 * device cannot seal because it holds no epoch. Both are dropped rather than sent, since an upsert
 * would otherwise recreate a deleted entry.
 */
fun materialize(intent: BoardIntent, stored: Map<String, BoardStoredEntry>, sealing: BoardSealing): BoardOp? =
	when (intent) {
		is BoardIntent.Create -> {
			val title = sealing.seal(intent.title, BOARD_KIND_TITLE)
			val body = intent.body?.let { sealing.seal(it, BOARD_KIND_BODY) }
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
		// The untouched half rides across as its existing envelope, so editing a title neither reads
		// nor re-seals the body.
		is BoardIntent.SetTitle -> stored[intent.id]?.let { entry ->
			sealing.seal(intent.title, BOARD_KIND_TITLE)?.let { entry.upsert(title = it, body = entry.sealed.body) }
		}
		is BoardIntent.SetBody -> stored[intent.id]?.let { entry ->
			val body = intent.body?.let { sealing.seal(it, BOARD_KIND_BODY) ?: return null }
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

/** The pair the Router's replay record hashes, so a retry can check its op set is unchanged. */
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
		title = title,
		body = body,
	)
