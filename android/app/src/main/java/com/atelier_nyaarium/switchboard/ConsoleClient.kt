package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.proto.ChannelFile
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeOp
import com.atelier_nyaarium.switchboard.proto.RosterRequest
import com.atelier_nyaarium.switchboard.proto.RosterResult
import com.atelier_nyaarium.switchboard.proto.TrustHandshakeOp
import com.atelier_nyaarium.switchboard.proto.TrustHandshakeResult
import com.atelier_nyaarium.switchboard.proto.TrustPendingRequest
import com.atelier_nyaarium.switchboard.proto.TrustPendingResult
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeRef
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeResult
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.EnrollResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleOpEnvelope
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import com.atelier_nyaarium.switchboard.proto.ConsolePollResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRegisterResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRelayFrame
import com.atelier_nyaarium.switchboard.proto.ConsoleRelayReply
import com.atelier_nyaarium.switchboard.proto.ConsoleReplyBody
import com.atelier_nyaarium.switchboard.proto.ConsoleSendResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainCancelResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainConfirmResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListPeersResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListSharesResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListenResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListenStateResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainRequestResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainShareResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget
import com.atelier_nyaarium.switchboard.proto.CrossDomainUnlinkResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainUnshareResult
import com.atelier_nyaarium.switchboard.proto.PendingTenantRef
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import com.atelier_nyaarium.switchboard.proto.SignedFirstRoot
import com.atelier_nyaarium.switchboard.proto.SignedProvisionTenant
import com.atelier_nyaarium.switchboard.proto.SignedRemoveTenant
import com.atelier_nyaarium.switchboard.proto.SignedSetDisplayName
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLink
import com.atelier_nyaarium.switchboard.proto.TeamAddress
import com.atelier_nyaarium.switchboard.proto.TransportRequest
import com.atelier_nyaarium.switchboard.proto.TransportResult
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
 * Credential blob the console holds (pasted once). Reaches the console bridge through
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
	/** Present on a friend INVITE blob: the pending Domain id + the one-time invite nonce the
	 * app first-roots with. Absent on an ordinary (already-rooted) admin blob, which just
	 * provisions the console. The presence of this field IS what distinguishes the two paths. */
	val pendingTenant: PendingTenantRef? = null,
	/** Present on a friend ENROLL invite blob (alongside pendingTenant): the admin's owner keys +
	 * Domain and the handshakeId + pin that seed the in-person FLOW-1 trust compare. The enrollee's
	 * app reads it after first-rooting to run the ceremony as ENROLLEE. Absent on a plain invite. */
	val enrollHandshake: EnrollHandshakeRef? = null,
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
				service = p.service ?: "evie-console-bridge",
				port = p.port?.toInt() ?: 20004,
				device = p.device ?: (android.os.Build.MODEL ?: "android"),
				conversationId = p.conversationId ?: UUID.randomUUID().toString(),
				pendingTenant = p.pendingTenant,
				enrollHandshake = p.enrollHandshake,
			)
		}
	}
}

/** UI model for the sessions board. Mapped one-to-one from the wire TeamInfo in
 * `teams()`; also constructed locally for ended threads whose team has left the
 * bridge (a state that never exists on the wire). `name` is the gateway-qualified
 * composite key (`gateway/local`); `displayName`/`gatewayId` derive from it. */
data class Team(
	val name: String,
	val status: String,
	val mode: String,
	val queueDepth: Int,
	val kind: String = "loose",
	// Plugin version the agent's MCP process reported. Null for consoles, offline
	// catalog entries, and pre-feature gateways. The board shows it only when it
	// differs from this app's own expected version.
	val version: String? = null,
	// The owning Gateway's Domain id (a separate typed field, NOT folded into `name`:
	// the gateway/name address grammar stays two-part, so the Domain never aliases as
	// a third segment). A gateway id is unique only within a Domain, so the board groups
	// by the (domainId, gatewayId) pair and a cross-Domain (peer) group is shown under
	// its Domain. Null for a pre-federation Gateway and for the locally-synthesized ended
	// session (it has no live wire record).
	val domainId: String? = null,
	// The owning Domain's display name, stamped by the gateway's discover for both local
	// and peer sessions. The Peers list shows this instead of the opaque domainId. Null for a
	// pre-feature gateway or a Domain that has not set a name yet.
	val displayName: String? = null,
	// True when the owning Domain is the admin's own (the evie-runner who provisions others), from
	// the register reply via the gateway. The local session's value gates the admin surfaces.
	val isAdminDomain: Boolean = false,
) {
	/** Short local name shown in the UI: the tail after the gateway qualifier. */
	val shortName: String get() = TeamAddress.parse(name, "").name

	/** Owning Gateway id (the segment before the qualifier), or "" for a bare name. */
	val gatewayId: String get() = TeamAddress.parse(name, "").gatewayId
}

