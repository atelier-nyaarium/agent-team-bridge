package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.ChannelFile
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.EnrollResult
import com.atelier_nyaarium.switchboard.proto.PhoneOp
import com.atelier_nyaarium.switchboard.proto.PhoneOpEnvelope
import com.atelier_nyaarium.switchboard.proto.PhonePollResult
import com.atelier_nyaarium.switchboard.proto.PhoneRegisterResult
import com.atelier_nyaarium.switchboard.proto.PhoneRelayFrame
import com.atelier_nyaarium.switchboard.proto.PhoneRelayReply
import com.atelier_nyaarium.switchboard.proto.PhoneReplyBody
import com.atelier_nyaarium.switchboard.proto.PhoneSendResult
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import com.atelier_nyaarium.switchboard.proto.TeamAddress
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
	/** Short local name shown in the UI: the tail after the host qualifier. */
	val displayName: String get() = TeamAddress.parse(name, "").name

	/** Owning Host id (the segment before the qualifier), or "" for a bare name. */
	val host: String get() = TeamAddress.parse(name, "").host
}

data class SendResult(val ok: Boolean, val status: String, val error: String?)

/** A file the user picked to send. Bytes are base64-encoded onto the wire. */
data class OutgoingFile(val name: String, val mime: String, val bytes: ByteArray)

/** The owner enroll envelope: `enrollOp` (not `op`) routes to evie's enrollment
 * coordinator, which answers an EnrollResult directly instead of relaying to a
 * Host. */
@Serializable
private data class EnrollEnvelope(
	val device: String,
	val conversationId: String,
	val opId: String,
	val enrollOp: EnrollOp,
)

/** A retryable bounce body (offline / malformed), distinct from an EnrollResult. */
@Serializable
private data class BounceBody(val error: String? = null, val retryable: Boolean = false)

/** Decode posture for everything off the wire: unknown fields are tolerated
 * (additive protocol). Encode posture: the default config omits null-defaulted
 * optionals, which is exactly what the arbiter's schemas accept. */
internal val wireJson = Json { ignoreUnknownKeys = true }

/** Map a Crypto.SealedEnvelope to the proto.SealedEnvelope wire type. Fields
 * are identical by design; a small mapper avoids coupling the two class hierarchies. */
private fun Crypto.SealedEnvelope.toProto(): SealedEnvelope =
	SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)

/** Map a proto.SealedEnvelope to Crypto.SealedEnvelope for unseal calls. */
private fun SealedEnvelope.toCrypto(): Crypto.SealedEnvelope =
	Crypto.SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)

/** Talks to the phone bridge through the CA-pinned k8s API service-proxy. */
class PhoneClient(private val prov: Provisioning, private val store: ProvisioningStore) {
	private val client = buildPinnedClient(prov.caPem)
	private val proxyBase =
		"${prov.apiUrl}/api/v1/namespaces/${prov.namespace}/services/${prov.service}:${prov.port}/proxy"

	/** This phone's home Host id, learned at register and set by ChatRepository.
	 * Rides every relay so the Router routes to the right Host; null until learned. */
	@Volatile
	var homeHost: String? = null

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

	/** Resolve the phone identity from the store. Throws a clear error when the
	 * identity is absent (device not enrolled), so callers see "enroll first" rather
	 * than a NullPointerException. */
	private fun requirePhoneIdentity(): Crypto.Identity =
		store.loadIdentity() ?: error("This device is not enrolled. Scan evie's enroll-owner QR first.")

	/** Resolve host keys by id. On first boot homeHost is null; register resolves
	 * via the persisted host id so enrollment is a prerequisite, not an after-thought.
	 * Throws a clear "admit the host first" message when absent. */
	private fun requireHostKeys(hostId: String): ProvisioningStore.HostKeys =
		store.loadHostKeys(hostId)
			?: error("Home host \"$hostId\" is not admitted. Scan the host's QR code to admit it.")

