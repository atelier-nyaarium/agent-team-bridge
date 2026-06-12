package com.atelier_nyaarium.switchboard

import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.util.UUID
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/**
 * Credential blob the phone holds (pasted once). Reaches the phone bridge through
 * the k8s API service-proxy: the SA token authenticates to the API server, the app
 * token (a separate forwarded header) authenticates to evie.
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
) {
	companion object {
		fun parse(blob: String): Provisioning {
			val j = JSONObject(blob)
			return Provisioning(
				apiUrl = j.getString("apiUrl").trimEnd('/'),
				caPem = j.getString("caPem"),
				saToken = j.getString("saToken"),
				appToken = j.optString("appToken", ""),
				namespace = j.optString("namespace", "evie-bot"),
				service = j.optString("service", "evie-phone-bridge"),
				port = j.optInt("port", 20004),
				device = j.optString("device", android.os.Build.MODEL ?: "android"),
				conversationId = j.optString("conversationId", UUID.randomUUID().toString()),
			)
		}
	}
}

/** `status` is the wire word verbatim ("online" | "available"); `kind` is
 * "devcontainer" (wakeable project) or "loose" (ad-hoc session). Old arbiters
 * omit kind, which defaults to loose. */
data class Team(
	val name: String,
	val status: String,
	val mode: String,
	val queueDepth: Int,
	val kind: String = "loose",
)

data class RegisterResult(val cursor: Int, val epoch: Int)

data class SendResult(val ok: Boolean, val status: String, val inlineBody: String?, val error: String?)

/** Raw attachment as it arrives in a mailbox entry: base64 bytes plus metadata.
 * The repository decodes these to app-private storage before the UI sees them. */
data class RawFile(val filename: String, val mime: String, val base64: String?)

/** A file the user picked to send. Bytes are base64-encoded onto the wire. */
data class OutgoingFile(val name: String, val mime: String, val bytes: ByteArray)

data class MailboxEntry(
	val kind: String,
	val sessionId: String,
	val from: String?,
	val body: String,
	val seq: Int,
	val at: Long,
	val files: List<RawFile> = emptyList(),
	/** Reply state from the wire: "running" interim, "error", or null/completed. */
	val status: String? = null,
	/** Notification-bar line for kind "notice"; the body carries the full report. */
	val title: String? = null,
	/** The Short tier of a notice (4-6 sentences), addressable without parsing
	 * the body. Stub: parsed and persisted now, consumed by an upcoming feature. */
	val summary: String? = null,
)

data class Mailbox(val entries: List<MailboxEntry>, val cursor: Int, val epoch: Int, val dropped: Int)

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
	fun relay(opJson: String, opId: String = UUID.randomUUID().toString(), readTimeoutMs: Long? = null): String {
		val body = JSONObject()
			.put("device", prov.device)
			.put("conversationId", prov.conversationId)
			.put("opId", opId)
			.put("op", JSONObject(opJson))
			.toString()
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Android-Bridge-Token", "Bearer ${prov.appToken}")
			.post(body.toRequestBody(JSON))
			.build()
		val callClient = if (readTimeoutMs != null) {
			client.newBuilder().readTimeout(readTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS).build()
		} else {
			client
		}
		callClient.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(500)}")
			return text
		}
	}

	/** Claim this device's mailbox. Returns the starting cursor + epoch. */
	fun register(): RegisterResult {
		val r = JSONObject(relay("""{"kind":"register"}""")).optJSONObject("result") ?: error("register: no result")
		return RegisterResult(cursor = r.optInt("cursor", 0), epoch = r.optInt("epoch", 0))
	}

	fun teams(): List<Team> {
		val result = JSONObject(relay("""{"kind":"list_teams"}""")).optJSONObject("result") ?: return emptyList()
		val arr = result.optJSONArray("teams") ?: return emptyList()
		return (0 until arr.length()).map {
			val t = arr.getJSONObject(it)
			Team(
				name = t.optString("team"),
				status = t.optString("status"),
				mode = t.optString("mode"),
				queueDepth = t.optInt("queue_depth"),
				kind = t.optString("kind", "loose"),
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
		val op = JSONObject().put("kind", "send").put("to", to).put("body", body)
		if (files.isNotEmpty()) {
			val arr = JSONArray()
			for (f in files) {
				arr.put(
					JSONObject()
						.put("filename", f.name)
						.put("mime", f.mime)
						.put("size", f.bytes.size)
						.put("descriptiveKey", f.name)
						.put("base64", android.util.Base64.encodeToString(f.bytes, android.util.Base64.NO_WRAP)),
				)
			}
			op.put("files", arr)
		}
		val reply = JSONObject(relay(op.toString(), opId))
		val result = reply.optJSONObject("result")
		return SendResult(
			ok = reply.optBoolean("ok", false),
			status = result?.optString("status").orEmpty(),
			inlineBody = result?.optString("response").takeIf { !it.isNullOrEmpty() },
			error = reply.optString("error").takeIf { reply.has("error") },
		)
	}

	/** Drain new mailbox entries since cursor (epoch-gated). With holdMs > 0 the
	 * server long-polls: an empty mailbox holds the request open until a message
	 * arrives or the hold expires, so delivery is near-instant at ~1 request per
	 * hold window instead of constant fast polling. */
	fun poll(cursor: Int, epoch: Int, holdMs: Long = 0): Mailbox {
		val op = JSONObject().put("kind", "poll").put("cursor", cursor).put("epoch", epoch)
		if (holdMs > 0) op.put("holdMs", holdMs)
		// Ordered timeout chain for a held poll: arbiter replies by holdMs (40s),
		// evie's relay hold fires at 55s if the arbiter vanished, this read timeout
		// at holdMs+18s (58s) catches a vanished evie, and the apiserver proxy's
		// 60s outranks them all. Each failure layer returns before the next races it.
		val raw = relay(op.toString(), readTimeoutMs = if (holdMs > 0) holdMs + 18_000 else null)
		val result = JSONObject(raw).optJSONObject("result") ?: return Mailbox(emptyList(), cursor, epoch, 0)
		val arr = result.optJSONArray("entries")
		val entries = if (arr == null) emptyList() else (0 until arr.length()).map {
			val e = arr.getJSONObject(it)
			val filesArr = e.optJSONArray("files")
			val files = if (filesArr == null) emptyList() else (0 until filesArr.length()).map { fi ->
				val f = filesArr.getJSONObject(fi)
				RawFile(
					filename = f.optString("filename"),
					mime = f.optString("mime"),
					base64 = f.optString("base64").takeIf { s -> s.isNotEmpty() },
				)
			}
			MailboxEntry(
				kind = e.optString("kind"),
				sessionId = e.optString("session_id"),
				from = e.optString("from").takeIf { s -> s.isNotEmpty() },
				body = e.optString("body"),
				seq = e.optInt("seq"),
				at = e.optLong("at"),
				files = files,
				status = e.optString("status").takeIf { s -> s.isNotEmpty() },
				title = e.optString("title").takeIf { s -> s.isNotEmpty() },
				summary = e.optString("summary").takeIf { s -> s.isNotEmpty() },
			)
		}
		return Mailbox(entries, result.optInt("cursor", cursor), result.optInt("epoch", epoch), result.optInt("dropped", 0))
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
