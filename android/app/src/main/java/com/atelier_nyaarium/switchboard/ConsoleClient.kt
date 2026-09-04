package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ChannelFile
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleSendResult
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.InboxRow
import com.atelier_nyaarium.switchboard.proto.OpKey
import com.atelier_nyaarium.switchboard.proto.RowEnvelope
import com.atelier_nyaarium.switchboard.proto.RowOrigin
import com.atelier_nyaarium.switchboard.proto.GatewayValueOp
import com.atelier_nyaarium.switchboard.proto.parseTarget
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.canonicalJson
import com.atelier_nyaarium.switchboard.crypto.opPayloadAadKind
import com.atelier_nyaarium.switchboard.crypto.valueResultAadKind
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.Serializable
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.coroutines.withTimeoutOrNull

@Serializable
internal data class OwnerOpAnswer(val ok: Boolean, val result: JsonElement? = null, val error: String? = null)

internal class ConsoleClientCollaborators(
	val signOwnerOp: (JsonObject, String) -> OwnerOp?,
	val homeGatewayId: () -> String?,
	val saveProvisioning: (String) -> Unit,
	val postOwnerOpSender: (suspend (OwnerOp) -> JsonElement?)? = null,
	val rowSigner: ((RowEnvelope) -> String?)? = null,
)

