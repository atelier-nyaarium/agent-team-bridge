package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ChannelFile
import com.atelier_nyaarium.switchboard.proto.PhoneOp
import com.atelier_nyaarium.switchboard.proto.PhonePollResult
import com.atelier_nyaarium.switchboard.proto.PhoneRegisterResult
import com.atelier_nyaarium.switchboard.proto.PhoneRelayReply
import com.atelier_nyaarium.switchboard.proto.PhoneSendResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.util.UUID
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Credential blob the phone holds (pasted once). Reaches the phone bridge through
 * the k8s API service-proxy: the SA token authenticates to the API server, the app
 * token (a separate forwarded header) authenticates to evie.
 *
 * Thin wrapper over the generated proto.Provisioning (the wire shape): this class
 * owns the RUNTIME behavior a schema cannot express - device defaulting to
 * Build.MODEL, conversationId minting a UUID, trailing-slash URL normalization,
 * and the service-proxy defaults.
 */
data class Provisioning(
	val apiUrl: String,
	val caPem: String,
	val saToken: String,
	val appToken: String,
	val namespace: String,
	val service: String,
	val port: Int,
	val device: String,
	val conversationId: String,
	/** STTS (TTS playback) service base URL; empty until known. */
	val sttsUrl: String = "",
	/** STTS API key, sent as the vrcstt-api-key header; empty disables Play. */
	val sttsKey: String = "",
) {
	companion object {
		fun parse(blob: String): Provisioning {
			val p = wireJson.decodeFromString<com.atelier_nyaarium.switchboard.proto.Provisioning>(blob)
			return Provisioning(
				apiUrl = p.apiUrl.trimEnd('/'),
				caPem = p.caPem,
				saToken = p.saToken,
				appToken = p.appToken ?: "",
				namespace = p.namespace ?: "evie-bot",
				service = p.service ?: "evie-phone-bridge",
				port = p.port?.toInt() ?: 20004,
				device = p.device ?: (android.os.Build.MODEL ?: "android"),
				conversationId = p.conversationId ?: UUID.randomUUID().toString(),
				sttsUrl = (p.sttsUrl ?: "").trimEnd('/'),
				sttsKey = p.sttsKey ?: "",
			)
		}
	}
}

/** Qualify a bare local name under a Host as `host/name`. A name that is already
 * qualified, or qualified under no Host (the pre-federation single-Host case), is
 * returned unchanged - bare resolves to the local Host on the arbiter. */
fun qualifyTeam(host: String, name: String): String =
	if (host.isEmpty() || name.contains(Protocol.HOST_QUALIFIER_SEP)) name
	else "$host${Protocol.HOST_QUALIFIER_SEP}$name"

/** UI model for the sessions board. Mapped one-to-one from the wire TeamInfo in
 * `teams()`; also constructed locally for ended threads whose team has left the
 * bridge (a state that never exists on the wire). `name` is the host-qualified
 * composite key (`host/local`); `displayName`/`host` derive from it. */
data class Team(
	val name: String,
	val status: String,
	val mode: String,
	val queueDepth: Int,
	val kind: String = "loose",
) {
	/** Short local name shown in the UI: the tail after the host qualifier (the
	 * whole name when bare). */
	val displayName: String get() = name.substringAfter(Protocol.HOST_QUALIFIER_SEP)

	/** Owning Host id (the segment before the qualifier), or "" for a bare name. */
	val host: String get() = name.substringBefore(Protocol.HOST_QUALIFIER_SEP, "")
}

data class SendResult(val ok: Boolean, val status: String, val error: String?)

/** A file the user picked to send. Bytes are base64-encoded onto the wire. */
data class OutgoingFile(val name: String, val mime: String, val bytes: ByteArray)

/** The op-only envelope the phone POSTs; evie composes the full phone_relay
 * frame around it (type + protocol version), so this is not PhoneRelayFrame. */
@Serializable
private data class RelayEnvelope(
	val device: String,
	val conversationId: String,
	val opId: String,
	val op: PhoneOp,
)

/** Decode posture for everything off the wire: unknown fields are tolerated
 * (additive protocol). Encode posture: the default config omits null-defaulted
 * optionals, which is exactly what the arbiter's schemas accept. */
internal val wireJson = Json { ignoreUnknownKeys = true }

/** Talks to the phone bridge through the CA-pinned k8s API service-proxy. */
class PhoneClient(private val prov: Provisioning) {
	private val client = buildPinnedClient(prov.caPem)
	private val proxyBase =
		"${prov.apiUrl}/api/v1/namespaces/${prov.namespace}/services/${prov.service}:${prov.port}/proxy"

