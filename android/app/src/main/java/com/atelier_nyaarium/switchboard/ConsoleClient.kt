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
import java.util.UUID
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.Request

/**
 * Talks to the console bridge through the CA-pinned k8s API service-proxy.
 *
 * The mailbox ops live here; every other family is an extension function in a sibling file
 * (ConsoleClientEnroll / ConsoleClientBlobs / ConsoleClientSessions / ConsoleClientCrossDomain),
 * reaching the seal/relay path through [transport].
 */
class ConsoleClient(prov: Provisioning, store: AppStateStore) : BoardWriter {
	/** The seal/relay path and the state it needs. Widened to internal because an op that lives in a
	 * sibling file is an extension, and an extension cannot reach a private member. */
	internal val transport = ConsoleRelayTransport(prov, store)

	/** This device's staging half of the blob plane. Content-addressed, so attaching a file the
	 * Gateway already holds, or re-opening one already received, moves no bytes at all. */
	internal val blobs = BlobStore(BlobStore.root(store.filesDir))

	/** This console's route Gateway id, learned at register and set by ChatRepository. Owned by the
	 * transport, which is the side that seals against it. */
	var routeGateway: String?
		get() = transport.routeGateway
		set(value) {
			transport.routeGateway = value
		}

	/**
	 * CA-pinned preflight: the console-bridge liveness probe through the API service-proxy, on the
	 * same path the real ops use, so it proves TLS pinning, reachability, and SA auth.
	 *
	 * It must NOT hit a raw cluster endpoint like `get namespace`: the console SA (console-bridge-proxy)
	 * is scoped to the service-proxy verb only, so a namespace GET 403s and strands every connect before
	 * the admission submit, leaving the console forever "not admitted". /health needs no app token, so a
	 * failure here means the cluster or tunnel is down, separate from "the bridge rejected our creds".
	 */
	fun apiReachable(): String {
		val req = Request.Builder()
			.url("${transport.proxyBase}/health")
			.header("Authorization", "Bearer ${transport.prov.saToken}")
			.get()
			.build()
		transport.client.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(300)}")
			return "reachable (HTTP ${resp.code})"
		}
	}

	/** Claim this device's mailbox, returning the starting cursor + epoch. Carries this build's identity
	 * so the gateway logs which version and variant the console runs, plus what this device can render.
	 * A null [enabledPlugins] states nothing about plugins and leaves any prior report standing, which
	 * is what a register issued before the plugin framework has booted should say. */
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

	/** Report this device's plugin list to a NON-route Gateway. A capability store is per Gateway
	 * and only the route Gateway ever hears a plain register, so without this a session homed
	 * anywhere else would never learn what this console can render - permanently, not as a rollout
	 * window. Best-effort: an offline Gateway just keeps its previous report. */
	suspend fun reportPluginsTo(gatewayId: String, enabledPlugins: List<EnabledPlugin>) {
		transport.relay(
			ConsoleOp.Register(
				clientVersion = "${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}",
				clientVariant = if (BuildConfig.DEBUG) "debug" else "release",
				enabledPlugins = enabledPlugins,
			),
			targetGateway = gatewayId,
		)
	}

	/** List the bridge's sessions, each keyed by its canonical `domain.gateway.spawn.session` address. A
	 * session's Gateway comes from the wire (`TeamInfo.gatewayId`, always stamped); an empty value falls
	 * back to `localGatewayId` (this connection's Gateway, learned at register). */
	suspend fun teams(localGatewayId: String = ""): List<Team> {
		val body = transport.relay(ConsoleOp.ListTeams)
		// Surface a relay failure instead of blanking the board; the callers (connect, refreshTeams)
		// wrap this in runCatching and keep the prior list.
		if (!body.ok || body.result == null) error("list_teams relay failed: ${body.error ?: "no result"}")
		val result =
			wireJson.decodeFromJsonElement<com.atelier_nyaarium.switchboard.proto.ConsoleListTeamsResult>(body.result)
		return result.teams.map { teamInfoToTeam(it, localGatewayId) }
	}

	// teams() throws on a relay failure; this wrapper keeps the list-returning contract (empty on failure).
	suspend fun listTeams(): List<String> =
		runCatchingCancellable { teams().map { it.name } }.getOrDefault(emptyList())

	/** Send a message to a team. The reply may arrive inline within the relay hold or land in the mailbox
	 * for a later poll; either way the conversation is keyed server-side by (this device, team). */
	suspend fun send(
		to: String,
		body: String,
		files: List<OutgoingFile> = emptyList(),
		opId: String = UUID.randomUUID().toString(),
		domainId: String? = null,
	): SendResult {
		// This device's own Gateway: where every blob op goes, and therefore where an attachment's
		// bytes end up. Resolved before the files are described, because each one has to name it.
		val local = routeGateway?.takeIf { it.isNotEmpty() } ?: transport.store.loadGatewayId()
		// Staged before the message is composed: the op carries a reference per file, never the bytes,
		// so composing a send costs the same whether the attachment is a screenshot or a video.
		val wireFiles = files.map { f ->
			ChannelFile(
				filename = f.name,
				mime = f.mime,
				size = f.size,
				descriptiveKey = f.name,
				blobId = uploadBlob(f.source),
				// Bytes go to the ROUTE Gateway while this send seals to the TARGET's, so the two are
				// routinely different and the receiver has no way to guess which one to ask. Naming the
				// holder here is what lets a cross-Gateway attachment be fetched at all.
				blobGateway = local,
				// A picker file is an ordinary attachment by construction; the role is a literal, so
				// no user file can ever be classified as machinery by this producer.
				role = "attachment",
			)
		}
		// Carry the selected session's Domain so the Gateway resolves a cross-Domain seal target by the full
		// (domainId, gatewayId) pair; null/local keeps the local resolution.
		val crossDomain = domainId?.ifEmpty { null }
		val op = ConsoleOp.Send(to = to, domainId = crossDomain, body = body, files = wireFiles.ifEmpty { null })
		// A same-Domain send seals directly to the Gateway hosting the target team (a bare name resolves to
		// the local Gateway), so a cross-Gateway send goes E2E to that Gateway. A cross-Domain send instead
		// seals to the local Gateway: the friend Gateway's keys are not in this owner's keyring, so the local
		// Gateway opens the op and relays it to the friend over the mesh.
		val target = if (crossDomain != null) local else transport.gatewayOfTarget(to, local)
		// Ordinary call timeout: this op carries file references, not file bytes, so it is the same
		// size as any other send. The untimed exemption moved to blobPut, which is where the bytes are.
		val replyBody = transport.relay(op, opId, targetGateway = target)
		val status = replyBody.result?.let {
			runCatching { wireJson.decodeFromJsonElement<ConsoleSendResult>(it).status }.getOrNull()
		}
		return SendResult(ok = replyBody.ok, status = status.orEmpty(), error = replyBody.error)
	}

	/** Drain new mailbox entries since cursor (epoch-gated). With holdMs > 0 the server long-polls: an empty
	 * mailbox holds the request open until a message arrives or the hold expires, so delivery is near-instant
	 * at about one request per hold window instead of constant fast polling.
	 *
	 * `knownPresenceVersions` mirrors `knownDomainVersion`'s piggyback shape, generalized to an array (one
	 * entry per source Gateway, currently just this Gateway's own): the server returns the presence plane's
	 * current snapshot only when it differs. `focus` declares what this device is currently looking at, so
	 * the Gateway's intent tracker can ramp the host daemon's derivation cadence for the sessions that
	 * matter right now. `knownLinkedPeersVersion` is the same piggyback shape again for the linked-peers
	 * plane, a single scalar (this Gateway's own roster has no multi-source concept to array over).
	 * `knownReadAnchorsVersion` is the same single-scalar shape once more, for this owner's own
	 * cross-device read-position plane (see report_read below). `knownCrossDomainPresenceVersions` is
	 * an ARRAY again like `knownPresenceVersions` - genuinely N independently-versioned planes, one
	 * per linked Domain, not a single scalar. */
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
		// Carry the synced keyring version so the route Gateway returns the snapshot only when it changed
		// (a revocation made elsewhere reaches this Console within one cycle).
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
		// Ordered timeout chain for a held poll: gateway replies by holdMs (40s), evie's relay
		// hold fires at 55s if the gateway vanished, this read timeout at holdMs+HELD_READ_MARGIN_MS
		// (58s) catches a vanished evie, and the apiserver proxy's PROXY_CEILING_MS (60s) outranks
		// them all - pinned as LONG_POLL_HOLD_MS + HELD_READ_MARGIN_MS < PROXY_CEILING_MS in
		// ChatRepositoryConstantsTest. Each failure layer returns before the next races it.
		val heldReadTimeoutMs = if (holdMs > 0) holdMs + ConsoleHttp.HELD_READ_MARGIN_MS else null
		val body = transport.relay(
			op,
			readTimeoutMs = heldReadTimeoutMs,
			// Derived from this call's own read timeout (not an independent literal) so it
			// can never drift below what that read timeout itself needs to complete.
			callTimeoutMs = heldReadTimeoutMs?.let { it + ConsoleHttp.CALL_TIMEOUT_MARGIN_MS + ConsoleHttp.PINNED_CONNECT_TIMEOUT_MS },
		)
		// A relay-level failure must SURFACE, not masquerade as a successful empty drain:
		// a fabricated empty (with epoch 0) hid outages from the health signal and forced
		// a spurious epoch flip on the next real poll. Throw so the poll loop's catch
		// counts the failure and shows the offline banner.
		if (!body.ok || body.result == null) error("poll relay failed: ${body.error ?: "no result"}")
		return wireJson.decodeFromJsonElement<ConsolePollResult>(body.result)
	}

	/** Read one Gateway's whole board half. The plane rides only the route Gateway's poll, so any
	 * other Gateway's entries arrive through here. */
	// A member, not a sibling extension: BoardManager calls it from the board package, which would
	// need an import this file cannot add for it.
	suspend fun boardRead(gatewayId: String): ConsoleBoardReadResult =
		transport.resultOf(transport.relay(ConsoleOp.BoardRead, targetGateway = gatewayId), "board_read")

	/** A board mutation, sealed to the Gateway that homes the entry. Distinguishes the two outcomes
	 * the pending queue must tell apart: an [BoardRefused] means the gateway itself decided the op
	 * will never apply (retire it and flag the row), while a thrown error - transport, cleartext,
	 * unseal, anything - means retry. Only a sealed, signature-verified reply can carry a refusal,
	 * which the relay path already guarantees before this sees `ok`. */
	override suspend fun boardWrite(op: ConsoleOp, gatewayId: String, opId: String): List<String> {
		val body = transport.relay(op, opId, targetGateway = gatewayId)
		// An applied write can still have dropped attachments the Gateway could not resolve anywhere.
		// Returned rather than swallowed: dropping is a normal outcome, so an unreported one is
		// indistinguishable from a picture disappearing on its own.
		if (body.ok) {
			// Tolerant: an older Gateway answers without the field, and a decode hiccup must not turn a
			// write that APPLIED into a retry.
			return runCatching { transport.resultOf<ConsoleBoardWriteResult>(body, "board_write").dropped }
				.getOrNull()
				.orEmpty()
		}
		val error = body.error ?: ""
		// A refusal is marked by its PREFIX, never by ok=false alone: the gateway answers ok=false
		// for its own throws too (a Gateway not yet restarted says the board is unavailable), and
		// retiring on those would discard the owner's edit on ordinary deploy skew.
		if (error.startsWith(BOARD_REFUSED_PREFIX)) throw BoardRefused(error.removePrefix(BOARD_REFUSED_PREFIX).trim())
		error("board write failed: ${error.ifEmpty { "unknown error" }}")
	}

	/**
	 * Whether the entry's Gateway holds these bytes in full. One cheap stat, called from the board
	 * drain, which must never carry a transfer itself.
	 *
	 * A failure THROWS rather than answering false. "Could not find out" is not "not ready": the
	 * drain charges no attempt for a transfer still running, so collapsing the two would park a
	 * permanently failing stat at the lane head with attempts stuck at zero, where it never reaches
	 * the struggling threshold, never shows a marker, and blocks every later write to that Gateway.
	 */
	override suspend fun boardBytesReady(blobId: String, gatewayId: String): Boolean =
		blobStat(blobId, gatewayId).complete
}
