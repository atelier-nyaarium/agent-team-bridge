package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import kotlinx.serialization.Serializable

/** One journaled write still in flight, oldest first. No per-gateway lanes: the Router is one board. */
@Serializable
data class PendingWrite(
	val opId: String,
	val intents: List<BoardIntent>,
	/** Failed sends so far. Only changes what a row says, never whether the write survives. */
	val attempts: Int = 0,
)

/**
 * The board as the owner should see it: the Router's entries with everything still in flight applied
 * on top, in the order it was queued.
 *
 * An intent for an entry the Router does not have is dropped rather than synthesized, except a
 * Create, which is the one that legitimately precedes its entry.
 */
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
