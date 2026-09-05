package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.parseTarget
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

internal interface ConsoleSocketTransport {
	val proxyBase: String
	val appToken: String
	fun clientFor(base: String): okhttp3.OkHttpClient

	fun unreachable(base: String): Boolean = false
}

/** The Router preflight a connect attempt opens with. */
internal interface ConsoleReach {
	suspend fun apiReachable(): RouterReach?
}

/** Posts OwnerOps to the Router console surface with reach failover and pinning. */
internal class ConsoleRouterTransport(
	internal val credentials: ConsoleCredentials,
	internal val store: AppStateStore,
	private val homeGatewayId: (() -> String?)?,
	private val saveProvisioning: (String) -> Unit,
) : ConsoleSocketTransport, ConsoleReach {
	internal val client = ConsoleHttp.buildLeafPinnedClient(credentials.routerCertFp)

	private val candidates: List<String> =
		reachCandidates(RouterReach.decode(store.loadRouterReach()), credentials.routerUrl, DEFAULT_ROUTER_PORT)

	@Volatile
	private var current = 0

	override val proxyBase: String
		get() = candidates[current]

	override val appToken: String
		get() = credentials.appToken

	override fun clientFor(base: String): okhttp3.OkHttpClient {
		val host = runCatching { java.net.URI(base).host }.getOrNull() ?: return client
		if (!isPrivateHost(host)) return client
		return client.newBuilder()
			.connectTimeout(LAN_CONNECT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
			.build()
	}

	init {
		DebugLog.log(
			"Router",
			"transport candidates=${candidates.map { runCatching { java.net.URI(it).host }.getOrNull() ?: "?" }}",
		)
	}

	override fun unreachable(base: String): Boolean = failedToReach(base)

	@Synchronized
	internal fun failedToReach(base: String): Boolean {
		val next = nextReachIndex(candidates, current, base) ?: return false
		if (next == current) return true
		DebugLog.log("Router", "unreachable ${runCatching { java.net.URI(base).host }.getOrNull()}, trying ${runCatching { java.net.URI(candidates[next]).host }.getOrNull()}")
		current = next
		return true
	}

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

	internal val candidateCount: Int
		get() = candidates.size

	internal fun reached(advertised: RouterReach?) {
		val known = RouterReach.decode(store.loadRouterReach())
		val next = RouterReach(
			publicHost = advertised?.publicHost ?: known.publicHost,
			publicPort = if (advertised?.publicHost != null) advertised.publicPort else known.publicPort,
			lanAddresses = advertised?.lanAddresses?.takeIf { it.isNotEmpty() } ?: known.lanAddresses,
		)
		if (next != known) store.saveRouterReach(next.encode())
		next.publicHost?.let { selfCorrectBootstrap(it, next.publicPort) }
	}

	private fun selfCorrectBootstrap(publicHost: String, publicPort: Int?) {
		val blob = store.load() ?: return
		val json = runCatching { org.json.JSONObject(blob) }.getOrNull() ?: return
		val currentUrl = json.optString("routerUrl")
		if (currentUrl.isEmpty()) return
		val port = publicPort ?: reachPort(currentUrl, DEFAULT_ROUTER_PORT)
		val wanted = "https://$publicHost:$port"
		if (currentUrl == wanted) return
		DebugLog.log("Router", "bootstrap self-corrected to $publicHost")
		saveProvisioning(json.put("routerUrl", wanted).toString())
	}

	/** Leaf-pinned Router preflight; answers the reach, which may name the Domain. */
	override suspend fun apiReachable(): RouterReach? {
		// Only the preflight may fail over.
		withReachFailover { base ->
			val req = buildHealthRequest(base)
			clientFor(base).newCall(req).execute().use { resp ->
				val text = resp.body?.string().orEmpty()
				if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(300)}")
			}
		}
		val reach = runCatching { fetchReach() }.getOrNull()
		reached(reach)
		return reach
	}

	private fun fetchReach(): RouterReach? {
		val req = buildReachRequest(proxyBase)
		client.newCall(req).execute().use { resp ->
			if (!resp.isSuccessful) return null
			return RouterReach.decode(resp.body?.string())
		}
	}

	internal fun buildHealthRequest(base: String): Request = Request.Builder()
		.url(base + Protocol.Wire.ROUTER_PATH_HEALTH)
		.get()
		.build()

	/** The signer is known before the Domain is. */
	internal fun buildReachRequest(base: String): Request {
		val signer = (store.loadIdentity() as? IdentityLoad.Loaded)?.identity?.sign?.pub
		val body = buildJsonObject {
			put("reach", buildJsonObject { if (signer != null) put("signerSignPub", signer) })
		}.toString()
		return Request.Builder()
			.url(base + Protocol.Wire.ROUTER_PATH_CONSOLE)
			.header(Protocol.Wire.CONSOLE_TOKEN_HEADER, Protocol.Wire.BEARER_PREFIX + credentials.appToken)
			.post(body.toRequestBody(ConsoleHttp.JSON))
			.build()
	}

	internal suspend inline fun <reified R> postRouterDirect(
		tag: String,
		describe: String,
		body: RequestBody,
		logBody: Boolean,
		fail: (String) -> R,
	): R = withReachFailover { base ->
		ConsoleHttp.postRouterDirect(clientFor(base), base + Protocol.Wire.ROUTER_PATH_CONSOLE, credentials.appToken, tag, describe, body, logBody, fail)
	}

	internal suspend fun postOwnerOp(ownerOp: OwnerOp): JsonElement =
		withReachFailover { base ->
			val req = buildOwnerOpRequest(base, ownerOp)
			val resp = ConsoleHttp.executeCancellable(clientFor(base), req)
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.text.take(500)}")
			wireJson.parseToJsonElement(resp.text)
		}

	internal fun buildOwnerOpRequest(base: String, ownerOp: OwnerOp): Request =
		buildOwnerOpRequest(base, ownerOp, credentials.appToken)

	internal inline fun <reified T> resultOf(body: OwnerOpAnswer, op: String): T {
		if (!body.ok) error("$op failed: ${body.error ?: "unknown error"}")
		val result = body.result ?: error("$op: no result")
		return wireJson.decodeFromJsonElement(result)
	}

	internal fun gatewayOfTarget(to: String, localGateway: String): String =
		when (val t = parseTarget(to, "", localGateway)) {
			is Address -> t.gateway
			is SpawnPoint -> t.gateway
		}

	internal fun targetGatewayOf(target: String): String =
		gatewayOfTarget(target, homeGatewayId?.invoke()?.takeIf { it.isNotEmpty() } ?: store.loadGatewayId())
}

internal fun buildOwnerOpRequest(base: String, ownerOp: OwnerOp, appToken: String): Request =
	Request.Builder()
		.url(base + Protocol.Wire.ROUTER_PATH_CONSOLE)
		.header(Protocol.Wire.CONSOLE_TOKEN_HEADER, Protocol.Wire.BEARER_PREFIX + appToken)
		.post(buildJsonObject {
			put("ownerOp", wireJson.encodeToJsonElement(OwnerOp.serializer(), ownerOp))
		}.toString().toRequestBody(ConsoleHttp.JSON))
		.build()