/** Signed OwnerOp client for the Router console surface. */
class ConsoleClient internal constructor(
	private val boot: PhoneBootstrap,
	internal val ambient: PhoneAmbient,
	store: AppStateStore,
	private val coordinator: ConsoleTransportCoordinator? = null,
	private val collaborators: ConsoleClientCollaborators,
) {
	internal val transport = ConsoleRouterTransport(boot.provisioning, store, collaborators.homeGatewayId, collaborators.saveProvisioning)

	/** Content-addressed blob staging. */
	internal val blobs = BlobStore(BlobStore.root(store.filesDir))
	internal suspend fun postOwnerOp(ownerOp: OwnerOp): JsonElement? =
		if (collaborators.postOwnerOpSender != null) collaborators.postOwnerOpSender.invoke(ownerOp) else transport.postOwnerOp(ownerOp)

	private fun contentKey(epoch: Int): ByteArray? = boot.contentKeyring.keyFor(epoch)

	private fun sealOwnerPayload(plaintext: ByteArray, kind: String): Pair<Int, ContentEnvelope>? {
		val domain = boot.domainId
		val epoch = boot.contentKeyring.epochs().maxOrNull() ?: return null
		val key = contentKey(epoch) ?: return null
		val signer = boot.ownerSignPub
		val aad = Crypto.ContentAad(domain, signer, epoch, kind)
		val sealed = Crypto.sealContent(plaintext, key, aad, ambient.newNonceBytes())
		return epoch to sealed
	}

	private fun signRow(envelope: RowEnvelope): String? {
		collaborators.rowSigner?.invoke(envelope)?.let { return it }
		return Crypto.sign(
			"${Protocol.Wire.SIGNING_TAG_INBOX_ROW}\n${canonicalJson(wireJson.encodeToJsonElement(RowEnvelope.serializer(), envelope))}".toByteArray(),
			boot.consoleIdentity.sign.priv,
		)
	}

	internal suspend fun postSigned(op: JsonObject, opId: String = ambient.newOpId()): JsonElement? {
		val signed = collaborators.signOwnerOp(op, opId)
		// Signing needs a confirmed Domain; without one every op dies here unremarked.
		if (signed == null) {
			DebugLog.log("OwnerOp", "${op["kind"]?.jsonPrimitive?.content} unsigned")
			return null
		}
		return postOwnerOp(signed)
	}

	internal suspend fun consumerRegister(incarnation: Long, opId: String = ambient.newOpId()): JsonElement? = postSigned(buildJsonObject {
		put("kind", Protocol.Wire.OWNER_OP_CONSUMER_REGISTER)
		put("incarnation", incarnation)
	}, opId)

	internal suspend fun inboxRead(fromSeq: Long, cursorEpoch: Long, limit: Int = 100, opId: String = ambient.newOpId()): JsonElement? = postSigned(buildJsonObject {
		put("kind", Protocol.Wire.OWNER_OP_INBOX_READ)
		put("fromSeq", fromSeq)
		put("cursorEpoch", cursorEpoch)
		put("limit", limit)
	}, opId)

	internal suspend fun inboxAdvance(cursor: Long, cursorEpoch: Long, opId: String = ambient.newOpId()): JsonElement? = postSigned(buildJsonObject {
		put("kind", Protocol.Wire.OWNER_OP_INBOX_ADVANCE)
		put("cursor", cursor)
		put("cursorEpoch", cursorEpoch)
	}, opId)

	internal suspend fun planesRead(known: JsonObject, opId: String = ambient.newOpId()): com.atelier_nyaarium.switchboard.proto.PlanesReadResult? {
		val answer = postSigned(buildJsonObject {
			put("kind", Protocol.Wire.OWNER_OP_PLANES_READ)
			put("known", known)
		}, opId) ?: return null
		val result = answer.jsonObject["result"] ?: return null
		return runCatching {
			wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.PlanesReadResult.serializer(), result)
		}.onFailure { DebugLog.log("Console", "planes_read decode failed") }.getOrNull()
	}

	internal suspend fun sendDeliveryOp(
		target: String,
		op: ConsoleOp,
		opId: String = ambient.newOpId(),
		timeoutMs: Long = ConsoleHttp.DEFAULT_OWNER_OP_TIMEOUT_MS,
	): JsonElement? {
		val conversationId = transport.prov.conversationId
		val sealed = sealOwnerPayload(
			wireJson.encodeToString(ConsoleOp.serializer(), op).toByteArray(Charsets.UTF_8),
			opPayloadAadKind(),
		) ?: return null
		val (epoch, body) = sealed
		val domain = boot.domainId
		val envelope = RowEnvelope(
			origin = RowOrigin("console", domain, device = transport.prov.device),
			opKey = OpKey(conversationId, opId),
			epoch = kotlinx.serialization.json.JsonPrimitive(epoch),
			kind = "console_op",
			contentRefs = emptyList(),
		)
    val row = InboxRow(
        envelope,
        signRow(envelope) ?: return null,
        wireJson.encodeToJsonElement(ContentEnvelope.serializer(), body),
        0L,
        0L,
        0L,
    )
		val ownerOp = collaborators.signOwnerOp(buildJsonObject {
			put("kind", Protocol.Wire.OWNER_OP_DELIVER)
			put("address", target)
			put("row", wireJson.encodeToJsonElement(InboxRow.serializer(), row))
		}, opId) ?: return null
		return if (coordinator == null) {
			val posted = postOwnerOp(ownerOp) ?: return transportFailureAnswer()
			if (posted.jsonObject["outcome"]?.jsonPrimitive?.content?.let { it != "accepted" } == true) {
				failureAnswer(posted)
			} else posted
		} else kotlinx.coroutines.coroutineScope {
			val waiter = coordinator.prepareOpResult(opId)
			try {
				val posted = postOwnerOp(ownerOp)
				when {
					posted == null -> {
						transportFailureAnswer()
					}
					posted.jsonObject["outcome"]?.jsonPrimitive?.content?.let { it != "accepted" } == true -> {
						failureAnswer(posted)
					}
					else -> withTimeoutOrNull(timeoutMs) { waiter.await() }
				}
			} finally {
				coordinator.discardOpResult(opId)
			}
		}
	}

	private fun failureAnswer(answer: JsonElement): JsonElement = wireJson.encodeToJsonElement(
		OwnerOpAnswer.serializer(),
		OwnerOpAnswer(ok = false, error = answer.jsonObject["reason"]?.jsonPrimitive?.content ?: "owner operation refused"),
	)

	private fun transportFailureAnswer(): JsonElement = wireJson.encodeToJsonElement(
		OwnerOpAnswer.serializer(),
		OwnerOpAnswer(ok = false, error = "transport"),
	)

	internal inline fun <reified T> deliveryResult(answer: JsonElement?, op: String): T {
		if (answer == null) error("$op timed out")
		return transport.resultOf(wireJson.decodeFromJsonElement<OwnerOpAnswer>(answer), op)
	}

	internal fun requireDelivery(answer: JsonElement?, op: String) {
		if (answer == null) error("$op timed out")
		val body = wireJson.decodeFromJsonElement<OwnerOpAnswer>(answer)
		if (!body.ok) error("$op failed: ${body.error ?: "unknown error"}")
	}

	internal fun defaultGatewayId(): String = collaborators.homeGatewayId()?.takeIf { it.isNotEmpty() }
		?: error("No home Gateway admitted yet")

	internal fun sessionAddressOf(target: String): String {
		val parsed = parseTarget(target, "", defaultGatewayId()) as? com.atelier_nyaarium.switchboard.proto.Address
			?: error("\"$target\" names a spawn-point, not a session")
		return "session:${parsed.domain}/${parsed.gateway}/${parsed.spawn}.${parsed.session}"
	}

	internal inline fun <reified T> valueResult(answer: JsonElement?, op: String): T {
		if (answer == null) error("$op timed out")
		return transport.resultOf(wireJson.decodeFromJsonElement<OwnerOpAnswer>(answer), op)
	}

