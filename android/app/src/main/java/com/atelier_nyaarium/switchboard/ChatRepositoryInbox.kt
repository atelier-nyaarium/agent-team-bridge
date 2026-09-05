package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.openSealedBlobRange
import com.atelier_nyaarium.switchboard.crypto.opResultAadKind
import com.atelier_nyaarium.switchboard.crypto.scheduledBodyAadKind
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

// Owner-inbox rows and the Router blob read.

internal suspend fun ChatRepository.reportConsumerCapabilities() {
	val plugins = enabledPlugins?.invoke() ?: return
	val op = buildJsonObject {
		put("kind", Protocol.Wire.OWNER_OP_CAPABILITIES_REPORT)
		put("clientVersion", "${BuildConfig.VERSION_NAME}+${BuildConfig.BUILD_SHA}")
		put("capabilities", wireJson.encodeToJsonElement(kotlinx.serialization.builtins.ListSerializer(com.atelier_nyaarium.switchboard.proto.EnabledPlugin.serializer()), plugins))
	}
	val signed = ownerOps.sign(op) ?: return
	client().postOwnerOp(signed)
}

internal suspend fun ChatRepository.applyPlane(name: String, payload: JsonElement?): Boolean {
	// Board pushes carry revisions only.
	if (name == "taskBoard") {
		boardOps.refreshBoard()
		return true
	}
	if (name != "presence" || payload == null) return false
	val projection = runCatching {
		wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection.serializer(), payload)
	}.getOrNull() ?: return false
	presence.applyOwnerProjection(projection)
	return true
}

private suspend fun ChatRepository.dispatchKeyRows(rows: List<com.atelier_nyaarium.switchboard.proto.InboxRow>) {
	for (row in rows) {
		when (row.envelope.kind) {
			Protocol.Wire.KeyOpKind.KEY_REQUEST -> runCatching {
				keyDelivery.onKeyRequest(wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.KeyRequest.serializer(), row.body))
			}.onFailure { DebugLog.log("KeyDelivery", "row parse failed kind=${Protocol.Wire.KeyOpKind.KEY_REQUEST}") }
			Protocol.Wire.KeyOpKind.KEY_GRANT -> runCatching {
				keyDelivery.onKeyGrant(wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.KeyGrant.serializer(), row.body))
			}.onFailure { DebugLog.log("KeyDelivery", "row parse failed kind=${Protocol.Wire.KeyOpKind.KEY_GRANT}") }
		}
	}
}

private fun unavailableEntry(row: com.atelier_nyaarium.switchboard.proto.InboxRow): MailboxEntry =
	MailboxEntry(
		seq = row.seq,
		at = row.acceptedAt,
		kind = row.envelope.kind,
		session_id = row.envelope.opKey.conversationId,
		body = "Unavailable on this device",
		status = "error",
		title = "Unavailable",
	)

