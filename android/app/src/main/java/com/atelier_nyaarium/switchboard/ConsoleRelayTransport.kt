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
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * What every console op needs to reach the bridge: the pinned client, the proxy URL, the identity and
 * keyring lookups, the seal/unseal pair, and the two decoders.
 *
 * An explicit object rather than state captured on ConsoleClient, because an op living in a sibling
 * file is an extension function and an extension cannot reach a private member. This carries the whole
 * seal/relay path behind one widened ConsoleClient member, leaving `blobs` as the only other.
 */
internal class ConsoleRelayTransport(internal val prov: Provisioning, internal val store: AppStateStore) {
	private val direct = prov.transport == "direct"

	/** Trust is a pinned CA through the k8s proxy, or the Router's pinned leaf. Built per branch
	 * because a direct record carries no CA to build the other one from. */
	internal val client =
		if (direct) ConsoleHttp.buildLeafPinnedClient(prov.routerCertFp) else ConsoleHttp.buildPinnedClient(prov.caPem)

	/** The Router addresses this device knows, in the order they are tried. On the k8s branch there is
	 * exactly one (the proxy), so the whole failover machinery below is inert there. */
	private val candidates: List<String> =
		if (direct) {
			reachCandidates(RouterReach.decode(store.loadRouterReach()), prov.routerUrl, DEFAULT_ROUTER_PORT)
		} else {
			listOf("${prov.apiUrl}/api/v1/namespaces/${prov.namespace}/services/${prov.service}:${prov.port}/proxy")
		}

	/** Index of the candidate every op currently posts to. Advanced by [failedToReach], never reset:
	 * an address that failed once is retried only after every other one has, which is what a phone
	 * that just walked out of WiFi range needs. */
	@Volatile
	private var current = 0

	/** Where an op is posted. The Router serves its ops at the root, so there is no proxy path to
	 * thread through; the same field keeps every call site unchanged. Reads the CURRENT candidate, so
	 * a failover between two ops is picked up by the second without the caller knowing. */
	internal val proxyBase: String
		get() = candidates[current]