data class SendResult(val ok: Boolean, val status: String, val error: String?)

/** A file the user picked to send. Bytes are base64-encoded onto the wire. */
data class OutgoingFile(val name: String, val mime: String, val bytes: ByteArray)

/** The owner enroll envelope: `enrollOp` (not `op`) routes to evie's enrollment
 * coordinator, which answers an EnrollResult directly instead of relaying to a
 * Gateway. */
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

/** The first-root POST body: a top-level `firstRoot` field routes to evie's console-bridge
 * firstRoot intake (decided AT evie, never relayed to a Gateway), the symmetric twin of
 * `enrollOp` routing to the enrollment coordinator. */
@Serializable
private data class FirstRootEnvelope(val firstRoot: SignedFirstRoot)

/** The enroll-handshake POST body: a top-level `enrollHandshake` field routes to evie's
 * console-bridge enroll-handshake broker (a dumb relay, never to a Gateway), the twin of
 * `firstRoot` routing. */
@Serializable
private data class EnrollHandshakeEnvelope(val enrollHandshake: EnrollHandshakeOp)

/** The roster POST body: a top-level `roster` field routes to evie's cross-tenant roster handler
 * (answered AT evie, which aggregates across Domains a gateway cannot see), the twin of `firstRoot`
 * routing. */
@Serializable
private data class RosterEnvelope(val roster: RosterRequest)

/** The transport-request POST body: a top-level `transport` field routes to evie's console-bridge
 * transport intake (answered AT evie, which holds the gateway-bridge Secret), the twin of `firstRoot`
 * routing. */
@Serializable
private data class TransportEnvelope(val transport: TransportRequest)

/** The FLOW-2 trust-rendezvous POST bodies: top-level fields routing to evie's trust broker / pending
 * query (the twins of `roster` routing). */
@Serializable
private data class TrustHandshakeEnvelope(val trustHandshake: TrustHandshakeOp)

@Serializable
private data class TrustPendingEnvelope(val trustPending: TrustPendingRequest)

/** evie's reply to a provision_tenant enroll op. Mirrors EnrollResult but also carries the
 * minted one-time invite `nonce` (the admin's app builds the friend's QR from it). The wire
 * EnrollResult schema omits `nonce`, so this is a local richer decode (ignoreUnknownKeys keeps
 * it forward-compatible). */
@Serializable
data class ProvisionTenantResult(val ok: Boolean, val error: String? = null, val nonce: String? = null)

/** Decode posture for everything off the wire: unknown fields are tolerated
 * (additive protocol). Encode posture: the default config omits null-defaulted
 * optionals, which is exactly what the gateway's schemas accept. */
internal val wireJson = Json { ignoreUnknownKeys = true }

/** Map a Crypto.SealedEnvelope to the proto.SealedEnvelope wire type. Fields
 * are identical by design; a small mapper avoids coupling the two class hierarchies. */
private fun Crypto.SealedEnvelope.toProto(): SealedEnvelope =
	SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)

/** Map a proto.SealedEnvelope to Crypto.SealedEnvelope for unseal calls. */
private fun SealedEnvelope.toCrypto(): Crypto.SealedEnvelope =
	Crypto.SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)

/** Talks to the console bridge through the CA-pinned k8s API service-proxy. */
class ConsoleClient(private val prov: Provisioning, private val store: ProvisioningStore) {
	private val client = buildPinnedClient(prov.caPem)
	private val proxyBase =
		"${prov.apiUrl}/api/v1/namespaces/${prov.namespace}/services/${prov.service}:${prov.port}/proxy"

	/** This console's route Gateway id, learned at register and set by ChatRepository.
	 * Rides every relay so the Gateway routes to the right Gateway; null until learned. */
	@Volatile
	var routeGateway: String? = null