internal suspend fun ChatRepository.dispatchInboxRows(rows: List<com.atelier_nyaarium.switchboard.proto.InboxRow>) {
	val entries = mutableListOf<MailboxEntry>()
	for (row in rows) {
		val epochText = (row.envelope.epoch as? JsonPrimitive)?.content
		if (epochText == "clear" && row.envelope.kind in setOf("scheduled_result", "board_observation")) {
			when (row.envelope.kind) {
				"scheduled_result" -> runCatching {
					wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.ScheduledResultRow.serializer(), row.body)
				}.onSuccess(onScheduledResult).onFailure {
					DebugLog.log("Inbox", "scheduled result parse failed seq=${row.seq}")
					entries += unavailableEntry(row)
				}
				"board_observation" -> runCatching {
					wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.BoardObservationRow.serializer(), row.body)
				}.onSuccess(onBoardObservation).onFailure {
					DebugLog.log("Inbox", "board observation parse failed seq=${row.seq}")
					entries += unavailableEntry(row)
				}
			}
			continue
		}
		if (row.envelope.kind == Protocol.Wire.OWNER_OP_OP_RESULT) {
			val result = runCatching {
				val body = wireJson.decodeFromJsonElement(
					ContentEnvelope.serializer(),
					row.body,
				)
				val epoch = body.epoch.toInt()
				val key = federation.contentKeyring().keyFor(epoch) ?: return@runCatching null
				val plain = com.atelier_nyaarium.switchboard.crypto.Crypto.openContent(
					body,
					key,
					com.atelier_nyaarium.switchboard.crypto.Crypto.ContentAad(
						localDomain(),
						federation.ownerSignPub(),
						epoch,
						opResultAadKind(row.envelope.opKey.conversationId, row.envelope.opKey.opId),
					),
				)
				wireJson.parseToJsonElement(plain.toString(Charsets.UTF_8))
			}.onFailure { DebugLog.log("Inbox", "op_result open failed opId=${row.envelope.opKey.opId}") }.getOrNull()
			val completed = transportCoordinator.completeOpResult(row.envelope.opKey.opId, result)
			// An unopened result, an absent waiter, or a refusal each strand the caller.
			val failure = (result as? JsonObject)?.takeIf { it["ok"]?.toString() == "false" }
			if (result == null || !completed || failure != null) {
				DebugLog.log(
					"Inbox",
					"op_result opId=${row.envelope.opKey.opId} opened=${result != null} waiter=$completed error=${failure?.get("error")?.toString()?.take(120)}",
				)
			}
			continue
		}
		if (row.envelope.kind == Protocol.Wire.KeyOpKind.KEY_REQUEST || row.envelope.kind == Protocol.Wire.KeyOpKind.KEY_GRANT) {
			dispatchKeyRows(listOf(row))
			continue
		}
		val entry = runCatching {
			val envelope = wireJson.decodeFromJsonElement(ContentEnvelope.serializer(), row.body)
			val epoch = envelope.epoch.toInt()
			val key = federation.contentKeyring().keyFor(epoch) ?: run {
				keyDelivery.requestMissing(epoch)
				return@runCatching unavailableEntry(row)
			}
			val plain = com.atelier_nyaarium.switchboard.crypto.Crypto.openContent(
				envelope,
				key,
				com.atelier_nyaarium.switchboard.crypto.Crypto.ContentAad(
					localDomain(),
					federation.ownerSignPub(),
					epoch,
					scheduledBodyAadKind(
						row.envelope.opKey.conversationId,
						row.envelope.opKey.opId,
					),
				),
			)
			wireJson.decodeFromString(MailboxEntry.serializer(), plain.toString(Charsets.UTF_8)).copy(seq = row.seq, kind = row.envelope.kind)
		}.onFailure {
			DebugLog.log("Inbox", "row open failed seq=${row.seq}")
			(row.envelope.epoch as? JsonPrimitive)?.content?.toIntOrNull()?.let { keyDelivery.requestMissing(it) }
			entries += unavailableEntry(row)
		}.getOrNull()
		entry?.let { entries += it }
	}
	val last = rows.maxByOrNull { it.seq } ?: return
	drain.processEntries(entries, last.seq, transportCoordinator.cursorEpoch(), 0L)
}

/** Read one opened Router blob chunk. */
internal suspend fun ChatRepository.routerBlobRange(
	domainId: String,
	blobId: String,
	offset: Long,
	originGateway: String? = null,
): Pair<ByteArray, Boolean>? {
	val op = buildJsonObject {
		put("kind", JsonPrimitive(Protocol.Wire.OWNER_OP_BLOB_FETCH))
		put("opId", JsonPrimitive(java.util.UUID.randomUUID().toString()))
		put("blobId", JsonPrimitive(blobId))
		put(
			"range",
			buildJsonObject {
				put("offset", JsonPrimitive(offset))
				put("length", JsonPrimitive(Protocol.BLOB_CHUNK_BYTES))
			},
		)
		// Permit forwarding on cache miss.
		if (originGateway != null) {
			put(
				"origin",
				buildJsonObject {
					put("domainId", JsonPrimitive(domainId))
					put("gatewayId", JsonPrimitive(originGateway))
				},
			)
		}
	}
	val signed = ownerOps.sign(op) ?: return null
	val answer = runCatching { client().postOwnerOp(signed)?.jsonObject }.getOrNull() ?: return null
	if (answer["outcome"]?.jsonPrimitive?.content != "fetched") return null
	val bytes = answer["bytes"]?.jsonPrimitive?.content
		?.let { android.util.Base64.decode(it, android.util.Base64.DEFAULT) } ?: return null
	val eof = answer["eof"]?.jsonPrimitive?.content == "true"
	if (answer["sealed"]?.jsonPrimitive?.content != "true") return bytes to eof
	val epoch = answer["epoch"]?.jsonPrimitive?.content?.toIntOrNull() ?: return null
	val size = answer["size"]?.jsonPrimitive?.content?.toLongOrNull() ?: return null
	val at = answer["offset"]?.jsonPrimitive?.content?.toLongOrNull() ?: return null
	val key = federation.contentKeyring().keyFor(epoch) ?: return null
	return runCatching {
		openSealedBlobRange(
			bytes,
			at,
			size,
			epoch,
			offset,
			Protocol.BLOB_CHUNK_BYTES.toLong(),
			key,
			domainId,
			federation.ownerSignPub(),
			blobId,
		)
	}.getOrNull()
}
