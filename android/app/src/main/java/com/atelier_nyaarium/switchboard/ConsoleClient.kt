package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.board.BoardWriter
import com.atelier_nyaarium.switchboard.board.scheduledBodyAadKind
import com.atelier_nyaarium.switchboard.proto.ChannelFile
import com.atelier_nyaarium.switchboard.proto.ConsoleBoardReadResult
import com.atelier_nyaarium.switchboard.proto.ConsoleBoardWriteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleRegisterResult
import com.atelier_nyaarium.switchboard.proto.ConsoleReplyBody
import com.atelier_nyaarium.switchboard.proto.ConsoleSendResult
import com.atelier_nyaarium.switchboard.proto.EnabledPlugin
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.InboxRow
import com.atelier_nyaarium.switchboard.proto.OpKey
import com.atelier_nyaarium.switchboard.proto.RowEnvelope
import com.atelier_nyaarium.switchboard.proto.RowOrigin
import com.atelier_nyaarium.switchboard.proto.GatewayValueOp
import com.atelier_nyaarium.switchboard.proto.parseTarget
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.canonicalJson
import com.atelier_nyaarium.switchboard.board.valueResultAadKind
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

internal fun inboxBodyAadKind(conversationId: String, opId: String): String = scheduledBodyAadKind(conversationId, opId)

internal fun opResultAadKind(conversationId: String, opId: String): String =
	"op.result\n$conversationId\n$opId"