	/**
	 * The client to dial [base] with: the shared one, except a private address gets a short connect
	 * timeout. A LAN address answers from the same subnet or not at all, so waiting the full 15s on
	 * one is waiting for something that cannot happen - and that wait is the entire cost of trying
	 * LAN first while away from home. Everything else (trust, pinning, read timeouts) is inherited.
	 */
	internal fun clientFor(base: String): okhttp3.OkHttpClient {
		val host = runCatching { java.net.URI(base).host }.getOrNull() ?: return client
		if (!isPrivateHost(host)) return client
		return client.newBuilder()
			.connectTimeout(LAN_CONNECT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
			.build()
	}

	init {
		// The host only, never a token: an operator reading logcat needs to see WHICH endpoint an
		// op is going to when two clients on one device disagree, and this is the one place the
		// answer is decided.
		DebugLog.log(
			"Relay",
			"transport direct=$direct candidates=${candidates.map { runCatching { java.net.URI(it).host }.getOrNull() ?: "?" }}",
		)
	}

	/**
	 * A connection to [proxyBase] could not be made at all (a thrown IOException, never an HTTP
	 * status: a status means the Router was reached and said something). Advance to the next candidate
	 * and report whether there is one, so the caller retries once rather than failing the op on an
	 * address the phone simply cannot see from where it is.
	 */
	@Synchronized
	internal fun failedToReach(base: String): Boolean {
		if (base != proxyBase) return true // a concurrent op already moved on; the retry uses its choice
		if (candidates.size < 2) return false
		val next = (current + 1) % candidates.size
		DebugLog.log("Relay", "unreachable ${runCatching { java.net.URI(base).host }.getOrNull()}, trying ${runCatching { java.net.URI(candidates[next]).host }.getOrNull()}")
		current = next
		return true
	}

	/**
	 * Run [attempt] against the current candidate; on a connect-level failure (an IOException, meaning
	 * the address could not be reached at all) advance and retry, once per remaining candidate, so one
	 * op tries the whole ring at most once. An HTTP status of any kind is NOT a failover trigger: it
	 * proves the Router was reached, and the answer belongs to the caller. A cancellation is rethrown
	 * untouched, since it is not the address's fault.
	 */
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

	/** How many addresses there are to try, so the failover loop knows when it has been round. */
	internal val candidateCount: Int
		get() = candidates.size

	/**
	 * The Router answered and said how else it can be reached. Store that, and SELF-CORRECT the blob's
	 * bootstrap address to the advertised public host.
	 *
	 * The stored address is only ever "which Router do I start at"; after the first answer the Router
	 * itself is the truth. So a bootstrap left pointing at a raw LAN IP is rewritten to the domain,
	 * which survives a DHCP change - the LAN address it replaces arrives fresh in `lanAddresses` on
	 * every connect anyway. Only meaningful on the direct branch; the k8s proxy has nothing to learn.
	 */
	internal fun reached(advertised: RouterReach?) {
		if (!direct) return
		val known = RouterReach.decode(store.loadRouterReach())
		// The port travels with the host it was advertised beside: a Router that named a public host
		// also said which port, and absent there means its own, never a port remembered from before.
		val next = RouterReach(
			publicHost = advertised?.publicHost ?: known.publicHost,
			publicPort = if (advertised?.publicHost != null) advertised.publicPort else known.publicPort,
			lanAddresses = advertised?.lanAddresses?.takeIf { it.isNotEmpty() } ?: known.lanAddresses,
		)
		if (next != known) store.saveRouterReach(next.encode())
		next.publicHost?.let { selfCorrectBootstrap(it, next.publicPort) }
	}

	/** Point the stored blob at [publicHost] when it names something else. A no-op when it already
	 * agrees, so an ordinary connect does not rewrite the blob on every poll. The port is the advertised
	 * public one; with none advertised, whatever the blob already names, so an owner-typed port is not
	 * rewritten by a Router that said nothing about ports. */
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

	/** This console's route Gateway id, learned at register and set by ChatRepository.
	 * Rides every relay so the Gateway routes to the right Gateway; null until learned. */
	@Volatile
	internal var routeGateway: String? = null

	/** Resolve the console identity from the store. Absent means not provisioned (re-provision hint);
	 * corrupt means present-but-unreadable bytes that a re-provision will not fix without a restore, so
	 * the two surface distinct causes instead of one ambiguous "not enrolled". Never mints here:
	 * enrollment owns minting. */
	private fun requireConsoleIdentity(): Crypto.Identity =
		when (val load = store.loadIdentity()) {
			is IdentityLoad.Loaded -> load.identity
			IdentityLoad.Absent -> error("This device is not enrolled. Re-run setup.sh and re-import the setup blob.")
			IdentityLoad.Corrupt -> error("identity corrupt - the stored console key did not decode; restore from backup or re-run setup.sh")
		}

	/** Resolve a Gateway's keys from the owner-rooted keyring, verifying its admission before sealing to
	 * it. The device side of symmetric trust: the Console seals to a Gateway because the owner admitted
	 * that Gateway's keys, never because a provisioning blob named them. A Gateway absent from the keyring
	 * is worded "not in the keyring" so it cannot collide with the server-side "is not admitted to the
	 * Domain" sync-lag token. */
	private fun requireGatewayKeys(gatewayId: String): AppStateStore.GatewayKeys {
		val keyring = Keyring.parse(store.loadDomain()) ?: error("Gateway \"$gatewayId\" is not in the keyring.")
		val admission = keyring.resolveGateway(gatewayId) ?: error("Gateway \"$gatewayId\" is not in the keyring.")
		return AppStateStore.GatewayKeys(admission.signPub, admission.boxPub)
	}

	/** The Gateway id to seal to, preferring the live routeGateway set after register, then the persisted
	 * id from a previous session. Throws on a fresh install before the owner has admitted any Gateway,
	 * where the fix is to admit one (not re-provision); the "no gateway admitted" token routes the banner
	 * to that guidance. */
	private fun resolveGatewayId(): String =
		routeGateway?.takeIf { it.isNotEmpty() }
			?: store.loadGatewayId().takeIf { it.isNotEmpty() }
			?: error("No Gateway admitted yet - add one from Gateways.")

	/** Build a sealed ConsoleRelayFrame for one op. Called fresh for every send including retries, so
	 * each attempt uses a new ephemeral/nonce and the server's replay guard never sees a duplicate. */
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

	/** Unseal a reply envelope using the console's box private key, verified against
	 * the route Gateway's signing public key. */
	private fun unsealReply(sealed: SealedEnvelope, identity: Crypto.Identity, hostSignPub: String): ConsoleReplyBody {
		val plain = Crypto.unseal(sealed.toCrypto(), identity.box.priv, hostSignPub)
		return wireJson.decodeFromString<ConsoleReplyBody>(plain.toString(Charsets.UTF_8))
	}

	/** Send a console op through the service-proxy to the console bridge. Mutating ops pass their own
	 * stable opId so a retry after a lost reply replays the cached result server-side instead of running
	 * the op twice. A held op (long-poll) passes a read timeout above its server-side hold. Every call
	 * builds a fresh sealed frame so a retry produces a new ephemeral/nonce the replay guard accepts.
	 * Cancellable (see executeCancellable): a caller cancelled while this is in flight unwinds via
	 * CancellationException instead of blocking out the timeout - every caller up the chain must let
	 * that exception propagate rather than swallow it as an ordinary failure (see Cancellation.kt's
	 * rethrowIfCancellation/runCatchingCancellable, and the poll loop's own catch in ChatRepository). */
	internal suspend fun relay(
		op: ConsoleOp,
		opId: String = UUID.randomUUID().toString(),
		readTimeoutMs: Long? = null,
		targetGateway: String? = null,
		// Bounds the whole call so a peer that trickles bytes can't wedge the caller forever -
		// readTimeout alone only covers inactivity gaps. null opts out (blobPut, the one op whose
		// body is file bytes rather than a description of them).
		callTimeoutMs: Long? = ConsoleHttp.DEFAULT_RELAY_CALL_TIMEOUT_MS,
	): ConsoleReplyBody {
		val identity = requireConsoleIdentity()
		// An op seals to the Gateway hosting its session (resolved from the keyring), naming it so
		// evie routes there. Register/poll/list default to the route Gateway.
		val gatewayId = targetGateway?.takeIf { it.isNotEmpty() } ?: resolveGatewayId()
		val hostKeys = requireGatewayKeys(gatewayId)

		val frame = buildSealedFrame(op, opId, identity, gatewayId, hostKeys.boxPub)
		val payload = wireJson.encodeToString(ConsoleRelayFrame.serializer(), frame).toRequestBody(ConsoleHttp.JSON)
		val resp = withReachFailover { base ->
			// Per candidate, so a LAN address keeps its short connect timeout even under a long-poll's
			// own read/call bounds.
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
				// The SA token authenticates the k8s proxy hop, which a direct call does not make.
				.apply { if (!direct) header("Authorization", "Bearer ${prov.saToken}") }
				.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
				.post(payload)
				.build()
			ConsoleHttp.executeCancellable(callClient, req)
		}
		if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.text.take(500)}")
		val reply = wireJson.decodeFromString<ConsoleRelayReply>(resp.text)
		// Cleartext error path (console not admitted or pre-seal failure): surface it so the
		// UI can prompt enrollment rather than show a generic network error.
		if (reply.sealed == null) {
			error(reply.error ?: "relay error (no sealed payload)")
		}
		return unsealReply(reply.sealed, identity, hostKeys.signPub)
	}