	/** The host id to use for sealing, in priority order: (1) the live homeHost set
	 * after register, (2) the persisted host id from a previous session. Throws when
	 * neither is available (fresh install before any register or enrollment). */
	private fun resolveHostId(): String =
		homeHost?.takeIf { it.isNotEmpty() }
			?: store.loadHostId().takeIf { it.isNotEmpty() }
			?: error("Home host not yet known. Complete enrollment and connect first.")

	/** Build a sealed PhoneRelayFrame for one op. Called fresh for every send,
	 * including retries, so each attempt uses a new ephemeral/nonce and the
	 * server's replay guard never sees duplicate nonces. */
	private fun buildSealedFrame(
		op: PhoneOp,
		opId: String,
		identity: Crypto.Identity,
		hostBoxPub: String,
	): PhoneRelayFrame {
		val envelope = PhoneOpEnvelope(
			v = 1L,
			conversationId = prov.conversationId,
			device = prov.device,
			at = System.currentTimeMillis(),
			op = op,
		)
		val plaintext = wireJson.encodeToString(PhoneOpEnvelope.serializer(), envelope).toByteArray(Charsets.UTF_8)
		val cryptoEnv = Crypto.seal(plaintext, hostBoxPub, identity.sign.priv)
		return PhoneRelayFrame(
			v = 1L,
			opId = opId,
			signerSignPub = identity.sign.pub,
			sealed = cryptoEnv.toProto(),
		)
	}

	/** Unseal a reply envelope using the phone's box private key, verified against
	 * the home host's signing public key. */
	private fun unsealReply(sealed: SealedEnvelope, identity: Crypto.Identity, hostSignPub: String): PhoneReplyBody {
		val plain = Crypto.unseal(sealed.toCrypto(), identity.box.priv, hostSignPub)
		return wireJson.decodeFromString<PhoneReplyBody>(plain.toString(Charsets.UTF_8))
	}

