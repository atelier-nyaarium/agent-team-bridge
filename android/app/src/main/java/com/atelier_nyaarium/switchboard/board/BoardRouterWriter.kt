package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardReadResult
import com.atelier_nyaarium.switchboard.proto.BoardWrite
import com.atelier_nyaarium.switchboard.proto.BoardWriteResult
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** How a write ended, for the caller that has to tell the owner. */
sealed interface BoardWriteOutcome {
	data object Applied : BoardWriteOutcome

	data class Refused(val reason: String) : BoardWriteOutcome

	/** Every attempt lost its CAS race. The intents stay journaled for the next drain. */
	data object Exhausted : BoardWriteOutcome

	/** The Router could not be reached. The intents stay journaled. */
	data class Unreachable(val cause: Throwable) : BoardWriteOutcome

	/** Nothing left to send: every intent named an entry the board no longer has. */
	data object Empty : BoardWriteOutcome
}

/** Enough attempts to pass a couple of concurrent writers, few enough to give the drain back. */
private const val CAS_ATTEMPTS = 4

/**
 * Sends board intents to the Router under one opId, re-materializing on a lost CAS race.
 *
 * The retry rebuilds ops against the board that WON rather than replaying the ones it built, because
 * a text change is a full upsert and a replay would put stale neighbours back.
 */
class BoardRouterWriter(
	private val board: BoardManager,
	private val signAndPost: suspend (JsonObject, String) -> JsonElement,
	private val decode: (JsonElement) -> BoardWriteResult,
) {
	suspend fun write(intents: List<BoardIntent>, opId: String, sealing: BoardSealing): BoardWriteOutcome {
		var signature: List<Pair<String, String>>? = null
		repeat(CAS_ATTEMPTS) {
			val stored = board.storedById()
			val ops = intents.mapNotNull { materialize(it, stored, sealing) }
			if (ops.isEmpty()) return BoardWriteOutcome.Empty
			// The Router's replay record hashes which ops over which entries, so a retry that dropped
			// one because its entry vanished would be refused as a reused id. Stop instead and let the
			// next drain start over, since the opId has to stay stable for a crash replay to dedupe.
			val current = ops.map { it.kind() to it.id() }
			if (signature == null) signature = current else if (signature != current) return BoardWriteOutcome.Exhausted
			val write = BoardWrite(ops = ops, expectedRevision = board.routerRevision)
			val result = runCatching { decode(signAndPost(body(write), opId)) }
				.getOrElse { return BoardWriteOutcome.Unreachable(it) }
			// Every outcome carries the whole board, so landing it first means a retry is built against
			// the winner and a refusal leaves the rows agreeing with the Router.
			board.applyRouterBoard(result.revision, result.entries)
			when (result.outcome) {
				"applied" -> return BoardWriteOutcome.Applied
				"refused" -> return BoardWriteOutcome.Refused(result.refusal ?: "refused")
			}
		}
		return BoardWriteOutcome.Exhausted
	}

	/** Seeds or re-reads the board. The Router's revision is authoritative for the next write's CAS. */
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