	/**
	 * Direct CA-pinned GET to the API server with the SA token. Proves the tunnel
	 * (TLS pinning, reachability, auth) works before the phone bridge is deployed.
	 */
	fun apiReachable(): String {
		val req = Request.Builder()
			.url("${prov.apiUrl}/api/v1/namespaces/${prov.namespace}")
			.header("Authorization", "Bearer ${prov.saToken}")
			.get()
			.build()
		client.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(300)}")
			return "reachable (HTTP ${resp.code})"
		}
	}

	/** Send a phone op through the service-proxy to the phone bridge. Mutating ops
	 * pass their own stable opId so a retry after a lost reply replays the cached
	 * result server-side instead of running the op twice (the protocol contract).
	 * A held op (long-poll) passes a read timeout above its server-side hold. */
	private fun relay(op: PhoneOp, opId: String = UUID.randomUUID().toString(), readTimeoutMs: Long? = null): PhoneRelayReply {
		val envelope = RelayEnvelope(prov.device, prov.conversationId, opId, op)
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Android-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(RelayEnvelope.serializer(), envelope).toRequestBody(JSON))
			.build()
		val callClient = if (readTimeoutMs != null) {
			client.newBuilder().readTimeout(readTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS).build()
		} else {
			client
		}
		callClient.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(500)}")
			return wireJson.decodeFromString<PhoneRelayReply>(text)
		}
	}

	/** The reply's result payload decoded as T, or an error for a failed op. */
	private inline fun <reified T> resultOf(reply: PhoneRelayReply, op: String): T {
		if (!reply.ok) error("$op failed: ${reply.error ?: "unknown error"}")
		val result = reply.result ?: error("$op: no result")
		return wireJson.decodeFromJsonElement(result)
	}

	/** Claim this device's mailbox. Returns the starting cursor + epoch. */
	fun register(): PhoneRegisterResult = resultOf(relay(PhoneOp.Register), "register")

	/** List the bridge's sessions, each keyed by its host-qualified name. A
	 * session's Host comes from the wire (`TeamInfo.host`); when a pre-federation
	 * arbiter omits it, `localHostId` (this connection's Host, learned at register)
	 * is the fallback. Both empty leaves the name bare (single implicit Host). */
	fun teams(localHostId: String = ""): List<Team> {
		val reply = relay(PhoneOp.ListTeams)
		if (!reply.ok || reply.result == null) return emptyList()
		val result =
			wireJson.decodeFromJsonElement<com.atelier_nyaarium.switchboard.proto.PhoneListTeamsResult>(reply.result)
		return result.teams.map {
			val host = it.host?.ifEmpty { null } ?: localHostId
			Team(
				name = qualifyTeam(host, it.team),
				status = it.status,
				mode = it.mode ?: "",
				queueDepth = it.queue_depth.toInt(),
				kind = it.kind ?: "loose",
			)
		}
	}

	fun listTeams(): List<String> = teams().map { it.name }

	/**
	 * Send a message to a team. The reply may arrive inline (within the relay hold)
	 * or land in the mailbox for a later poll; either way the conversation is keyed
	 * server-side by (this device, team).
	 */
	fun send(
		to: String,
		body: String,
		files: List<OutgoingFile> = emptyList(),
		opId: String = UUID.randomUUID().toString(),
	): SendResult {
		val wireFiles = files.map { f ->
			ChannelFile(
				filename = f.name,
				mime = f.mime,
				size = f.bytes.size.toLong(),
				descriptiveKey = f.name,
				base64 = android.util.Base64.encodeToString(f.bytes, android.util.Base64.NO_WRAP),
			)
		}
		val op = PhoneOp.Send(to = to, body = body, files = wireFiles.ifEmpty { null })
		val reply = relay(op, opId)
		val status = reply.result?.let {
			runCatching { wireJson.decodeFromJsonElement<PhoneSendResult>(it).status }.getOrNull()
		}
		return SendResult(ok = reply.ok, status = status.orEmpty(), error = reply.error)
	}

	/** Drain new mailbox entries since cursor (epoch-gated). With holdMs > 0 the
	 * server long-polls: an empty mailbox holds the request open until a message
	 * arrives or the hold expires, so delivery is near-instant at ~1 request per
	 * hold window instead of constant fast polling. */
	fun poll(cursor: Long, epoch: Long, holdMs: Long = 0): PhonePollResult {
		val op = PhoneOp.Poll(cursor = cursor, epoch = epoch, holdMs = if (holdMs > 0) holdMs else null)
		// Ordered timeout chain for a held poll: arbiter replies by holdMs (40s),
		// evie's relay hold fires at 55s if the arbiter vanished, this read timeout
		// at holdMs+18s (58s) catches a vanished evie, and the apiserver proxy's
		// 60s outranks them all. Each failure layer returns before the next races it.
		val reply = relay(op, readTimeoutMs = if (holdMs > 0) holdMs + 18_000 else null)
		if (!reply.ok || reply.result == null) return PhonePollResult(emptyList(), cursor, 0, epoch)
		return wireJson.decodeFromJsonElement<PhonePollResult>(reply.result)
	}

	companion object {
		private val JSON = "application/json".toMediaType()

		/** Trust ONLY the supplied cluster CA (the API server cert is cluster-signed). */
		private fun buildPinnedClient(caPem: String): OkHttpClient {
			val ca = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(caPem.toByteArray()))
			val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
				load(null, null)
				setCertificateEntry("cluster-ca", ca)
			}
			val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
			val tm = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
			val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), SecureRandom()) }
			// The relay holds a send op server-side for up to 25s (the arbiter's
			// send bound) before answering "running", so OkHttp's 10s default read
			// timeout would mislabel every cold-wake send as failed. Write gets
			// headroom for 10 MB attachment uploads on slow links.
			return OkHttpClient.Builder()
				.sslSocketFactory(ssl.socketFactory, tm)
				.connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
				.readTimeout(35, java.util.concurrent.TimeUnit.SECONDS)
				.writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
				.build()
		}
	}
}