internal suspend fun sendValueOp(gatewayId: String, op: ConsoleOp, opId: String = ambient.newOpId()): JsonElement? {
		if (gatewayId.isBlank()) return null
		val sealed = sealOwnerPayload(
			wireJson.encodeToString(ConsoleOp.serializer(), op).toByteArray(Charsets.UTF_8),
			opPayloadAadKind(),
		) ?: return null
		val value = GatewayValueOp(gatewayId = gatewayId, value = sealed.second)
		val ownerOp = collaborators.signOwnerOp(
			buildJsonObject {
				put("kind", Protocol.Wire.OWNER_OP_GATEWAY_VALUE)
				put("gatewayId", gatewayId)
				put("value", wireJson.encodeToJsonElement(ContentEnvelope.serializer(), value.value))
			},
			opId,
		) ?: return null
		val ownerAnswer = postOwnerOp(ownerOp)
		if (ownerAnswer?.jsonObject?.get("outcome")?.jsonPrimitive?.content?.let { it != "accepted" } == true) {
			return failureAnswer(ownerAnswer)
		}
		val answer = ownerAnswer?.jsonObject?.get("result")
			?: run {
				DebugLog.log("Console", "value result missing opId=$opId")
				return null
			}
		// A refused value op answers in the clear; only an accepted one is sealed.
		if ((answer as? JsonObject)?.get("kind")?.jsonPrimitive?.content == "refusal") {
			DebugLog.log("Console", "value op refused opId=$opId")
			return failureAnswer(answer)
		}
			val envelope = runCatching { wireJson.decodeFromJsonElement(ContentEnvelope.serializer(), answer) }
				.onFailure { DebugLog.log("Console", "value result envelope failed opId=$opId") }
				.getOrNull() ?: return null
		val domain = boot.domainId
		val key = contentKey(envelope.epoch.toInt()) ?: return null
		return runCatching {
			val plain = wireJson.parseToJsonElement(
				com.atelier_nyaarium.switchboard.crypto.Crypto.openContent(
					envelope,
					key,
					com.atelier_nyaarium.switchboard.crypto.Crypto.ContentAad(
						domain,
						boot.ownerSignPub,
						envelope.epoch.toInt(),
						valueResultAadKind(opId),
					),
				).toString(Charsets.UTF_8),
			)
			wireJson.encodeToJsonElement(OwnerOpAnswer.serializer(), OwnerOpAnswer(ok = true, result = plain))
		}.onFailure { DebugLog.log("Console", "value result open failed opId=$opId") }.getOrNull()
	}

	/** Connected Gateways, or unknown. */
	fun fetchConnectedGateways(): List<String>? {
		val req = buildConnectedGatewaysRequest(transport.proxyBase)
		transport.client.newCall(req).execute().use { resp ->
			if (!resp.isSuccessful) return null
			val body = resp.body?.string() ?: return null
			return runCatching {
				val arr = org.json.JSONObject(body).optJSONArray("gateways") ?: return null
				(0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.optString("gatewayId")?.takeIf(String::isNotEmpty) }
			}.getOrNull()
		}
	}

	internal fun buildConnectedGatewaysRequest(base: String): Request = Request.Builder()
		.url(base + Protocol.Wire.ROUTER_PATH_CONSOLE)
		.header(Protocol.Wire.CONSOLE_TOKEN_HEADER, Protocol.Wire.BEARER_PREFIX + transport.prov.appToken)
		.post("""{"gateways":{}}""".toRequestBody(ConsoleHttp.JSON))
		.build()

	/** Send a message. */
	suspend fun send(
		to: String,
		body: String,
		files: List<OutgoingFile> = emptyList(),
		opId: String = ambient.newOpId(),
		domainId: String? = null,
	): SendResult {
		// Blob holder Gateway.
		val local = defaultGatewayId()
		val wireFiles = files.map { f ->
			ChannelFile(
				filename = f.name,
				mime = f.mime,
				size = f.size,
				descriptiveKey = f.name,
				blobId = uploadBlob(f.source),
				// Identify the blob holder.
				blobGateway = local,
				role = "attachment",
			)
		}
		// Preserve the selected session's Domain.
		val crossDomain = domainId?.ifEmpty { null }
		val op = ConsoleOp.Send(to = to, domainId = crossDomain, body = body, files = wireFiles.ifEmpty { null })
		// Cross-Domain sends seal locally.
		val answer = sendDeliveryOp(sessionAddressOf(to), op, opId)
		val replyBody = answer?.let { wireJson.decodeFromJsonElement<OwnerOpAnswer>(it) }
		val status = replyBody?.result?.let {
			runCatching { wireJson.decodeFromJsonElement<ConsoleSendResult>(it).status }.getOrNull()
		}
		return SendResult(ok = replyBody?.ok == true, status = status.orEmpty(), error = replyBody?.error ?: answer?.let { null } ?: "send timed out")
	}

}