	/**
	 * CA-pinned preflight of the ACTUAL transport: the console-bridge liveness probe through the API
	 * service-proxy. Proves TLS pinning, reachability, and SA auth on the same path the real ops use.
	 *
	 * It must NOT hit a raw cluster endpoint like `get namespace`: the console SA
	 * (console-bridge-proxy) is scoped to the service-proxy verb only, so a namespace GET 403s and
	 * would (and did) strand every connect before the admission submit, leaving the console forever
	 * "not admitted". /health needs no app token, so a failure here means the cluster/tunnel is down,
	 * cleanly separated from "the bridge rejected our creds".
	 */
	fun apiReachable(): String {
		val req = Request.Builder()
			.url("$proxyBase/health")
			.header("Authorization", "Bearer ${prov.saToken}")
			.get()
			.build()
		client.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(300)}")
			return "reachable (HTTP ${resp.code})"
		}
	}

	/** Resolve the console identity from the store. An ABSENT identity means the device is not
	 * provisioned (re-provision hint); a CORRUPT one means present-but-unreadable bytes, which a
	 * re-provision will not fix without a restore - so the two surface DISTINCT terminal causes
	 * instead of one ambiguous "not enrolled". Never mints here: enrollment owns minting. */
	private fun requireConsoleIdentity(): Crypto.Identity =
		when (val load = store.loadIdentity()) {
			is IdentityLoad.Loaded -> load.identity
			IdentityLoad.Absent -> error("This device is not enrolled. Re-run provision-admin-domain.sh and re-import the setup blob.")
			IdentityLoad.Corrupt -> error("identity corrupt - the stored console key did not decode; restore from backup or re-run provision-admin-domain.sh")
		}

	/** Resolve a Gateway's keys from the owner-rooted keyring, verifying its admission
	 * before sealing to it. This is the device side of symmetric trust: the Console
	 * seals to a Gateway because the owner admitted that Gateway's keys, never because a
	 * provisioning blob named them. A Gateway absent from the keyring is a terminal gap
	 * (admit it), worded with "not in the keyring" so it cannot collide with the
	 * server-side "is not admitted to the Domain" sync-lag token. */
	private fun requireGatewayKeys(gatewayId: String): ProvisioningStore.GatewayKeys {
		val keyring = Keyring.parse(store.loadDomain()) ?: error("Gateway \"$gatewayId\" is not in the keyring.")
		val admission = keyring.resolveGateway(gatewayId) ?: error("Gateway \"$gatewayId\" is not in the keyring.")
		return ProvisioningStore.GatewayKeys(admission.signPub, admission.boxPub)
	}

	/** The Gateway id to use for sealing, in priority order: (1) the live routeGateway set
	 * after register, (2) the persisted Gateway id from a previous session. Throws when
	 * neither is available - a fresh install before the owner has admitted any Gateway, where
	 * the fix is to admit one (not re-provision); the "no gateway admitted" token routes the
	 * banner to that guidance. */
	private fun resolveGatewayId(): String =
		routeGateway?.takeIf { it.isNotEmpty() }
			?: store.loadGatewayId().takeIf { it.isNotEmpty() }
			?: error("No Gateway admitted yet - add one from Manage Gateways.")

	/** Build a sealed ConsoleRelayFrame for one op. Called fresh for every send,
	 * including retries, so each attempt uses a new ephemeral/nonce and the
	 * server's replay guard never sees duplicate nonces. */
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

	/** Send a console op through the service-proxy to the console bridge. Mutating ops
	 * pass their own stable opId so a retry after a lost reply replays the cached
	 * result server-side instead of running the op twice (the protocol contract).
	 * A held op (long-poll) passes a read timeout above its server-side hold.
	 *
	 * Every call builds a fresh sealed frame so retries produce a new ephemeral/nonce
	 * and the replay guard never rejects a legitimate retry. */
	private fun relay(
		op: ConsoleOp,
		opId: String = UUID.randomUUID().toString(),
		readTimeoutMs: Long? = null,
		targetGateway: String? = null,
	): ConsoleReplyBody {
		val identity = requireConsoleIdentity()
		// Direct multi-gateway: an op seals to the Gateway hosting its session (resolved from
		// the keyring), naming it so evie routes there. Register/poll/list default to the
		// route Gateway.
		val gatewayId = targetGateway?.takeIf { it.isNotEmpty() } ?: resolveGatewayId()
		val hostKeys = requireGatewayKeys(gatewayId)

		val frame = buildSealedFrame(op, opId, identity, gatewayId, hostKeys.boxPub)
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(ConsoleRelayFrame.serializer(), frame).toRequestBody(JSON))
			.build()
		val callClient = if (readTimeoutMs != null) {
			client.newBuilder().readTimeout(readTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS).build()
		} else {
			client
		}
		callClient.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(500)}")
			val reply = wireJson.decodeFromString<ConsoleRelayReply>(text)
			// Cleartext error path: console not admitted or pre-seal failure; surface it
			// so the UI can prompt enrollment rather than showing a generic network error.
			if (reply.sealed == null) {
				error(reply.error ?: "relay error (no sealed payload)")
			}
			return unsealReply(reply.sealed, identity, hostKeys.signPub)
		}
	}

	/** Submit an owner enroll op directly to evie (the Domain root). evie answers
	 * with an EnrollResult, not a console_relay_reply: enroll ops are evie-direct and
	 * never relayed to a Gateway, so they succeed even with no gateway connected. A
	 * bounce (offline / 501 / malformed) is surfaced as a failed EnrollResult. */
	fun enroll(op: EnrollOp): EnrollResult {
		val envelope = EnrollEnvelope(prov.device, prov.conversationId, UUID.randomUUID().toString(), op)
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(EnrollEnvelope.serializer(), envelope).toRequestBody(JSON))
			.build()
		// DEBUG trace: the exact URL the device POSTs to, plus the outcome. A transport throw means
		// the device cannot reach evie's console-bridge at all (the trace then survives only in the
		// on-device file); an HTTP code means it reached evie, so this is the coordinator's verdict.
		DebugLog.log("Enroll", "POST $proxyBase/relay op=${op::class.simpleName}")
		val resp =
			try {
				client.newCall(req).execute()
			} catch (e: Exception) {
				DebugLog.log("Enroll", "transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
				throw e
			}
		resp.use {
			val text = resp.body?.string().orEmpty()
			DebugLog.log("Enroll", "resp HTTP ${resp.code} ${text.take(120)}")
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

	/** First-root a PENDING friend Domain at this device's silently-generated owner key. evie
	 * decides it directly (self-signed frame + one-time invite nonce), with no gateway and no
	 * admission, so it works before any Gateway is admitted. evie answers with an EnrollResult
	 * (2xx ok, 400 reject, e.g. an expired or already-claimed invite). A reject is NOT retryable
	 * (the root was decided), so the caller surfaces the message rather than spinning. */
	fun firstRoot(signed: SignedFirstRoot): EnrollResult {
		val envelope = FirstRootEnvelope(signed)
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(FirstRootEnvelope.serializer(), envelope).toRequestBody(JSON))
			.build()
		DebugLog.log("FirstRoot", "POST $proxyBase/relay domain=${signed.firstRoot.domainId}")
		val resp =
			try {
				client.newCall(req).execute()
			} catch (e: Exception) {
				DebugLog.log("FirstRoot", "transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
				throw e
			}
		resp.use {
			val text = resp.body?.string().orEmpty()
			DebugLog.log("FirstRoot", "resp HTTP ${resp.code} ${text.take(160)}")
			if (resp.isSuccessful) {
				return runCatching { wireJson.decodeFromString<EnrollResult>(text) }
					.getOrElse { EnrollResult(ok = false, error = "unexpected response (HTTP ${resp.code})") }
			}
			runCatching { wireJson.decodeFromString<EnrollResult>(text) }.getOrNull()?.let { return it }
			val err = runCatching { wireJson.decodeFromString<BounceBody>(text).error }.getOrNull()
			return EnrollResult(ok = false, error = err ?: "HTTP ${resp.code}")
		}
	}

	/** Pull this owner's network gateway-bridge transport (the proxy SA token + CA) from evie. POST
	 * { transport } evie-direct, like firstRoot - evie holds the gateway-bridge Secret and answers
	 * itself, scoping by the request's signed owner proof. ok=false is an opaque reject (bad proof or
	 * not a rooted owner); a transport bounce maps to ok=false too. The Console seals the returned creds
	 * into a bootstrap bundle for a creds-less Gateway it is enrolling. */
	fun requestGatewayTransport(req: TransportRequest): TransportResult {
		val request = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(TransportEnvelope.serializer(), TransportEnvelope(req)).toRequestBody(JSON))
			.build()
		val resp =
			try {
				client.newCall(request).execute()
			} catch (e: Exception) {
				DebugLog.log("Transport", "transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
				throw e
			}
		resp.use {
			val text = resp.body?.string().orEmpty()
			DebugLog.log("Transport", "resp HTTP ${resp.code} ${text.take(160)}")
			if (resp.isSuccessful) {
				return runCatching { wireJson.decodeFromString<TransportResult>(text) }
					.getOrElse { TransportResult(ok = false, error = "unexpected response (HTTP ${resp.code})") }
			}
			runCatching { wireJson.decodeFromString<TransportResult>(text) }.getOrNull()?.let { return it }
			val err = runCatching { wireJson.decodeFromString<BounceBody>(text).error }.getOrNull()
			return TransportResult(ok = false, error = err ?: "HTTP ${resp.code}")
		}
	}

	/** Drive one enroll-handshake frame through evie's broker (POST { enrollHandshake }). evie relays
	 * the peer's frame back (or pending); the phone computes the SAS locally. Pre-admission like
	 * firstRoot - the fresh enrollee has no admission. A terminal failure is ok=false + error; ok=true
	 * with the peer frame absent means keep polling (re-send the same step). */
	fun enrollHandshake(op: EnrollHandshakeOp): EnrollHandshakeResult {
		val envelope = EnrollHandshakeEnvelope(op)
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(EnrollHandshakeEnvelope.serializer(), envelope).toRequestBody(JSON))
			.build()
		DebugLog.log("EnrollHs", "POST $proxyBase/relay step=${op::class.simpleName}")
		val resp =
			try {
				client.newCall(req).execute()
			} catch (e: Exception) {
				DebugLog.log("EnrollHs", "transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
				throw e
			}
		resp.use {
			val text = resp.body?.string().orEmpty()
			DebugLog.log("EnrollHs", "resp HTTP ${resp.code} ${text.take(160)}")
			if (resp.isSuccessful) {
				return runCatching { wireJson.decodeFromString<EnrollHandshakeResult>(text) }
					.getOrElse { EnrollHandshakeResult(ok = false, error = "unexpected response (HTTP ${resp.code})") }
			}
			runCatching { wireJson.decodeFromString<EnrollHandshakeResult>(text) }.getOrNull()?.let { return it }
			val err = runCatching { wireJson.decodeFromString<BounceBody>(text).error }.getOrNull()
			return EnrollHandshakeResult(ok = false, error = err ?: "HTTP ${resp.code}")
		}
	}

	/** Fetch the cross-tenant roster (the Users surface) from evie. POST { roster } evie-direct, like
	 * firstRoot - evie aggregates across Domains a gateway cannot see and answers itself. The request
	 * carries the console's signed ROSTER proof; a non-member comes back ok=false (opaque). */
	fun roster(req: RosterRequest): RosterResult {
		val request = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(RosterEnvelope.serializer(), RosterEnvelope(req)).toRequestBody(JSON))
			.build()
		val resp =
			try {
				client.newCall(request).execute()
			} catch (e: Exception) {
				DebugLog.log("Roster", "transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
				throw e
			}
		resp.use {
			val text = resp.body?.string().orEmpty()
			DebugLog.log("Roster", "resp HTTP ${resp.code} ${text.take(160)}")
			if (resp.isSuccessful) {
				return runCatching { wireJson.decodeFromString<RosterResult>(text) }
					.getOrElse { RosterResult(ok = false, error = "unexpected response (HTTP ${resp.code})") }
			}
			runCatching { wireJson.decodeFromString<RosterResult>(text) }.getOrNull()?.let { return it }
			val err = runCatching { wireJson.decodeFromString<BounceBody>(text).error }.getOrNull()
			return RosterResult(ok = false, error = err ?: "HTTP ${resp.code}")
		}
	}

	/** Broker a FLOW-2 trust-rendezvous frame (arm/join/reveal/cancel) at evie. POST { trustHandshake }
	 * evie-direct (the dumb broker; no sealing, like the enroll handshake). */
	fun trustHandshake(op: TrustHandshakeOp): TrustHandshakeResult {
		val request = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
			.post(
				wireJson.encodeToString(TrustHandshakeEnvelope.serializer(), TrustHandshakeEnvelope(op)).toRequestBody(JSON),
			)
			.build()
		val resp =
			try {
				client.newCall(request).execute()
			} catch (e: Exception) {
				DebugLog.log("Trust", "handshake transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
				throw e
			}
		resp.use {
			val text = resp.body?.string().orEmpty()
			DebugLog.log("Trust", "handshake HTTP ${resp.code} ${text.take(160)}")
			if (resp.isSuccessful) {
				return runCatching { wireJson.decodeFromString<TrustHandshakeResult>(text) }
					.getOrElse { TrustHandshakeResult(ok = false, error = "unexpected response (HTTP ${resp.code})") }
			}
			runCatching { wireJson.decodeFromString<TrustHandshakeResult>(text) }.getOrNull()?.let { return it }
			val err = runCatching { wireJson.decodeFromString<BounceBody>(text).error }.getOrNull()
			return TrustHandshakeResult(ok = false, error = err ?: "HTTP ${resp.code}")
		}
	}

	/** Query "who armed trust toward me?" at evie (the highlight). POST { trustPending } with the
	 * owner-signed proof; evie returns the armed rendezvous indexed under this owner key. */
	fun trustPending(req: TrustPendingRequest): TrustPendingResult {
		val request = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
			.post(
				wireJson.encodeToString(TrustPendingEnvelope.serializer(), TrustPendingEnvelope(req)).toRequestBody(JSON),
			)
			.build()
		val resp =
			try {
				client.newCall(request).execute()
			} catch (e: Exception) {
				DebugLog.log("Trust", "pending transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
				throw e
			}
		resp.use {
			val text = resp.body?.string().orEmpty()
			DebugLog.log("Trust", "pending HTTP ${resp.code} ${text.take(160)}")
			if (resp.isSuccessful) {
				return runCatching { wireJson.decodeFromString<TrustPendingResult>(text) }
					.getOrElse { TrustPendingResult(ok = false, error = "unexpected response (HTTP ${resp.code})") }
			}
			runCatching { wireJson.decodeFromString<TrustPendingResult>(text) }.getOrNull()?.let { return it }
			val err = runCatching { wireJson.decodeFromString<BounceBody>(text).error }.getOrNull()
			return TrustPendingResult(ok = false, error = err ?: "HTTP ${resp.code}")
		}
	}

	/** Submit an admin-signed provision_tenant enroll op and decode the minted one-time invite
	 * nonce evie returns (the admin's app builds the friend's QR from it). Same evie-direct path
	 * as enroll(); the only difference is the richer result decode (the wire EnrollResult omits the
	 * nonce, so this reads it directly). */
	fun provisionTenant(signed: SignedProvisionTenant): ProvisionTenantResult {
		val envelope = EnrollEnvelope(prov.device, prov.conversationId, UUID.randomUUID().toString(), EnrollOp.ProvisionTenant(signed))
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(EnrollEnvelope.serializer(), envelope).toRequestBody(JSON))
			.build()
		DebugLog.log("Enroll", "POST $proxyBase/relay op=ProvisionTenant")
		client.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			DebugLog.log("Enroll", "provision resp HTTP ${resp.code} ${text.take(120)}")
			if (resp.isSuccessful) {
				return runCatching { wireJson.decodeFromString<ProvisionTenantResult>(text) }
					.getOrElse { ProvisionTenantResult(ok = false, error = "unexpected response (HTTP ${resp.code})") }
			}
			runCatching { wireJson.decodeFromString<ProvisionTenantResult>(text) }.getOrNull()?.let { return it }
			val err = runCatching { wireJson.decodeFromString<BounceBody>(text).error }.getOrNull()
			return ProvisionTenantResult(ok = false, error = err ?: "HTTP ${resp.code}")
		}
	}

	/** The reply's result payload decoded as T, or an error for a failed op. */
	private inline fun <reified T> resultOf(body: ConsoleReplyBody, op: String): T {
		if (!body.ok) error("$op failed: ${body.error ?: "unknown error"}")
		val result = body.result ?: error("$op: no result")
		return wireJson.decodeFromJsonElement(result)
	}

	/** Claim this device's mailbox. Returns the starting cursor + epoch. Carries this
	 * build's identity so the gateway logs which version/variant the console runs. */
	fun register(): ConsoleRegisterResult = resultOf(
		relay(
			ConsoleOp.Register(
				clientVersion = "${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}",
				clientVariant = if (BuildConfig.DEBUG) "debug" else "release",
			),
		),
		"register",
	)

	/** List the bridge's sessions, each keyed by its gateway-qualified name. A
	 * session's Gateway comes from the wire (`TeamInfo.gatewayId`, always stamped); an
	 * empty value falls back to `localGatewayId` (this connection's Gateway, learned at
	 * register) and leaves the name bare (single implicit Gateway). */
	fun teams(localGatewayId: String = ""): List<Team> {
		val body = relay(ConsoleOp.ListTeams)
		// Surface a relay failure instead of blanking the board with an empty list; the
		// callers (connect, refreshTeams) wrap this in runCatching and keep the prior list.
		if (!body.ok || body.result == null) error("list_teams relay failed: ${body.error ?: "no result"}")
		val result =
			wireJson.decodeFromJsonElement<com.atelier_nyaarium.switchboard.proto.ConsoleListTeamsResult>(body.result)
		return result.teams.map {
			val gatewayId = it.gatewayId.ifEmpty { localGatewayId }
			Team(
				name = TeamAddress.parse(it.team, gatewayId).canonical,
				status = it.status,
				mode = it.mode ?: "",
				queueDepth = it.queue_depth.toInt(),
				kind = it.kind,
				version = it.version,
				domainId = it.domainId,
				displayName = it.displayName,
				isAdminDomain = it.isAdminDomain ?: false,
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
		domainId: String? = null,
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
		// Carry the selected session's Domain so the Gateway resolves a cross-Domain seal target
		// by the full (domainId, gatewayId) pair; null/local keeps the existing local resolution.
		val crossDomain = domainId?.ifEmpty { null }
		val op = ConsoleOp.Send(to = to, domainId = crossDomain, body = body, files = wireFiles.ifEmpty { null })
		// A same-Domain send seals directly to the Gateway hosting the target team (a bare name
		// resolves to the local Gateway), so a cross-Gateway send goes E2E to that Gateway. A CROSS-Domain send
		// must instead seal to the LOCAL Domain: the friend Gateway's keys are not in this owner's keyring (it
		// is a separate Domain), so the local Gateway opens the op and relays it on to the friend over the mesh.
		val local = routeGateway?.takeIf { it.isNotEmpty() } ?: store.loadGatewayId()
		val target = if (crossDomain != null) local else TeamAddress.parse(to, local).gatewayId
		val replyBody = relay(op, opId, targetGateway = target)
		val status = replyBody.result?.let {
			runCatching { wireJson.decodeFromJsonElement<ConsoleSendResult>(it).status }.getOrNull()
		}
		return SendResult(ok = replyBody.ok, status = status.orEmpty(), error = replyBody.error)
	}

	/** Drain new mailbox entries since cursor (epoch-gated). With holdMs > 0 the
	 * server long-polls: an empty mailbox holds the request open until a message
	 * arrives or the hold expires, so delivery is near-instant at ~1 request per
	 * hold window instead of constant fast polling. */
	fun poll(cursor: Long, epoch: Long, holdMs: Long = 0): ConsolePollResult {
		// Carry the synced keyring version so the route Gateway returns the snapshot only when
		// it changed (a revocation made elsewhere reaches this Console within one cycle).
		val knownVersion = store.loadDomainVersion().ifEmpty { null }
		val op = ConsoleOp.Poll(
			cursor = cursor,
			epoch = epoch,
			holdMs = if (holdMs > 0) holdMs else null,
			knownDomainVersion = knownVersion,
		)
		// Ordered timeout chain for a held poll: gateway replies by holdMs (40s),
		// evie's relay hold fires at 55s if the gateway vanished, this read timeout
		// at holdMs+18s (58s) catches a vanished evie, and the apiserver proxy's
		// 60s outranks them all. Each failure layer returns before the next races it.
		val body = relay(op, readTimeoutMs = if (holdMs > 0) holdMs + 18_000 else null)
		// A relay-level failure must SURFACE, not masquerade as a successful empty drain:
		// a fabricated empty (with epoch 0) hid outages from the health signal and forced
		// a spurious epoch flip on the next real poll. Throw so the poll loop's catch
		// counts the failure and shows the offline banner.
		if (!body.ok || body.result == null) error("poll relay failed: ${body.error ?: "no result"}")
		return wireJson.decodeFromJsonElement<ConsolePollResult>(body.result)
	}

	/** The Gateway that hosts a target session (a bare name resolves to the local Gateway), so a peek/send
	 * seals E2E to that Gateway. Mirrors send(). */
	private fun targetGatewayOf(target: String): String =
		TeamAddress.parse(target, routeGateway?.takeIf { it.isNotEmpty() } ?: store.loadGatewayId()).gatewayId

	/** Capture the target's visible tmux pane for the terminal view. Pass the last hash so the
	 * Gateway returns unchanged=true (no ansi) for an idle pane. */
	fun peek(target: String, sinceHash: String? = null): ConsolePeekResult =
		resultOf(relay(ConsoleOp.Peek(target = target, sinceHash = sinceHash), targetGateway = targetGatewayOf(target)), "peek")

	/** Send literal text (submitted with Enter) OR a named control key to the target's tmux pane.
	 * Idempotent per opId (the host replays a re-relayed send instead of re-injecting). */
	fun tmuxSend(target: String, text: String? = null, key: String? = null, opId: String = UUID.randomUUID().toString()) {
		val body = relay(ConsoleOp.TmuxSend(target = target, text = text, key = key), opId, targetGateway = targetGatewayOf(target))
		if (!body.ok) error("tmux_send failed: ${body.error ?: "unknown error"}")
	}

	////////////////////////////////
	//  Cross-Domain trust ops
	//
	//  Thin convenience wrappers over the same seal/relay/poll path as the ops above. All
	//  default to the ROUTE Gateway: the cross-Domain handshake coordinator, the per-session
	//  share state, and the unlink cleanup all run on this owner's own Gateway (the friend
	//  Gateway is reached through the mesh, not sealed to directly). The reads (list/listen)
	//  run fresh; the mutating ops carry a stable opId so a lost-reply retry replays the cached
	//  result server-side rather than re-running, exactly like send/tmux_send.

	/** RECEIVER: open a listening window. Returns the short token to read to the friend plus
	 * this Gateway's keys (for the SAS) and the window's expiry. */
	fun crossDomainListen(): CrossDomainListenResult =
		resultOf(relay(ConsoleOp.CrossDomainListen), "cross_domain_listen")

	/** REQUESTER: pair against the friend's listening token. The Gateway runs the full
	 * commit-reveal exchange and returns the 6-digit SAS plus both sides' keys. */
	fun crossDomainRequest(
		listeningToken: String,
		pin: String,
		requesterOwnerSignPub: String,
		requesterDomainId: String,
		requesterGatewayId: String,
		opId: String = UUID.randomUUID().toString(),
	): CrossDomainRequestResult =
		resultOf(
			relay(
				ConsoleOp.CrossDomainRequest(
					listeningToken = listeningToken,
					pin = pin,
					requesterOwnerSignPub = requesterOwnerSignPub,
					requesterDomainId = requesterDomainId,
					requesterGatewayId = requesterGatewayId,
				),
				opId,
			),
			"cross_domain_request",
		)

	/** EITHER ROLE: confirm the SAS match. Each owner confirms INDEPENDENTLY, submitting only its
	 * OWN signed link side (binding the friend keys from the SAS-verified pairing); the Gateway
	 * verifies it under this owner's key and writes the cross-Domain peer. No friend-link exchange. */
	fun crossDomainConfirm(
		pin: String,
		mySignedLink: SignedXDomainLink,
		opId: String = UUID.randomUUID().toString(),
	): CrossDomainConfirmResult =
		resultOf(
			relay(ConsoleOp.CrossDomainConfirm(pin = pin, mySignedLink = mySignedLink), opId),
			"cross_domain_confirm",
		)

	/** RECEIVER: poll the listening window's pairing state. Before a pairing arrives this reports
	 * pairingArrived=false; once the requester's exchange lands, it carries the SAS + the friend's
	 * keys the receiver phone owner-signs its link over. A fresh read each call (never cached). */
	fun crossDomainListenState(listeningToken: String): CrossDomainListenStateResult =
		resultOf(relay(ConsoleOp.CrossDomainListenState(listeningToken = listeningToken)), "cross_domain_listen_state")

	/** EITHER ROLE: cancel a listening window (receiver token) and/or a pending pairing (pin)
	 * when the owner leaves the pairing screen, so a stale request cannot complete. */
	fun crossDomainCancel(listeningToken: String? = null, pin: String? = null): CrossDomainCancelResult =
		resultOf(relay(ConsoleOp.CrossDomainCancel(listeningToken = listeningToken, pin = pin)), "cross_domain_cancel")

	/** Mark a local session shared to an audience (a linked friend Domain, or everyone trusted). */
	fun crossDomainShare(
		sessionTarget: String,
		target: CrossDomainShareTarget,
		opId: String = UUID.randomUUID().toString(),
	): CrossDomainShareResult =
		resultOf(relay(ConsoleOp.CrossDomainShare(sessionTarget = sessionTarget, target = target), opId), "cross_domain_share")

	/** Withdraw a local session's share from an audience. */
	fun crossDomainUnshare(
		sessionTarget: String,
		target: CrossDomainShareTarget,
		opId: String = UUID.randomUUID().toString(),
	): CrossDomainUnshareResult =
		resultOf(
			relay(ConsoleOp.CrossDomainUnshare(sessionTarget = sessionTarget, target = target), opId),
			"cross_domain_unshare",
		)

	/** This owner's current shares, so the UI can render the per-session checkmarks. */
	fun crossDomainListShares(): CrossDomainListSharesResult =
		resultOf(relay(ConsoleOp.CrossDomainListShares), "cross_domain_list_shares")

	/** The linked friend Domains from the route Gateway's cross-Domain peer set, so a just-linked
	 * peer is visible (and its detail reachable) before any of its sessions surface in discovery. A
	 * fresh read each call (never cached). */
	fun crossDomainListPeers(): CrossDomainListPeersResult =
		resultOf(relay(ConsoleOp.CrossDomainListPeers), "cross_domain_list_peers")

	/** Unlink a friend Domain: drop the local trust + share state for it. */
	fun crossDomainUnlink(domainId: String, opId: String = UUID.randomUUID().toString()): CrossDomainUnlinkResult =
		resultOf(relay(ConsoleOp.CrossDomainUnlink(domainId = domainId), opId), "cross_domain_unlink")

	/** Untrust a PERSON by owner key: drop the local peer + share state for every Domain they own. */
	fun crossDomainUntrust(ownerSignPub: String, opId: String = UUID.randomUUID().toString()): CrossDomainUnlinkResult =
		resultOf(relay(ConsoleOp.CrossDomainUntrust(ownerSignPub = ownerSignPub), opId), "cross_domain_untrust")

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
			// The relay holds a send op server-side for up to 25s (the gateway's
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
