package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleOpEnvelope
import com.atelier_nyaarium.switchboard.proto.ConsoleRelayFrame
import com.atelier_nyaarium.switchboard.proto.ConsoleRelayReply
import com.atelier_nyaarium.switchboard.proto.ConsoleReplyBody
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.parseTarget
import java.util.UUID
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

internal interface ConsoleSocketTransport {
	val proxyBase: String
	val appToken: String
	fun clientFor(base: String): okhttp3.OkHttpClient

	/** Advances the shared address ring. */
	fun unreachable(base: String): Boolean = false
}

internal class ConsoleRelayTransport(internal val prov: Provisioning, internal val store: AppStateStore) : ConsoleSocketTransport {
	/** Router leaf pinning. */
	internal val client = ConsoleHttp.buildLeafPinnedClient(prov.routerCertFp)

	/** Router addresses, in trial order. */
	private val candidates: List<String> =
		reachCandidates(RouterReach.decode(store.loadRouterReach()), prov.routerUrl, DEFAULT_ROUTER_PORT)

	/** Failed addresses retry after the ring. */
	@Volatile
	private var current = 0

	override val proxyBase: String
		get() = candidates[current]

	override val appToken: String
		get() = prov.appToken

	/** Private hosts use a short connect timeout. */
	override fun clientFor(base: String): okhttp3.OkHttpClient {
		val host = runCatching { java.net.URI(base).host }.getOrNull() ?: return client
		if (!isPrivateHost(host)) return client
		return client.newBuilder()
			.connectTimeout(LAN_CONNECT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
			.build()
	}

	init {
		// Log hosts only.
		DebugLog.log(
			"Relay",
			"transport candidates=${candidates.map { runCatching { java.net.URI(it).host }.getOrNull() ?: "?" }}",
		)
	}

	override fun unreachable(base: String): Boolean = failedToReach(base)

	/** Advances after a connection-level failure. */
	@Synchronized
	internal fun failedToReach(base: String): Boolean {
		val next = nextReachIndex(candidates, current, base) ?: return false
		if (next == current) return true // Concurrent move already selected the retry base.
		DebugLog.log("Relay", "unreachable ${runCatching { java.net.URI(base).host }.getOrNull()}, trying ${runCatching { java.net.URI(candidates[next]).host }.getOrNull()}")
		current = next
		return true
	}

	/** Fail over only on connection errors. */
	internal suspend inline fun <T> withReachFailover(attempt: (base: String) -> T): T {
		var tries = 0
		while (true) {
			val base = proxyBase
			try {
				return attempt(base)
			} catch (e: java.io.IOException) {
				tries++
				if (tries >= candidateCount || !failedToReach(base)) throw e
			}
		}
	}

	/** Number of candidate addresses. */
	internal val candidateCount: Int
		get() = candidates.size

	/** Stores advertised reachability and corrects bootstrap state. */
	internal fun reached(advertised: RouterReach?) {
		val known = RouterReach.decode(store.loadRouterReach())
		// Use the advertised port with its host.
		val next = RouterReach(
			publicHost = advertised?.publicHost ?: known.publicHost,
			publicPort = if (advertised?.publicHost != null) advertised.publicPort else known.publicPort,
			lanAddresses = advertised?.lanAddresses?.takeIf { it.isNotEmpty() } ?: known.lanAddresses,
		)
		if (next != known) store.saveRouterReach(next.encode())
		next.publicHost?.let { selfCorrectBootstrap(it, next.publicPort) }
	}

	/** Corrects the bootstrap host and advertised port. */
	private fun selfCorrectBootstrap(publicHost: String, publicPort: Int?) {
		val blob = store.load() ?: return
		val json = runCatching { org.json.JSONObject(blob) }.getOrNull() ?: return
		val currentUrl = json.optString("routerUrl")
		if (currentUrl.isEmpty()) return
		val port = publicPort ?: reachPort(currentUrl, DEFAULT_ROUTER_PORT)
		val wanted = "https://$publicHost:$port"
		if (currentUrl == wanted) return
		DebugLog.log("Relay", "bootstrap self-corrected to $publicHost")
		store.save(json.put("routerUrl", wanted).toString())
	}

	/** Gateway selected for relay routing. */
	@Volatile
	internal var routeGateway: String? = null

	private fun requireConsoleIdentity(): Crypto.Identity =
		when (val load = store.loadIdentity()) {
			is IdentityLoad.Loaded -> load.identity
			IdentityLoad.Absent -> error("This device is not enrolled. Re-run setup.sh and re-import the setup blob.")
			IdentityLoad.Corrupt -> error("identity corrupt - the stored console key did not decode; restore from backup or re-run setup.sh")
		}

	/** Seals only to admitted Gateway keys. */
	private fun requireGatewayKeys(gatewayId: String): AppStateStore.GatewayKeys {
		val keyring = Keyring.parse(store.loadDomain()) ?: error("Gateway \"$gatewayId\" is not in the keyring.")
		val admission = keyring.resolveGateway(gatewayId) ?: error("Gateway \"$gatewayId\" is not in the keyring.")
		return AppStateStore.GatewayKeys(admission.signPub, admission.boxPub)
	}

	private fun resolveGatewayId(): String =
		routeGateway?.takeIf { it.isNotEmpty() }
			?: store.loadGatewayId().takeIf { it.isNotEmpty() }
			?: error("No Gateway admitted yet - add one from Gateways.")

	/** Builds a fresh frame for every retry. */
	private fun buildSealedFrame(
		op: ConsoleOp,
		opId: String,
		identity: Crypto.Identity,
		targetGateway: String,
		hostBoxPub: String,
	): ConsoleRelayFrame {
		val envelope = ConsoleOpEnvelope(
			v = 1L,
			conversationId = prov.conversationId,
			device = prov.device,
			at = System.currentTimeMillis(),
			op = op,
		)
		val plaintext = wireJson.encodeToString(ConsoleOpEnvelope.serializer(), envelope).toByteArray(Charsets.UTF_8)
		val cryptoEnv = Crypto.seal(plaintext, hostBoxPub, identity.sign.priv)
		return ConsoleRelayFrame(
			v = 1L,
			opId = opId,
			signerSignPub = identity.sign.pub,
			targetGateway = targetGateway,
			sealed = cryptoEnv.toProto(),
		)
	}

	/** Unseals and verifies a reply. */
	private fun unsealReply(sealed: SealedEnvelope, identity: Crypto.Identity, hostSignPub: String): ConsoleReplyBody {
		val plain = Crypto.unseal(sealed.toCrypto(), identity.box.priv, hostSignPub)
		return wireJson.decodeFromString<ConsoleReplyBody>(plain.toString(Charsets.UTF_8))
	}

	/** Relays one sealed operation. */
	internal suspend fun relay(
		op: ConsoleOp,
		opId: String = UUID.randomUUID().toString(),
		readTimeoutMs: Long? = null,
		targetGateway: String? = null,
		// Bounds the total call; null for blobPut.
		callTimeoutMs: Long? = ConsoleHttp.DEFAULT_RELAY_CALL_TIMEOUT_MS,
	): ConsoleReplyBody {
		val identity = requireConsoleIdentity()
		// Seal to the session's Gateway.
		val gatewayId = targetGateway?.takeIf { it.isNotEmpty() } ?: resolveGatewayId()
		val hostKeys = requireGatewayKeys(gatewayId)

		val frame = buildSealedFrame(op, opId, identity, gatewayId, hostKeys.boxPub)
		val payload = wireJson.encodeToString(ConsoleRelayFrame.serializer(), frame).toRequestBody(ConsoleHttp.JSON)
		val resp = withReachFailover { base ->
			// Apply timeouts per candidate.
			val callClient = if (readTimeoutMs != null || callTimeoutMs != null) {
				clientFor(base).newBuilder().apply {
					if (readTimeoutMs != null) readTimeout(readTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
					if (callTimeoutMs != null) callTimeout(callTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
				}.build()
			} else {
				clientFor(base)
			}
			val req = Request.Builder()
				.url("$base/relay")
				.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
				.post(payload)
				.build()
			ConsoleHttp.executeCancellable(callClient, req)
		}
		if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.text.take(500)}")
		val reply = wireJson.decodeFromString<ConsoleRelayReply>(resp.text)
		// Surface cleartext relay errors.
		if (reply.sealed == null) {
			error(reply.error ?: "relay error (no sealed payload)")
		}
		return unsealReply(reply.sealed, identity, hostKeys.signPub)
	}

	/** This instance's Router-direct POST, filling in ConsoleHttp's testable postRouterDirect primitive
	 * with this ConsoleClient's own client/url/token. Every production Router-direct call site goes
	 * through here instead of repeating those positional args.
	 * logBody has NO default (mirrors the ConsoleHttp primitive) - a call whose 2xx
	 * result carries secret material the debug log must never echo passes false; every other site
	 * states true explicitly, so a new site cannot compile without deciding rather than silently
	 * inheriting a "log everything" default. */
	internal suspend inline fun <reified R> postRouterDirect(
		tag: String,
		describe: String,
		body: RequestBody,
		logBody: Boolean,
		fail: (String) -> R,
	): R = withReachFailover { base ->
		ConsoleHttp.postRouterDirect(clientFor(base), "$base/relay", prov.appToken, tag, describe, body, logBody, fail)
	}

	internal suspend fun postOwnerOp(ownerOp: com.atelier_nyaarium.switchboard.proto.OwnerOp): JsonElement =
		withReachFailover { base ->
			val body = buildJsonObject {
				put("ownerOp", wireJson.encodeToJsonElement(com.atelier_nyaarium.switchboard.proto.OwnerOp.serializer(), ownerOp))
			}.toString().toRequestBody(ConsoleHttp.JSON)
			val req = Request.Builder()
				.url("$base/console")
				.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
				.post(body)
				.build()
			val resp = ConsoleHttp.executeCancellable(clientFor(base), req)
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.text.take(500)}")
			wireJson.parseToJsonElement(resp.text)
		}

	/** Decodes a successful result. */
	internal inline fun <reified T> resultOf(body: ConsoleReplyBody, op: String): T {
		if (!body.ok) error("$op failed: ${body.error ?: "unknown error"}")
		val result = body.result ?: error("$op: no result")
		return wireJson.decodeFromJsonElement(result)
	}

	/** Extracts the target Gateway. */
	internal fun gatewayOfTarget(to: String, localGateway: String): String =
		when (val t = parseTarget(to, "", localGateway)) {
			is Address -> t.gateway
			is SpawnPoint -> t.gateway
		}

	/** Resolves the target session's Gateway. */
	internal fun targetGatewayOf(target: String): String =
		gatewayOfTarget(target, routeGateway?.takeIf { it.isNotEmpty() } ?: store.loadGatewayId())
}