	/** Send a phone op through the service-proxy to the phone bridge. Mutating ops
	 * pass their own stable opId so a retry after a lost reply replays the cached
	 * result server-side instead of running the op twice (the protocol contract).
	 * A held op (long-poll) passes a read timeout above its server-side hold.
	 *
	 * Every call builds a fresh sealed frame so retries produce a new ephemeral/nonce
	 * and the replay guard never rejects a legitimate retry. */
	private fun relay(op: PhoneOp, opId: String = UUID.randomUUID().toString(), readTimeoutMs: Long? = null): PhoneReplyBody {
		val identity = requirePhoneIdentity()
		val hostId = resolveHostId()
		val hostKeys = requireHostKeys(hostId)

		val frame = buildSealedFrame(op, opId, identity, hostKeys.boxPub)
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Android-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(PhoneRelayFrame.serializer(), frame).toRequestBody(JSON))
			.build()
		val callClient = if (readTimeoutMs != null) {
			client.newBuilder().readTimeout(readTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS).build()
		} else {
			client
		}
		callClient.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(500)}")
			val reply = wireJson.decodeFromString<PhoneRelayReply>(text)
			// Cleartext error path: phone not admitted or pre-seal failure; surface it
			// so the UI can prompt enrollment rather than showing a generic network error.
			if (reply.sealed == null) {
				error(reply.error ?: "relay error (no sealed payload)")
			}
			return unsealReply(reply.sealed, identity, hostKeys.signPub)
		}
	}

	/** Submit an owner enroll op directly to evie (the Domain root). evie answers
	 * with an EnrollResult, not a phone_relay_reply: enroll ops are evie-direct and
	 * never relayed to a Host, so they succeed even with no arbiter connected. A
	 * bounce (offline / 501 / malformed) is surfaced as a failed EnrollResult. */
	fun enroll(op: EnrollOp): EnrollResult {
		val envelope = EnrollEnvelope(prov.device, prov.conversationId, UUID.randomUUID().toString(), op)
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Android-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(EnrollEnvelope.serializer(), envelope).toRequestBody(JSON))
			.build()
		client.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			// 2xx: a real EnrollResult. A coordinator rejection is 400 with an
			// EnrollResult body; a transport bounce is {error, retryable}. Cross-check
			// the status so a non-2xx body is never read as a successful enroll.
			if (resp.isSuccessful) {
				return runCatching { wireJson.decodeFromString<EnrollResult>(text) }
					.getOrElse { EnrollResult(ok = false, error = "unexpected response (HTTP ${resp.code})") }
			}
			runCatching { wireJson.decodeFromString<EnrollResult>(text) }.getOrNull()?.let { return it }
			val err = runCatching { wireJson.decodeFromString<BounceBody>(text).error }.getOrNull()
			return EnrollResult(ok = false, error = err ?: "HTTP ${resp.code}")
		}
	}

	/** The reply's result payload decoded as T, or an error for a failed op. */
	private inline fun <reified T> resultOf(body: PhoneReplyBody, op: String): T {
		if (!body.ok) error("$op failed: ${body.error ?: "unknown error"}")
		val result = body.result ?: error("$op: no result")
		return wireJson.decodeFromJsonElement(result)
	}

	/** Claim this device's mailbox. Returns the starting cursor + epoch. Carries this
	 * build's identity so the arbiter logs which version/variant the phone runs. */
	fun register(): PhoneRegisterResult = resultOf(
		relay(
			PhoneOp.Register(
				clientVersion = "${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}",
				clientVariant = if (BuildConfig.DEBUG) "debug" else "release",
			),
		),
		"register",
	)

	/** List the bridge's sessions, each keyed by its host-qualified name. A
	 * session's Host comes from the wire (`TeamInfo.host`); when a pre-federation
	 * arbiter omits it, `localHostId` (this connection's Host, learned at register)
	 * is the fallback. Both empty leaves the name bare (single implicit Host). */
	fun teams(localHostId: String = ""): List<Team> {
		val body = relay(PhoneOp.ListTeams)
		// Surface a relay failure instead of blanking the board with an empty list; the
		// callers (connect, refreshTeams) wrap this in runCatching and keep the prior list.
		if (!body.ok || body.result == null) error("list_teams relay failed: ${body.error ?: "no result"}")
		val result =
			wireJson.decodeFromJsonElement<com.atelier_nyaarium.switchboard.proto.PhoneListTeamsResult>(body.result)
		return result.teams.map {
			val host = it.host?.ifEmpty { null } ?: localHostId
			Team(
				name = TeamAddress.parse(it.team, host).canonical,
				status = it.status,
				mode = it.mode ?: "",
				queueDepth = it.queue_depth.toInt(),
				kind = it.kind ?: "loose",
			)
		}
	}

	// teams() now throws on a relay failure; this convenience wrapper keeps its
	// list-returning contract (empty on failure) for any external caller.
	fun listTeams(): List<String> = runCatching { teams().map { it.name } }.getOrDefault(emptyList())

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
		val replyBody = relay(op, opId)
		val status = replyBody.result?.let {
			runCatching { wireJson.decodeFromJsonElement<PhoneSendResult>(it).status }.getOrNull()
		}
		return SendResult(ok = replyBody.ok, status = status.orEmpty(), error = replyBody.error)
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
		val body = relay(op, readTimeoutMs = if (holdMs > 0) holdMs + 18_000 else null)
		// A relay-level failure must SURFACE, not masquerade as a successful empty drain:
		// a fabricated empty (with epoch 0) hid outages from the health signal and forced
		// a spurious epoch flip on the next real poll. Throw so the poll loop's catch
		// counts the failure and shows the offline banner.
		if (!body.ok || body.result == null) error("poll relay failed: ${body.error ?: "no result"}")
		return wireJson.decodeFromJsonElement<PhonePollResult>(body.result)
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
