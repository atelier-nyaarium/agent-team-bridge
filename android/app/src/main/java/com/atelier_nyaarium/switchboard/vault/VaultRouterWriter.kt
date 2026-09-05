package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.VaultListResult
import com.atelier_nyaarium.switchboard.proto.VaultPut
import com.atelier_nyaarium.switchboard.proto.VaultWriteResult
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** The three vault owner ops, each one signed post. */
class VaultRouterWriter(private val signAndPost: suspend (JsonObject, String) -> JsonElement) {
	suspend fun list(sinceRevision: Long?, opId: String): VaultListResult {
		val answer = signAndPost(
			buildJsonObject {
				put("kind", JsonPrimitive(Protocol.Wire.OWNER_OP_VAULT_LIST))
				if (sinceRevision != null) put("sinceRevision", sinceRevision)
			},
			opId,
		)
		return wireJson.decodeFromJsonElement(VaultListResult.serializer(), answer)
	}

	suspend fun put(put: VaultPut, opId: String): VaultWriteResult = writeResult(
		signAndPost(
			buildJsonObject {
				put("kind", JsonPrimitive(Protocol.Wire.OWNER_OP_VAULT_PUT))
				put("put", wireJson.encodeToJsonElement(VaultPut.serializer(), put))
			},
			opId,
		),
	)

	suspend fun delete(id: String, expectedRevision: Long, opId: String): VaultWriteResult = writeResult(
		signAndPost(
			buildJsonObject {
				put("kind", JsonPrimitive(Protocol.Wire.OWNER_OP_VAULT_DELETE))
				put("id", id)
				put("expectedRevision", expectedRevision)
			},
			opId,
		),
	)

	// The intake's own refusal carries no revision.
	private fun writeResult(answer: JsonElement): VaultWriteResult =
		runCatching { wireJson.decodeFromJsonElement(VaultWriteResult.serializer(), answer) }.getOrElse {
			val body = answer.jsonObject
			VaultWriteResult(
				outcome = body["outcome"]?.jsonPrimitive?.content ?: Protocol.Wire.SocketFrame.REFUSED,
				revision = 0L,
				refusal = body["reason"]?.jsonPrimitive?.content ?: "unreadable answer",
			)
		}
}