	/** This instance's evie-direct POST, filling in ConsoleHttp's testable postEvieDirect primitive
	 * with this ConsoleClient's own client/url/tokens. Every production evie-direct call site goes
	 * through here instead of repeating those four positional args - besides the duplication, three of
	 * them are adjacent same-typed Strings (url, saToken, appToken) that Kotlin cannot keyword-enforce
	 * positionally, so a hand-repeated call is one transposition away from swapping which credential
	 * rides which header. logBody has NO default (mirrors the ConsoleHttp primitive) - a call whose 2xx
	 * result carries secret material the debug log must never echo passes false; every other site
	 * states true explicitly, so a new site cannot compile without deciding rather than silently
	 * inheriting a "log everything" default. */
	internal suspend inline fun <reified R> postEvieDirect(
		tag: String,
		describe: String,
		body: RequestBody,
		logBody: Boolean,
		fail: (String) -> R,
	): R = withReachFailover { base ->
		ConsoleHttp.postEvieDirect(clientFor(base), "$base/relay", prov.saToken, prov.appToken, tag, describe, body, logBody, fail)
	}

	/** The reply's result payload decoded as T, or an error for a failed op. */
	internal inline fun <reified T> resultOf(body: ConsoleReplyBody, op: String): T {
		if (!body.ok) error("$op failed: ${body.error ?: "unknown error"}")
		val result = body.result ?: error("$op: no result")
		return wireJson.decodeFromJsonElement(result)
	}

	/** The Gateway segment of a wire target. A local form (arity 1/2) resolves its gateway to
	 * [localGateway]; a fully-qualified form (arity 3/4) keeps its explicit gateway. */
	internal fun gatewayOfTarget(to: String, localGateway: String): String =
		when (val t = parseTarget(to, "", localGateway)) {
			is Address -> t.gateway
			is SpawnPoint -> t.gateway
		}

	/** The Gateway that hosts a target session (a bare name resolves to the local Gateway), so a peek/send
	 * seals E2E to that Gateway. Mirrors send(). */
	internal fun targetGatewayOf(target: String): String =
		gatewayOfTarget(target, routeGateway?.takeIf { it.isNotEmpty() } ?: store.loadGatewayId())
}
