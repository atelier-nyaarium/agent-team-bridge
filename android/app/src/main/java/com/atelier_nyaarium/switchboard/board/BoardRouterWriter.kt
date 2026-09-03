package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardReadResult
import com.atelier_nyaarium.switchboard.proto.BoardWrite
import com.atelier_nyaarium.switchboard.proto.BoardWriteResult
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

sealed interface BoardWriteOutcome {
	data object Applied : BoardWriteOutcome

	data class Refused(val reason: String) : BoardWriteOutcome

	/** All CAS attempts lost. */
	data object Exhausted : BoardWriteOutcome

	data class Unreachable(val cause: Throwable) : BoardWriteOutcome

	data object Empty : BoardWriteOutcome
}

private const val CAS_ATTEMPTS = 4

class BoardRouterWriter(
	private val board: BoardManager,
	private val signAndPost: suspend (JsonObject, String) -> JsonElement,
	private val decode: (JsonElement) -> BoardWriteResult,
) {
	// Serialize drains to avoid duplicate opIds.
	private val drainMutex = Mutex()

	suspend fun write(intents: List<BoardIntent>, opId: String, sealing: BoardSealing): BoardWriteOutcome {
		var signature: List<Pair<String, String>>? = null
		repeat(CAS_ATTEMPTS) {
			// Rebuild retries from the winning board.
			val snapshot = board.snapshot()
			val stored = snapshot.stored.associateBy { it.clear.id }
			val ops = intents.mapNotNull { materialize(it, stored, sealing) }
			if (ops.isEmpty()) return BoardWriteOutcome.Empty
			// Keep op contents stable for replay deduplication.
			val current = ops.map { it.kind() to it.id() }
			if (signature == null) signature = current else if (signature != current) return BoardWriteOutcome.Exhausted
			val write = BoardWrite(ops = ops, expectedRevision = snapshot.routerRevision)
			val result = runCatching { decode(signAndPost(body(write), opId)) }
				.getOrElse { return BoardWriteOutcome.Unreachable(it) }
			when (result.outcome) {
				"applied" -> {
					board.settleWrite(opId, result.revision, result.entries)
					return BoardWriteOutcome.Applied
				}
				"refused" -> {
					val reason = result.refusal ?: "refused"
					board.settleWrite(opId, result.revision, result.entries)
					board.noticeRefusal(intents.singleOrNull()?.id, reason)
					return BoardWriteOutcome.Refused(reason)
				}
				else -> board.applyRouterBoard(result.revision, result.entries)
			}
		}
		return BoardWriteOutcome.Exhausted
	}

	/** Strict ordering preserves multi-write moves. */
	suspend fun drain(sealing: BoardSealing): Int = drainMutex.withLock { drainQueue(sealing) }

	private suspend fun drainQueue(sealing: BoardSealing): Int {
		var settled = 0
		for (queued in board.pendingWrites()) {
			when (write(queued.intents, queued.opId, sealing)) {
				is BoardWriteOutcome.Applied, is BoardWriteOutcome.Refused -> settled++
				is BoardWriteOutcome.Empty -> {
					board.retireWrite(queued.opId)
					settled++
				}
				is BoardWriteOutcome.Exhausted, is BoardWriteOutcome.Unreachable -> {
					board.failWrite(queued.opId)
					return settled
				}
			}
		}
		return settled
	}

	/** Router revision seeds the next CAS. */
	suspend fun read(opId: String, decodeRead: (JsonElement) -> BoardReadResult): Boolean {
		val result = runCatching { decodeRead(signAndPost(buildJsonObject { put("kind", JsonPrimitive("board_read")) }, opId)) }
			.getOrNull() ?: return false
		return board.applyRouterBoard(result.revision, result.entries)
	}

	private fun body(write: BoardWrite): JsonObject = buildJsonObject {
		put("kind", JsonPrimitive("board_write"))
		put("write", wireJson.encodeToJsonElement(BoardWrite.serializer(), write))
	}
}
