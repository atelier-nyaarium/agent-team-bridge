package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.board.BoardWriter
import com.atelier_nyaarium.switchboard.proto.ChannelFile
import com.atelier_nyaarium.switchboard.proto.ConsoleBoardReadResult
import com.atelier_nyaarium.switchboard.proto.ConsoleBoardWriteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsolePollResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRegisterResult
import com.atelier_nyaarium.switchboard.proto.ConsoleSendResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceKnownVersion
import com.atelier_nyaarium.switchboard.proto.EnabledPlugin
import com.atelier_nyaarium.switchboard.proto.FocusIntent
import com.atelier_nyaarium.switchboard.proto.LinkedPeersVersion
import com.atelier_nyaarium.switchboard.proto.PresenceVersion
import com.atelier_nyaarium.switchboard.proto.ReadAnchorsVersion
import com.atelier_nyaarium.switchboard.proto.TaskBoardVersion
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import java.util.UUID
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Console bridge client. */
class ConsoleClient(prov: Provisioning, store: AppStateStore) : BoardWriter {
	/** Seal and relay transport. */
	internal val transport = ConsoleRelayTransport(prov, store)

	/** Content-addressed blob staging. */
	internal val blobs = BlobStore(BlobStore.root(store.filesDir))
	internal suspend fun postOwnerOp(ownerOp: OwnerOp) = transport.postOwnerOp(ownerOp)

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
		val target = if (crossDomain != null) local else transport.gatewayOfTarget(to, local)
		val replyBody = transport.relay(op, opId, targetGateway = target)
		val status = replyBody.result?.let {
			runCatching { wireJson.decodeFromJsonElement<ConsoleSendResult>(it).status }.getOrNull()
		}
		return SendResult(ok = replyBody.ok, status = status.orEmpty(), error = replyBody.error)
	}

	/** Poll the mailbox and state planes. */
	suspend fun poll(
		cursor: Long,
		epoch: Long,
		holdMs: Long = 0,
		knownPresenceVersions: List<PresenceVersion>? = null,
		focus: FocusIntent? = null,
		knownLinkedPeersVersion: LinkedPeersVersion? = null,
		knownReadAnchorsVersion: ReadAnchorsVersion? = null,
		knownCrossDomainPresenceVersions: List<CrossDomainPresenceKnownVersion>? = null,
		knownTaskBoardVersion: TaskBoardVersion? = null,
	): ConsolePollResult {
		// Request changed keyring state only.
		val knownVersion = transport.store.loadDomainVersion().ifEmpty { null }
		val op = ConsoleOp.Poll(
			cursor = cursor,
			epoch = epoch,
			holdMs = if (holdMs > 0) holdMs else null,
			knownDomainVersion = knownVersion,
			knownPresenceVersions = knownPresenceVersions,
			focus = focus,
			knownLinkedPeersVersion = knownLinkedPeersVersion,
			knownReadAnchorsVersion = knownReadAnchorsVersion,
			knownCrossDomainPresenceVersions = knownCrossDomainPresenceVersions,
			knownTaskBoardVersion = knownTaskBoardVersion,
		)
		// Keep held-poll timeouts ordered.
		val heldReadTimeoutMs = if (holdMs > 0) holdMs + ConsoleHttp.HELD_READ_MARGIN_MS else null
		val body = transport.relay(
			op,
			readTimeoutMs = heldReadTimeoutMs,
			// Derive call timeout from read timeout.
			callTimeoutMs = heldReadTimeoutMs?.let { it + ConsoleHttp.CALL_TIMEOUT_MARGIN_MS + ConsoleHttp.PINNED_CONNECT_TIMEOUT_MS },
		)
		// Surface relay failures.
		if (!body.ok || body.result == null) error("poll relay failed: ${body.error ?: "no result"}")
		return wireJson.decodeFromJsonElement<ConsolePollResult>(body.result)
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