/** Console bridge client. */
class ConsoleClient internal constructor(
	prov: Provisioning,
	store: AppStateStore,
	private val coordinator: ConsoleTransportCoordinator? = null,
	private val signOwnerOp: ((kotlinx.serialization.json.JsonObject, String) -> OwnerOp?)? = null,
	private val domainId: () -> String? = { null },
	private val ownerSignPub: () -> String? = { null },
	private val homeGatewayId: (() -> String?)? = null,
	private val contentKeyring: () -> com.atelier_nyaarium.switchboard.crypto.ContentKeyring = { ContentKeyring(store = store) },
	private val postOwnerOpSender: (suspend (OwnerOp) -> JsonElement?)? = null,
	private val rowSigner: ((RowEnvelope) -> String?)? = null,
) : BoardWriter {
	/** Seal and relay transport. */
	internal val transport = ConsoleRelayTransport(prov, store)

	/** Content-addressed blob staging. */
	internal val blobs = BlobStore(BlobStore.root(store.filesDir))
	internal suspend fun postOwnerOp(ownerOp: OwnerOp): JsonElement? =
		if (postOwnerOpSender != null) postOwnerOpSender.invoke(ownerOp) else transport.postOwnerOp(ownerOp)

	private fun contentKey(epoch: Int): ByteArray? = contentKeyring().keyFor(epoch)

	private fun sealOwnerPayload(plaintext: ByteArray, kind: String): Pair<Int, ContentEnvelope>? {
		val domain = domainId() ?: return null
		val epoch = contentKeyring().epochs().maxOrNull() ?: return null
		val key = contentKey(epoch) ?: return null
		val signer = ownerSignPub() ?: return null
		return epoch to com.atelier_nyaarium.switchboard.crypto.Crypto.sealContent(
			plaintext,
			key,
			com.atelier_nyaarium.switchboard.crypto.Crypto.ContentAad(
				domain,
				signer,
				epoch,
				kind,
			),
		)
	}

	private fun signRow(envelope: RowEnvelope): String? {
		rowSigner?.invoke(envelope)?.let { return it }
		val identity = when (val loaded = transport.store.loadIdentity()) {
			is IdentityLoad.Loaded -> loaded.identity
			else -> return null
		}
		return com.atelier_nyaarium.switchboard.crypto.Crypto.sign(
			"INBOXROW_V1\n${canonicalJson(wireJson.encodeToJsonElement(RowEnvelope.serializer(), envelope))}".toByteArray(),
			identity.sign.priv,
		)
	}

	internal suspend fun postSigned(op: kotlinx.serialization.json.JsonObject, opId: String = UUID.randomUUID().toString()): JsonElement? =
		signOwnerOp?.invoke(op, opId)?.let { postOwnerOp(it) }

	internal suspend fun consumerRegister(incarnation: Long): JsonElement? = postSigned(buildJsonObject {
		put("kind", "consumer_register")
		put("incarnation", incarnation)
	})

	internal suspend fun inboxRead(fromSeq: Long, cursorEpoch: Long, limit: Int = 100): JsonElement? = postSigned(buildJsonObject {
		put("kind", "inbox_read")
		put("fromSeq", fromSeq)
		put("cursorEpoch", cursorEpoch)
		put("limit", limit)
	})

	internal suspend fun inboxAdvance(cursor: Long, cursorEpoch: Long): JsonElement? = postSigned(buildJsonObject {
		put("kind", "inbox_advance")
		put("cursor", cursor)
		put("cursorEpoch", cursorEpoch)
	})

	internal suspend fun planesRead(known: JsonObject): com.atelier_nyaarium.switchboard.proto.PlanesReadResult? {
		val answer = postSigned(buildJsonObject {
			put("kind", "planes_read")
			put("known", known)
		}) ?: return null
		val result = answer.jsonObject["result"] ?: return null
		return runCatching {
			wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.PlanesReadResult.serializer(), result)
		}.onFailure { DebugLog.log("Console", "planes_read decode failed") }.getOrNull()
	}

	internal suspend fun sendDeliveryOp(
		target: String,
		op: ConsoleOp,
		opId: String = UUID.randomUUID().toString(),
		timeoutMs: Long = ConsoleHttp.DEFAULT_RELAY_CALL_TIMEOUT_MS,
	): JsonElement? {
		val conversationId = transport.prov.conversationId
		val sealed = sealOwnerPayload(
			wireJson.encodeToString(ConsoleOp.serializer(), op).toByteArray(Charsets.UTF_8),
			"op.payload",
		) ?: return null
		val (epoch, body) = sealed
		val domain = domainId() ?: return null
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
		val ownerOp = signOwnerOp?.invoke(buildJsonObject {
			put("kind", "deliver")
			put("address", target)
			put("row", wireJson.encodeToJsonElement(InboxRow.serializer(), row))
		}, opId) ?: return null
		return if (coordinator == null) {
			val posted = postOwnerOp(ownerOp) ?: return transportFailureAnswer()
			if (posted.jsonObject["outcome"]?.jsonPrimitive?.content?.let { it != "accepted" } == true) {
				failureAnswer(posted)
			} else posted
		} else kotlinx.coroutines.coroutineScope {
			coordinator.prepareOpResult(opId)
			try {
				val waiter = async { coordinator.awaitOpResult(opId, timeoutMs) }
				val posted = postOwnerOp(ownerOp)
				when {
					posted == null -> {
						waiter.cancel()
						transportFailureAnswer()
					}
					posted.jsonObject["outcome"]?.jsonPrimitive?.content?.let { it != "accepted" } == true -> {
						waiter.cancel()
						failureAnswer(posted)
					}
					else -> waiter.await()
				}
			} finally {
				coordinator.discardOpResult(opId)
			}
		}
	}

	private fun failureAnswer(answer: JsonElement): JsonElement = wireJson.encodeToJsonElement(
		ConsoleReplyBody.serializer(),
		ConsoleReplyBody(ok = false, error = answer.jsonObject["reason"]?.jsonPrimitive?.content ?: "owner operation refused"),
	)

	private fun transportFailureAnswer(): JsonElement = wireJson.encodeToJsonElement(
		ConsoleReplyBody.serializer(),
		ConsoleReplyBody(ok = false, error = "transport"),
	)

	internal inline fun <reified T> deliveryResult(answer: JsonElement?, op: String): T {
		if (answer == null) error("$op timed out")
		return transport.resultOf(wireJson.decodeFromJsonElement<ConsoleReplyBody>(answer), op)
	}

	internal fun requireDelivery(answer: JsonElement?, op: String) {
		if (answer == null) error("$op timed out")
		val body = wireJson.decodeFromJsonElement<ConsoleReplyBody>(answer)
		if (!body.ok) error("$op failed: ${body.error ?: "unknown error"}")
	}

	internal fun defaultGatewayId(): String = (homeGatewayId?.invoke() ?: transport.routeGateway)?.takeIf { it.isNotEmpty() }
		?: error("No home Gateway admitted yet")

	internal fun sessionAddressOf(target: String): String {
		val parsed = parseTarget(target, "", defaultGatewayId()) as com.atelier_nyaarium.switchboard.proto.Address
		return "session:${parsed.domain}/${parsed.gateway}/${parsed.spawn}.${parsed.session}"
	}

	internal inline fun <reified T> valueResult(answer: JsonElement?, op: String): T {
		if (answer == null) error("$op timed out")
		return transport.resultOf(wireJson.decodeFromJsonElement<ConsoleReplyBody>(answer), op)
	}

