package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import kotlinx.serialization.Serializable

/** One in-flight write, oldest first. */
@Serializable
data class PendingWrite(
	val opId: String,
	val intents: List<BoardIntent>,
	/** Failed sends so far. */
	val attempts: Int = 0,
)

/** Applies queued intents in order. Missing entries are ignored except creates. */
fun applyPending(entries: List<BoardEntry>, pending: List<PendingWrite>): List<BoardEntry> {
	val byId = entries.associateByTo(LinkedHashMap()) { it.id }
	for (write in pending) {
		for (intent in write.intents) {
			when (intent) {
				is BoardIntent.Create ->
					byId.getOrPut(intent.id) {
						BoardEntry(
							id = intent.id,
							title = intent.title,
							body = intent.body,
							state = intent.state,
							parent = intent.parent,
							rank = intent.rank,
							sessionId = intent.session?.sessionId,
							session = intent.session,
						)
					}
				is BoardIntent.SetTitle -> byId.replace(intent.id) { it.copy(title = intent.title) }
				is BoardIntent.SetBody -> byId.replace(intent.id) { it.copy(body = intent.body) }
				is BoardIntent.SetState -> byId.replace(intent.id) { it.copy(state = intent.state) }
				is BoardIntent.SetParent -> byId.replace(intent.id) { it.copy(parent = intent.parent, rank = intent.rank) }
				is BoardIntent.SetRank -> byId.replace(intent.id) { it.copy(rank = intent.rank) }
				is BoardIntent.SetSession ->
					byId.replace(intent.id) { it.copy(session = intent.session, sessionId = intent.session?.sessionId) }
				is BoardIntent.SetAttachments -> Unit
				is BoardIntent.Trash -> byId.replace(intent.id) { it.copy(trashedAt = it.trashedAt ?: 1L) }
				is BoardIntent.Restore -> byId.replace(intent.id) { it.copy(trashedAt = null) }
				is BoardIntent.Remove -> byId.remove(intent.id)
			}
		}
	}
	return byId.values.toList()
}

private inline fun LinkedHashMap<String, BoardEntry>.replace(id: String, edit: (BoardEntry) -> BoardEntry) {
	this[id]?.let { this[id] = edit(it) }
}