internal suspend fun sendValueOp(gatewayId: String, op: ConsoleOp, opId: String = UUID.randomUUID().toString()): JsonElement? {
		if (gatewayId.isBlank()) return null
		val sealed = sealOwnerPayload(
			wireJson.encodeToString(ConsoleOp.serializer(), op).toByteArray(Charsets.UTF_8),
			"op.payload",
		) ?: return null
		val value = GatewayValueOp(gatewayId = gatewayId, value = sealed.second)
		val ownerOp = signOwnerOp?.invoke(
			buildJsonObject {
				put("kind", "gateway_value")
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
			val envelope = runCatching { wireJson.decodeFromJsonElement(ContentEnvelope.serializer(), answer) }
				.onFailure { DebugLog.log("Console", "value result envelope failed opId=$opId") }
				.getOrNull() ?: return null
		val domain = domainId() ?: return null
		val key = contentKey(envelope.epoch.toInt()) ?: return null
		return runCatching {
			val plain = wireJson.parseToJsonElement(
				com.atelier_nyaarium.switchboard.crypto.Crypto.openContent(
					envelope,
					key,
					com.atelier_nyaarium.switchboard.crypto.Crypto.ContentAad(
						domain,
						ownerSignPub() ?: error("identity unavailable"),
						envelope.epoch.toInt(),
						valueResultAadKind(opId),
					),
				).toString(Charsets.UTF_8),
			)
			wireJson.encodeToJsonElement(ConsoleReplyBody.serializer(), ConsoleReplyBody(ok = true, result = plain))
		}.onFailure { DebugLog.log("Console", "value result open failed opId=$opId") }.getOrNull()
	}

	/** Current route Gateway id. */
	var routeGateway: String?
		get() = transport.routeGateway
		set(value) {
			transport.routeGateway = value
		}

	/** Leaf-pinned Router preflight. */
	suspend fun apiReachable(): String {
		// Only the preflight may fail over.
		val code = transport.withReachFailover { base ->
			val req = Request.Builder()
				.url("$base/health")
				.get()
				.build()
			transport.clientFor(base).newCall(req).execute().use { resp ->
				val text = resp.body?.string().orEmpty()
				if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(300)}")
				resp.code
			}
		}
		// Refresh advertised reachability best-effort.
		transport.reached(runCatching { fetchReach() }.getOrNull())
		return "reachable (HTTP $code)"
	}

	/** Connected Gateways, or unknown. */
	fun fetchConnectedGateways(): List<String>? {
		val req = Request.Builder()
			.url("${transport.proxyBase}/console")
			.header("X-Console-Bridge-Token", "Bearer ${transport.prov.appToken}")
			.post("""{"gateways":{}}""".toRequestBody(ConsoleHttp.JSON))
			.build()
		transport.client.newCall(req).execute().use { resp ->
			if (!resp.isSuccessful) return null
			val body = resp.body?.string() ?: return null
			return runCatching {
				val arr = org.json.JSONObject(body).optJSONArray("gateways") ?: return null
				(0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.optString("gatewayId")?.takeIf(String::isNotEmpty) }
			}.getOrNull()
		}
	}

	/** Advertised Router addresses. */
	private fun fetchReach(): RouterReach? {
		val req = Request.Builder()
			.url("${transport.proxyBase}/console")
			.header("X-Console-Bridge-Token", "Bearer ${transport.prov.appToken}")
			.post("""{"reach":{}}""".toRequestBody(ConsoleHttp.JSON))
			.build()
		transport.client.newCall(req).execute().use { resp ->
			if (!resp.isSuccessful) return null
			return RouterReach.decode(resp.body?.string())
		}
	}

	/** Claim the mailbox and report capabilities. */
	suspend fun register(enabledPlugins: List<EnabledPlugin>? = null): ConsoleRegisterResult = transport.resultOf(
		transport.relay(
			ConsoleOp.Register(
				clientVersion = "${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}",
				clientVariant = if (BuildConfig.DEBUG) "debug" else "release",
				enabledPlugins = enabledPlugins,
			),
		),
		"register",
	)

	/** List canonical sessions. */
	internal suspend fun teams(localGatewayId: String = ""): TeamsAnswer {
		val body = transport.relay(ConsoleOp.ListTeams)
		// Preserve the prior list on failure.
		if (!body.ok || body.result == null) error("list_teams relay failed: ${body.error ?: "no result"}")
		val result =
			wireJson.decodeFromJsonElement<com.atelier_nyaarium.switchboard.proto.ConsoleListTeamsResult>(body.result)
		return TeamsAnswer(result.teams.map { teamInfoToTeam(it, localGatewayId) }, result.coverage, result.spawnPoints)
	}

	// Return an empty list on failure.
	suspend fun listTeams(): List<String> =
		runCatchingCancellable { teams().teams.map { it.name } }.getOrDefault(emptyList())

	/** Send a message. */
	suspend fun send(
		to: String,
		body: String,
		files: List<OutgoingFile> = emptyList(),
		opId: String = UUID.randomUUID().toString(),
		domainId: String? = null,
	): SendResult {
		// Blob holder Gateway.
		val local = routeGateway?.takeIf { it.isNotEmpty() } ?: transport.store.loadGatewayId()
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
		val replyBody = answer?.let { wireJson.decodeFromJsonElement<ConsoleReplyBody>(it) }
		val status = replyBody?.result?.let {
			runCatching { wireJson.decodeFromJsonElement<ConsoleSendResult>(it).status }.getOrNull()
		}
		return SendResult(ok = replyBody?.ok == true, status = status.orEmpty(), error = replyBody?.error ?: answer?.let { null } ?: "send timed out")
	}

	/** Read one Gateway's board half. */
	suspend fun boardRead(gatewayId: String): ConsoleBoardReadResult =
		transport.resultOf(transport.relay(ConsoleOp.BoardRead, targetGateway = gatewayId), "board_read")

	/** Write a board mutation. Refusals retire; errors retry. */
	override suspend fun boardWrite(op: ConsoleOp, gatewayId: String, opId: String): List<String> {
		val body = transport.relay(op, opId, targetGateway = gatewayId)
		// Report dropped attachments.
		if (body.ok) {
			// Do not retry an applied write.
			return runCatching { transport.resultOf<ConsoleBoardWriteResult>(body, "board_write").dropped }
				.getOrNull()
				.orEmpty()
		}
		val error = body.error ?: ""
		// Refusals use a distinct prefix.
		if (error.startsWith(BOARD_REFUSED_PREFIX)) throw BoardRefused(error.removePrefix(BOARD_REFUSED_PREFIX).trim())
		error("board write failed: ${error.ifEmpty { "unknown error" }}")
	}

	/** Check whether a Gateway has the complete blob. */
	override suspend fun boardBytesReady(blobId: String, gatewayId: String): Boolean =
		blobStat(blobId, gatewayId).complete
}
