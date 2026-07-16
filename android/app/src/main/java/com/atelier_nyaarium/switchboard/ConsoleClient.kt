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
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalOp
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalResult
import com.atelier_nyaarium.switchboard.proto.ConsoleCreateSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleOpEnvelope
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRenameSessionResult
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
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.LOCAL_DOMAIN_SENTINEL
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.composeSessionName
import com.atelier_nyaarium.switchboard.proto.parseSessionName
import com.atelier_nyaarium.switchboard.proto.parseTarget
import com.atelier_nyaarium.switchboard.proto.TransportRequest
import com.atelier_nyaarium.switchboard.proto.TransportResult
import java.io.ByteArrayInputStream
import java.io.IOException
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.util.UUID
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Credential blob the console holds. Reaches the console bridge through the k8s API
 * service-proxy: the SA token authenticates to the API server, the app token (a separate
 * forwarded header) authenticates to evie.
 *
 * Thin wrapper over the generated proto.Provisioning wire shape, adding the runtime
 * behavior a schema cannot express: device defaulting to Build.MODEL, conversationId
 * minting a UUID, trailing-slash URL normalization, the service-proxy defaults.
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
	/** Present on a friend invite blob: the pending Domain id + one-time invite nonce the app
	 * first-roots with. Its presence is what distinguishes an invite from an already-rooted admin blob. */
	val pendingTenant: PendingTenantRef? = null,
	/** Present alongside pendingTenant on an enroll invite: the admin's owner keys + Domain and the
	 * handshakeId + pin seeding the in-person trust compare. The enrollee reads it after first-rooting
	 * to run the ceremony as enrollee. */
	val enrollHandshake: EnrollHandshakeRef? = null,
	/** evie's public nonce-gated device-approval ingress. A held device stamps it into the
	 * authorize-console QR so a fresh device can reach evie with no creds; absent means this network
	 * has no public ingress and the Add-a-device entry is disabled. */
	val deviceApprovalReach: String? = null,
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
				deviceApprovalReach = p.deviceApprovalReach?.trimEnd('/'),
			)
		}
	}
}

/** The local team field (`spawn` or `spawn.session`) of a canonical address string, for the UI's
 * short labels and the board's spawn-point nesting. A SpawnPoint (arity 3) yields its bare spawn; an
 * Address (arity 4) yields `spawn.session`. */
internal fun localFieldOf(canonical: String): String =
	when (val t = parseTarget(canonical, "", "")) {
		is Address -> composeSessionName(t.spawn, t.session)
		is SpawnPoint -> t.spawn
	}

/** The Gateway segment of a canonical address string. */
internal fun gatewayOf(canonical: String): String =
	when (val t = parseTarget(canonical, "", "")) {
		is Address -> t.gateway
		is SpawnPoint -> t.gateway
	}

/** UI model for the sessions board. Mapped from the wire TeamInfo in `teams()`, and also
 * constructed locally for ended threads whose team has left the bridge (a state that never
 * exists on the wire). `name` is the canonical address key (`domain.gateway.spawn.session`, or
 * `domain.gateway.spawn` for a spawn-point); `shortName` and `gatewayId` derive from it. */
data class Team(
	val name: String,
	val status: String,
	val mode: String,
	val queueDepth: Int,
	val kind: String = "loose",
	// Plugin version the agent's MCP process reported. Null for consoles, offline catalog
	// entries, and gateways without the feature. The board shows it only when it differs
	// from this app's own expected version.
	val version: String? = null,
	// The owning Gateway's Domain id, kept a separate field rather than folded into the canonical
	// address. A gateway id is unique only within a Domain, so the board groups by the
	// (domainId, gatewayId) pair. Null for a pre-federation Gateway and for the
	// locally-synthesized ended session.
	val domainId: String? = null,
	// The owning Domain's display name, stamped by the gateway's discover. The Peers list shows
	// this instead of the opaque domainId. Null for a gateway without the feature or a Domain
	// that has not set a name yet.
	val displayName: String? = null,
	// True when the owning Domain is the admin's own, from the register reply via the gateway.
	// The local session's value gates the admin surfaces.
	val isAdminDomain: Boolean = false,
	// The gateway-authoritative free-form label the board renders for this session. Distinct from
	// displayName (the owning Domain's network name). Null for a spawn-point, a session with no
	// record, or an older gateway that does not send it (the app falls back to a local label / leaf).
	val sessionLabel: String? = null,
) {
	/** Short local field shown in the UI: `spawn` or `spawn.session` from the canonical address. */
	val shortName: String get() = localFieldOf(name)

	/** Owning Gateway id (the gateway segment of the canonical address). */
	val gatewayId: String get() = gatewayOf(name)

	/** A live socket serves this session: confirmed online, or verifying its handshake (connected
	 * but the LLM has not re-answered, e.g. across a gateway restart). Both count as awake. */
	val isLive: Boolean get() = status == "online" || status == "verifying"
}

data class SendResult(val ok: Boolean, val status: String, val error: String?)

/** A file the user picked to send. Bytes are base64-encoded onto the wire. */
data class OutgoingFile(val name: String, val mime: String, val bytes: ByteArray)

/** The owner enroll envelope: `enrollOp` (not `op`) routes to evie's enrollment coordinator,
 * which answers an EnrollResult directly instead of relaying to a Gateway. */
@Serializable
private data class EnrollEnvelope(
	val device: String,
	val conversationId: String,
	val opId: String,
	val enrollOp: EnrollOp,
)

/** A retryable bounce body (offline / malformed), distinct from an EnrollResult. */
@Serializable
// internal (not private): referenced from postEvieDirect, an internal inline fun - an inline
// function's body cannot access a private-in-file type even from the same file (the compiler
// treats inlining as a visibility-widening operation). Same bug class as ConsoleClient's own
// PINNED_*/HELD_*/PROXY_CEILING_MS companion constants; see their comment for the general rule.
internal data class BounceBody(val error: String? = null, val retryable: Boolean = false)

/** First-root POST body: a top-level `firstRoot` field routes to evie's console-bridge
 * firstRoot intake, decided at evie and never relayed to a Gateway. */
@Serializable
private data class FirstRootEnvelope(val firstRoot: SignedFirstRoot)

/** Enroll-handshake POST body: a top-level `enrollHandshake` field routes to evie's
 * console-bridge enroll-handshake broker, a dumb relay never sent to a Gateway. */
@Serializable
private data class EnrollHandshakeEnvelope(val enrollHandshake: EnrollHandshakeOp)

/** Roster POST body: a top-level `roster` field routes to evie's cross-tenant roster handler,
 * which aggregates across Domains a gateway cannot see and answers itself. */
@Serializable
private data class RosterEnvelope(val roster: RosterRequest)

/** Transport-request POST body: a top-level `transport` field routes to evie's console-bridge
 * transport intake, which holds the gateway-bridge Secret and answers itself. */
@Serializable
private data class TransportEnvelope(val transport: TransportRequest)

/** Device-approval POST body for the AUTHENTICATED held device: a top-level `consoleApproval` field
 * routes to evie's console-bridge device-approval coordinator (arm/poll/approve/cancel). The public
 * join/fetch steps go to the credential-less ingress instead (see postPublicApproval). */
@Serializable
private data class ConsoleApprovalEnvelope(val consoleApproval: ConsoleApprovalOp)

/** Trust-rendezvous POST bodies: top-level fields routing to evie's trust broker and pending query. */
@Serializable
private data class TrustHandshakeEnvelope(val trustHandshake: TrustHandshakeOp)

@Serializable
private data class TrustPendingEnvelope(val trustPending: TrustPendingRequest)

/** evie's reply to a provision_tenant enroll op. Mirrors EnrollResult but also carries the minted
 * one-time invite `nonce` the admin's app builds the friend's QR from. The wire EnrollResult schema
 * omits `nonce`, so this is a richer local decode. */
@Serializable
data class ProvisionTenantResult(val ok: Boolean, val error: String? = null, val nonce: String? = null)

/** Decode tolerates unknown fields (additive protocol). Encode omits null-defaulted optionals,
 * which is what the gateway's schemas accept. */
internal val wireJson = Json { ignoreUnknownKeys = true }

/** Map a Crypto.SealedEnvelope to the proto.SealedEnvelope wire type. Fields are identical by
 * design; the mapper avoids coupling the two class hierarchies. */
private fun Crypto.SealedEnvelope.toProto(): SealedEnvelope =
	SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)

/** Map a proto.SealedEnvelope to Crypto.SealedEnvelope for unseal calls. */
private fun SealedEnvelope.toCrypto(): Crypto.SealedEnvelope =
	Crypto.SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)

/** Talks to the console bridge through the CA-pinned k8s API service-proxy. */
class ConsoleClient(private val prov: Provisioning, private val store: AppStateStore) {
	private val client = buildPinnedClient(prov.caPem)
	private val proxyBase =
		"${prov.apiUrl}/api/v1/namespaces/${prov.namespace}/services/${prov.service}:${prov.port}/proxy"

	/** This console's route Gateway id, learned at register and set by ChatRepository.
	 * Rides every relay so the Gateway routes to the right Gateway; null until learned. */
	@Volatile
	var routeGateway: String? = null

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
	 * CancellationException instead of blocking out the timeout - see the poll loop's cancellation-
	 * rethrow discipline for why every caller up the chain must let that exception propagate. */
	private suspend fun relay(
		op: ConsoleOp,
		opId: String = UUID.randomUUID().toString(),
		readTimeoutMs: Long? = null,
		targetGateway: String? = null,
		// Bounds the whole call so a peer that trickles bytes can't wedge the caller forever -
		// readTimeout alone only covers inactivity gaps. null opts out (send()'s upload).
		callTimeoutMs: Long? = DEFAULT_RELAY_CALL_TIMEOUT_MS,
	): ConsoleReplyBody {
		val identity = requireConsoleIdentity()
		// An op seals to the Gateway hosting its session (resolved from the keyring), naming it so
		// evie routes there. Register/poll/list default to the route Gateway.
		val gatewayId = targetGateway?.takeIf { it.isNotEmpty() } ?: resolveGatewayId()
		val hostKeys = requireGatewayKeys(gatewayId)

		val frame = buildSealedFrame(op, opId, identity, gatewayId, hostKeys.boxPub)
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Console-Bridge-Token", "Bearer ${prov.appToken}")
			.post(wireJson.encodeToString(ConsoleRelayFrame.serializer(), frame).toRequestBody(JSON))
			.build()
		val callClient = if (readTimeoutMs != null || callTimeoutMs != null) {
			client.newBuilder().apply {
				if (readTimeoutMs != null) readTimeout(readTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
				if (callTimeoutMs != null) callTimeout(callTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
			}.build()
		} else {
			client
		}
		val resp = executeCancellable(callClient, req)
		if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.text.take(500)}")
		val reply = wireJson.decodeFromString<ConsoleRelayReply>(resp.text)
		// Cleartext error path (console not admitted or pre-seal failure): surface it so the
		// UI can prompt enrollment rather than show a generic network error.
		if (reply.sealed == null) {
			error(reply.error ?: "relay error (no sealed payload)")
		}
		return unsealReply(reply.sealed, identity, hostKeys.signPub)
	}

	/** This instance's evie-direct POST, filling in the companion's testable postEvieDirect primitive
	 * with this ConsoleClient's own client/url/tokens. Every production evie-direct call site goes
	 * through here instead of repeating those four positional args - besides the duplication, three of
	 * them are adjacent same-typed Strings (url, saToken, appToken) that Kotlin cannot keyword-enforce
	 * positionally, so a hand-repeated call is one transposition away from swapping which credential
	 * rides which header. logBody has NO default (mirrors the companion primitive) - a call whose 2xx
	 * result carries secret material the debug log must never echo passes false; every other site
	 * states true explicitly, so a new site cannot compile without deciding rather than silently
	 * inheriting a "log everything" default. */
	private suspend inline fun <reified R> postEvieDirect(
		tag: String,
		describe: String,
		body: RequestBody,
		logBody: Boolean,
		fail: (String) -> R,
	): R = postEvieDirect(client, "$proxyBase/relay", prov.saToken, prov.appToken, tag, describe, body, logBody, fail)

	/** Submit an owner enroll op directly to evie (the Domain root). Enroll ops are evie-direct and never
	 * relayed to a Gateway, so they succeed with no gateway connected; evie answers an EnrollResult, not a
	 * console_relay_reply. A bounce (offline, 501, malformed) is surfaced as a failed EnrollResult. */
	suspend fun enroll(op: EnrollOp): EnrollResult {
		val envelope = EnrollEnvelope(prov.device, prov.conversationId, UUID.randomUUID().toString(), op)
		return postEvieDirect(
			tag = "Enroll",
			describe = "op=${op::class.simpleName}",
			body = wireJson.encodeToString(EnrollEnvelope.serializer(), envelope).toRequestBody(JSON),
			logBody = true,
		) { EnrollResult(ok = false, error = it) }
	}

	/** Drive one device-approval frame (arm/poll/approve/cancel) through evie's coordinator over the
	 * AUTHENTICATED console-bridge. Mirrors enroll()'s envelope + POST: evie answers a
	 * ConsoleApprovalResult directly (200 ok, 400 reject), never relaying to a Gateway. The public
	 * join/fetch steps must NOT come here - they go to postPublicApproval. */
	suspend fun postConsoleApproval(op: ConsoleApprovalOp): ConsoleApprovalResult =
		postEvieDirect(
			tag = "DeviceApproval",
			describe = "step=${op::class.simpleName}",
			body = wireJson.encodeToString(ConsoleApprovalEnvelope.serializer(), ConsoleApprovalEnvelope(op)).toRequestBody(JSON),
			logBody = true,
		) { ConsoleApprovalResult(ok = false, error = it) }

	/** First-root a pending friend Domain at this device's silently-generated owner key. evie decides it
	 * directly from the self-signed frame + one-time invite nonce, with no gateway and no admission, so it
	 * works before any Gateway is admitted. It answers an EnrollResult (2xx ok, 400 reject for an expired or
	 * already-claimed invite). A reject is not retryable (the root was decided), so the caller surfaces it. */
	suspend fun firstRoot(signed: SignedFirstRoot): EnrollResult {
		val envelope = FirstRootEnvelope(signed)
		return postEvieDirect(
			tag = "FirstRoot",
			describe = "domain=${signed.firstRoot.domainId}",
			body = wireJson.encodeToString(FirstRootEnvelope.serializer(), envelope).toRequestBody(JSON),
			logBody = true,
		) { EnrollResult(ok = false, error = it) }
	}

	/** Pull this owner's network gateway-bridge transport (the proxy SA token + CA) from evie. POST
	 * { transport } evie-direct like firstRoot: evie holds the gateway-bridge Secret and answers itself,
	 * scoping by the request's signed owner proof. ok=false is an opaque reject (bad proof or not a rooted
	 * owner); a transport bounce maps to ok=false too. The Console seals the returned creds into a bootstrap
	 * bundle for a creds-less Gateway it is enrolling. */
	suspend fun requestGatewayTransport(req: TransportRequest): TransportResult =
		postEvieDirect(
			tag = "Transport",
			describe = "transport",
			body = wireJson.encodeToString(TransportEnvelope.serializer(), TransportEnvelope(req)).toRequestBody(JSON),
			// A 2xx body carries the minted gateway-bridge SA token - never let it reach the debug log.
			logBody = false,
		) { TransportResult(ok = false, error = it) }

	/** Drive one enroll-handshake frame through evie's broker (POST { enrollHandshake }). evie relays the
	 * peer's frame back, or reports pending; the phone computes the SAS locally. Pre-admission like firstRoot
	 * (the fresh enrollee has no admission). A terminal failure is ok=false + error; ok=true with the peer
	 * frame absent means keep polling (re-send the same step). */
	suspend fun enrollHandshake(op: EnrollHandshakeOp): EnrollHandshakeResult {
		val envelope = EnrollHandshakeEnvelope(op)
		return postEvieDirect(
			tag = "EnrollHs",
			describe = "step=${op::class.simpleName}",
			body = wireJson.encodeToString(EnrollHandshakeEnvelope.serializer(), envelope).toRequestBody(JSON),
			logBody = true,
		) { EnrollHandshakeResult(ok = false, error = it) }
	}

	/** Fetch the cross-tenant roster (the Users surface) from evie. POST { roster } evie-direct like
	 * firstRoot: evie aggregates across Domains a gateway cannot see and answers itself. The request carries
	 * the console's signed ROSTER proof; a non-member comes back ok=false (opaque). */
	suspend fun roster(req: RosterRequest): RosterResult =
		postEvieDirect(
			tag = "Roster",
			describe = "roster",
			body = wireJson.encodeToString(RosterEnvelope.serializer(), RosterEnvelope(req)).toRequestBody(JSON),
			logBody = true,
		) { RosterResult(ok = false, error = it) }

	/** Broker a FLOW-2 trust-rendezvous frame (arm/join/reveal/cancel) at evie. POST { trustHandshake }
	 * evie-direct (the dumb broker; no sealing, like the enroll handshake). */
	suspend fun trustHandshake(op: TrustHandshakeOp): TrustHandshakeResult =
		postEvieDirect(
			tag = "Trust",
			describe = "handshake op=${op::class.simpleName}",
			body = wireJson.encodeToString(TrustHandshakeEnvelope.serializer(), TrustHandshakeEnvelope(op)).toRequestBody(JSON),
			logBody = true,
		) { TrustHandshakeResult(ok = false, error = it) }

	/** Query "who armed trust toward me?" at evie (the highlight). POST { trustPending } with the
	 * owner-signed proof; evie returns the armed rendezvous indexed under this owner key. */
	suspend fun trustPending(req: TrustPendingRequest): TrustPendingResult =
		postEvieDirect(
			tag = "Trust",
			describe = "pending",
			body = wireJson.encodeToString(TrustPendingEnvelope.serializer(), TrustPendingEnvelope(req)).toRequestBody(JSON),
			logBody = true,
		) { TrustPendingResult(ok = false, error = it) }

	/** Submit an admin-signed provision_tenant enroll op and decode the minted one-time invite nonce evie
	 * returns (the admin's app builds the friend's QR from it). Same evie-direct path as enroll(); only the
	 * richer result decode differs, since the wire EnrollResult omits the nonce. */
	suspend fun provisionTenant(signed: SignedProvisionTenant): ProvisionTenantResult {
		val envelope = EnrollEnvelope(prov.device, prov.conversationId, UUID.randomUUID().toString(), EnrollOp.ProvisionTenant(signed))
		return postEvieDirect(
			tag = "Enroll",
			describe = "op=ProvisionTenant",
			body = wireJson.encodeToString(EnrollEnvelope.serializer(), envelope).toRequestBody(JSON),
			// A 2xx body carries the minted one-time invite nonce - never let it reach the debug log.
			logBody = false,
		) { ProvisionTenantResult(ok = false, error = it) }
	}

	/** The reply's result payload decoded as T, or an error for a failed op. */
	private inline fun <reified T> resultOf(body: ConsoleReplyBody, op: String): T {
		if (!body.ok) error("$op failed: ${body.error ?: "unknown error"}")
		val result = body.result ?: error("$op: no result")
		return wireJson.decodeFromJsonElement(result)
	}

	/** Claim this device's mailbox, returning the starting cursor + epoch. Carries this build's identity
	 * so the gateway logs which version and variant the console runs. */
	suspend fun register(): ConsoleRegisterResult = resultOf(
		relay(
			ConsoleOp.Register(
				clientVersion = "${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}",
				clientVariant = if (BuildConfig.DEBUG) "debug" else "release",
			),
		),
		"register",
	)

	/** List the bridge's sessions, each keyed by its canonical `domain.gateway.spawn.session` address. A
	 * session's Gateway comes from the wire (`TeamInfo.gatewayId`, always stamped); an empty value falls
	 * back to `localGatewayId` (this connection's Gateway, learned at register). */
	suspend fun teams(localGatewayId: String = ""): List<Team> {
		val body = relay(ConsoleOp.ListTeams)
		// Surface a relay failure instead of blanking the board; the callers (connect, refreshTeams)
		// wrap this in runCatching and keep the prior list.
		if (!body.ok || body.result == null) error("list_teams relay failed: ${body.error ?: "no result"}")
		val result =
			wireJson.decodeFromJsonElement<com.atelier_nyaarium.switchboard.proto.ConsoleListTeamsResult>(body.result)
		return result.teams.map {
			val gatewayId = it.gatewayId.ifEmpty { localGatewayId }
			// Mirror the gateway's address minting: a spawn-point (kind devcontainer) is the
			// non-addressable `domain.gateway.spawn` (arity 3); every chat is the full
			// `domain.gateway.spawn.session` (arity 4), a bare team field defaulting its session to
			// DEFAULT_SESSION exactly as the gateway's localAddress does, so a chat's Team.name is
			// byte-equal to the address a session_id carries (no thread/team join mismatch).
			val domain = it.domainId?.ifEmpty { null } ?: LOCAL_DOMAIN_SENTINEL
			val parsed = parseSessionName(it.team)
			val canonicalName = if (it.kind == "devcontainer") {
				SpawnPoint.of(domain, gatewayId, parsed.project).canonical
			} else {
				Address.of(domain, gatewayId, parsed.project, parsed.session).canonical
			}
			Team(
				name = canonicalName,
				status = it.status,
				mode = it.mode ?: "",
				queueDepth = it.queue_depth.toInt(),
				kind = it.kind,
				version = it.version,
				domainId = it.domainId,
				displayName = it.displayName,
				isAdminDomain = it.isAdminDomain ?: false,
				sessionLabel = it.sessionLabel,
			)
		}
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
		val wireFiles = files.map { f ->
			ChannelFile(
				filename = f.name,
				mime = f.mime,
				size = f.bytes.size.toLong(),
				descriptiveKey = f.name,
				base64 = android.util.Base64.encodeToString(f.bytes, android.util.Base64.NO_WRAP),
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
		val local = routeGateway?.takeIf { it.isNotEmpty() } ?: store.loadGatewayId()
		val target = if (crossDomain != null) local else gatewayOfTarget(to, local)
		// callTimeoutMs = null: a large attachment upload must not be capped by an overall
		// call duration, only by writeTimeout's per-write inactivity bound (buildPinnedClient).
		val replyBody = relay(op, opId, targetGateway = target, callTimeoutMs = null)
		val status = replyBody.result?.let {
			runCatching { wireJson.decodeFromJsonElement<ConsoleSendResult>(it).status }.getOrNull()
		}
		return SendResult(ok = replyBody.ok, status = status.orEmpty(), error = replyBody.error)
	}

	/** Drain new mailbox entries since cursor (epoch-gated). With holdMs > 0 the server long-polls: an empty
	 * mailbox holds the request open until a message arrives or the hold expires, so delivery is near-instant
	 * at about one request per hold window instead of constant fast polling. */
	suspend fun poll(cursor: Long, epoch: Long, holdMs: Long = 0): ConsolePollResult {
		// Carry the synced keyring version so the route Gateway returns the snapshot only when it changed
		// (a revocation made elsewhere reaches this Console within one cycle).
		val knownVersion = store.loadDomainVersion().ifEmpty { null }
		val op = ConsoleOp.Poll(
			cursor = cursor,
			epoch = epoch,
			holdMs = if (holdMs > 0) holdMs else null,
			knownDomainVersion = knownVersion,
		)
		// Ordered timeout chain for a held poll: gateway replies by holdMs (40s), evie's relay
		// hold fires at 55s if the gateway vanished, this read timeout at holdMs+HELD_READ_MARGIN_MS
		// (58s) catches a vanished evie, and the apiserver proxy's PROXY_CEILING_MS (60s) outranks
		// them all - pinned as LONG_POLL_HOLD_MS + HELD_READ_MARGIN_MS < PROXY_CEILING_MS in
		// ChatRepositoryConstantsTest. Each failure layer returns before the next races it.
		val heldReadTimeoutMs = if (holdMs > 0) holdMs + HELD_READ_MARGIN_MS else null
		val body = relay(
			op,
			readTimeoutMs = heldReadTimeoutMs,
			// Derived from this call's own read timeout (not an independent literal) so it
			// can never drift below what that read timeout itself needs to complete.
			callTimeoutMs = heldReadTimeoutMs?.let { it + CALL_TIMEOUT_MARGIN_MS + PINNED_CONNECT_TIMEOUT_MS },
		)
		// A relay-level failure must SURFACE, not masquerade as a successful empty drain:
		// a fabricated empty (with epoch 0) hid outages from the health signal and forced
		// a spurious epoch flip on the next real poll. Throw so the poll loop's catch
		// counts the failure and shows the offline banner.
		if (!body.ok || body.result == null) error("poll relay failed: ${body.error ?: "no result"}")
		return wireJson.decodeFromJsonElement<ConsolePollResult>(body.result)
	}

	/** The Gateway segment of a wire target. A local form (arity 1/2) resolves its gateway to
	 * [localGateway]; a fully-qualified form (arity 3/4) keeps its explicit gateway. */
	private fun gatewayOfTarget(to: String, localGateway: String): String =
		when (val t = parseTarget(to, "", localGateway)) {
			is Address -> t.gateway
			is SpawnPoint -> t.gateway
		}

	/** The Gateway that hosts a target session (a bare name resolves to the local Gateway), so a peek/send
	 * seals E2E to that Gateway. Mirrors send(). */
	private fun targetGatewayOf(target: String): String =
		gatewayOfTarget(target, routeGateway?.takeIf { it.isNotEmpty() } ?: store.loadGatewayId())

	/** Capture the target's visible tmux pane for the terminal view. Pass the last hash so the
	 * Gateway returns unchanged=true (no ansi) for an idle pane. */
	suspend fun peek(target: String, sinceHash: String? = null): ConsolePeekResult =
		resultOf(relay(ConsoleOp.Peek(target = target, sinceHash = sinceHash), targetGateway = targetGatewayOf(target)), "peek")

	/** Send literal text OR a named control key to the target's tmux pane. `submit` (text only, default
	 * true) controls the trailing Enter: false types into the composer without submitting. Idempotent
	 * per opId (the host replays a re-relayed send instead of re-injecting). */
	suspend fun tmuxSend(
		target: String,
		text: String? = null,
		key: String? = null,
		submit: Boolean = true,
		opId: String = UUID.randomUUID().toString(),
	) {
		val body =
			relay(ConsoleOp.TmuxSend(target = target, text = text, key = key, submit = submit), opId, targetGateway = targetGatewayOf(target))
		if (!body.ok) error("tmux_send failed: ${body.error ?: "unknown error"}")
	}

	/** Forget a session: kill its tmux and drop its resume record. Idempotent per opId; the Gateway
	 * rejects a bare spawn-point (a composite session is required). */
	suspend fun forget(target: String, opId: String = UUID.randomUUID().toString()) {
		val body = relay(ConsoleOp.Forget(target = target), opId, targetGateway = targetGatewayOf(target))
		if (!body.ok) error("forget failed: ${body.error ?: "unknown error"}")
	}

	/** Close a session: kill its tmux but KEEP its resume record (a restart / mop-up), so it stays
	 * listed as available. Idempotent per opId; the Gateway rejects a bare spawn-point, refuses while
	 * a wake is in flight, and reports a user-launched session rather than a false success. */
	suspend fun closeSession(target: String, opId: String = UUID.randomUUID().toString()) {
		val body = relay(ConsoleOp.CloseSession(target = target), opId, targetGateway = targetGatewayOf(target))
		if (!body.ok) error("close failed: ${body.error ?: "unknown error"}")
	}

	/** Spawn a new session in a spawn-point project. A `displayLabel` lets the gateway mint the id
	 * (the minted id is the tmux name) and returns it; a `sessionName` is adopted as the id (the
	 * old form, against a gateway that does not mint). Idempotent per opId (reattaches if it already
	 * exists). Returns the gateway's reply; `id` is absent from an older gateway. */
	suspend fun createSession(
		target: String,
		sessionName: String? = null,
		displayLabel: String? = null,
		opId: String = UUID.randomUUID().toString(),
	): ConsoleCreateSessionResult =
		resultOf(
			relay(
				ConsoleOp.CreateSession(target = target, sessionName = sessionName, displayLabel = displayLabel),
				opId,
				targetGateway = targetGatewayOf(target),
			),
			"create_session",
		)

	/** Rename a session: set the gateway-authoritative sessionLabel on its record. Idempotent per
	 * opId. Returns the label the gateway actually applied (after its sanitize + per-spawn dedup). */
	suspend fun renameSession(
		target: String,
		sessionLabel: String,
		opId: String = UUID.randomUUID().toString(),
	): ConsoleRenameSessionResult =
		resultOf(
			relay(ConsoleOp.RenameSession(target = target, sessionLabel = sessionLabel), opId, targetGateway = targetGatewayOf(target)),
			"rename_session",
		)

	////////////////////////////////
	//  Cross-Domain trust ops
	//
	//  Thin wrappers over the same seal/relay/poll path as the ops above, all defaulting to the route
	//  Gateway: the handshake coordinator, the per-session share state, and the unlink cleanup all run on
	//  this owner's own Gateway (the friend Gateway is reached through the mesh, not sealed to directly).
	//  Reads run fresh; the mutating ops carry a stable opId so a lost-reply retry replays the cached
	//  result rather than re-running, like send/tmux_send.

	/** RECEIVER: open a listening window. Returns the short token to read to the friend plus
	 * this Gateway's keys (for the SAS) and the window's expiry. */
	suspend fun crossDomainListen(): CrossDomainListenResult =
		resultOf(relay(ConsoleOp.CrossDomainListen), "cross_domain_listen")

	/** REQUESTER: pair against the friend's listening token. The Gateway runs the full
	 * commit-reveal exchange and returns the 6-digit SAS plus both sides' keys. */
	suspend fun crossDomainRequest(
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
	suspend fun crossDomainConfirm(
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
	suspend fun crossDomainListenState(listeningToken: String): CrossDomainListenStateResult =
		resultOf(relay(ConsoleOp.CrossDomainListenState(listeningToken = listeningToken)), "cross_domain_listen_state")

	/** EITHER ROLE: cancel a listening window (receiver token) and/or a pending pairing (pin)
	 * when the owner leaves the pairing screen, so a stale request cannot complete. */
	suspend fun crossDomainCancel(listeningToken: String? = null, pin: String? = null): CrossDomainCancelResult =
		resultOf(relay(ConsoleOp.CrossDomainCancel(listeningToken = listeningToken, pin = pin)), "cross_domain_cancel")

	/** Mark a local session shared to an audience (a linked friend Domain, or everyone trusted). */
	suspend fun crossDomainShare(
		sessionTarget: String,
		target: CrossDomainShareTarget,
		opId: String = UUID.randomUUID().toString(),
	): CrossDomainShareResult =
		resultOf(relay(ConsoleOp.CrossDomainShare(sessionTarget = sessionTarget, target = target), opId), "cross_domain_share")

	/** Withdraw a local session's share from an audience. */
	suspend fun crossDomainUnshare(
		sessionTarget: String,
		target: CrossDomainShareTarget,
		opId: String = UUID.randomUUID().toString(),
	): CrossDomainUnshareResult =
		resultOf(
			relay(ConsoleOp.CrossDomainUnshare(sessionTarget = sessionTarget, target = target), opId),
			"cross_domain_unshare",
		)

	/** This owner's current shares, so the UI can render the per-session checkmarks. */
	suspend fun crossDomainListShares(): CrossDomainListSharesResult =
		resultOf(relay(ConsoleOp.CrossDomainListShares), "cross_domain_list_shares")

	/** The linked friend Domains from the route Gateway's cross-Domain peer set, so a just-linked
	 * peer is visible (and its detail reachable) before any of its sessions surface in discovery. A
	 * fresh read each call (never cached). */
	suspend fun crossDomainListPeers(): CrossDomainListPeersResult =
		resultOf(relay(ConsoleOp.CrossDomainListPeers), "cross_domain_list_peers")

	/** Unlink a friend Domain: drop the local trust + share state for it. */
	suspend fun crossDomainUnlink(domainId: String, opId: String = UUID.randomUUID().toString()): CrossDomainUnlinkResult =
		resultOf(relay(ConsoleOp.CrossDomainUnlink(domainId = domainId), opId), "cross_domain_unlink")

	/** Untrust a PERSON by owner key: drop the local peer + share state for every Domain they own. */
	suspend fun crossDomainUntrust(ownerSignPub: String, opId: String = UUID.randomUUID().toString()): CrossDomainUnlinkResult =
		resultOf(relay(ConsoleOp.CrossDomainUntrust(ownerSignPub = ownerSignPub), opId), "cross_domain_untrust")

	companion object {
		private val JSON = "application/json".toMediaType()

		// internal (not private): ChatRepositoryConstantsTest pins the long-poll timeout chain
		// against these from a separate test class, and FORGET_TOMBSTONE_MS derives from
		// DEFAULT_RELAY_CALL_TIMEOUT_MS below for the same reason. PINNED_READ_TIMEOUT_MS also
		// gets its own pin against the gateway's SEND_BOUND_MS, the relationship its own comment
		// on buildPinnedClient already describes.
		internal const val PINNED_CONNECT_TIMEOUT_MS = 15_000L
		internal const val PINNED_READ_TIMEOUT_MS = 35_000L
		private const val PINNED_WRITE_TIMEOUT_MS = 600_000L

		// Margin on top of a call's own read timeout to get its callTimeout: covers connect
		// + request-send + response-parse overhead beyond the read wait itself.
		internal const val CALL_TIMEOUT_MARGIN_MS = 10_000L

		// The gap between a held poll's requested hold and the read timeout that bounds it -
		// see poll()'s heldReadTimeoutMs. Named (not a bare literal) because
		// ChatRepositoryConstantsTest pins LONG_POLL_HOLD_MS + this against PROXY_CEILING_MS.
		internal const val HELD_READ_MARGIN_MS = 18_000L

		// Mirrors the apiserver proxy's own read timeout (untracked infra config, not in this
		// repo) - an infra change to that value must update this one too. The binding constraint
		// on the whole long-poll chain: the client's held read timeout must return before the
		// proxy resets the socket, pinned as LONG_POLL_HOLD_MS + HELD_READ_MARGIN_MS < this in
		// ChatRepositoryConstantsTest.
		internal const val PROXY_CEILING_MS = 60_000L

		// Bounds the common (non-held) relay() call: base read timeout + connect + margin.
		// poll()'s held branch derives its own larger callTimeoutMs from its own read timeout
		// instead of using this (see poll()). send() opts out entirely (callTimeoutMs = null)
		// since its upload body write must not be capped by an overall call duration.
		// internal (not private): ChatRepository derives FORGET_TOMBSTONE_MS from this, since
		// that tombstone must outlast the same teams() call this bounds.
		internal const val DEFAULT_RELAY_CALL_TIMEOUT_MS =
			PINNED_CONNECT_TIMEOUT_MS + PINNED_READ_TIMEOUT_MS + CALL_TIMEOUT_MARGIN_MS

		/** System-trust client for the PUBLIC device-approval ingress. No CA pin (the reach URL is a real
		 * public cert) and no creds, so it is shared and built once. Short read timeout since the fresh
		 * device polls fetch in a loop. */
		private val publicClient: OkHttpClient by lazy {
			OkHttpClient.Builder()
				.connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
				.readTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
				// Bounds the whole call: a fresh device polls this in a loop, so a peer
				// that trickles bytes must not hold one call open past its own read gaps.
				.callTimeout(40, java.util.concurrent.TimeUnit.SECONDS)
				.build()
		}

		/** What postEvieDirect's resp log line shows for a response body: the real (truncated) text when
		 * logBody is true, else a char-count placeholder that can never contain the body's own content -
		 * pulled out of postEvieDirect so this policy is directly unit-testable without going through
		 * DebugLog (which a pure-JVM test cannot observe). */
		internal fun loggedBodyPreview(text: String, logBody: Boolean): String =
			if (logBody) text.take(160) else "(redacted, ${text.length} chars)"

		/** A response reduced to the two things every caller here needs, read out fully before this
		 * suspend call returns. */
		internal data class HttpTextResult(val code: Int, val text: String) {
			val isSuccessful: Boolean get() = code in 200..299
		}

		/** Run [req] on [httpClient] cancellably: a coroutine cancellation calls Call.cancel() and this
		 * suspend call unwinds immediately instead of waiting out a timeout. The body is read to a String
		 * and the Response closed INSIDE the OkHttp callback, before resuming - so a cancellation racing
		 * the callback can only ever abandon an already-closed, already-read HttpTextResult, never a
		 * leaked Response, and every caller's own parsing/decoding runs after resume, on the CALLER's
		 * dispatcher, not OkHttp's callback thread. Shared by relay() and postEvieDirect() so Phase D's
		 * cancellability lands in exactly these two places (see console-hardening.md). */
		internal suspend fun executeCancellable(httpClient: OkHttpClient, req: Request): HttpTextResult =
			suspendCancellableCoroutine { cont ->
				val call = httpClient.newCall(req)
				cont.invokeOnCancellation { call.cancel() }
				call.enqueue(
					object : Callback {
						override fun onResponse(call: Call, response: Response) {
							val result =
								try {
									response.use { HttpTextResult(response.code, response.body?.string().orEmpty()) }
								} catch (e: Throwable) {
									// Throwable, not Exception: a large enough body can throw OutOfMemoryError
									// during .string(), and OkHttp's dispatcher never calls onFailure once
									// onResponse has already run - an Exception-only catch would let that
									// specific Error escape uncaught, orphaning the continuation forever (the
									// hazard this wrapper exists to close, worst for send()'s callTimeoutMs=null
									// upload). Closes the common case (this one allocation fails, headroom
									// remains); under true heap exhaustion the resumeWithException call below
									// could itself throw, which is not recoverable by any wrapper.
									cont.resumeWithException(e)
									return
								}
							cont.resume(result)
						}

						override fun onFailure(call: Call, e: IOException) {
							cont.resumeWithException(e)
						}
					},
				)
			}

		/** Shared evie-direct POST: every op that bypasses relay() and talks to evie's console-bridge
		 * straight (enroll, postConsoleApproval, firstRoot, requestGatewayTransport, enrollHandshake,
		 * roster, trustHandshake, trustPending, provisionTenant) shares this exact decode contract - 2xx
		 * decodes as R (falling back through `fail` on a malformed body); non-2xx tries R first (a
		 * coordinator reject can carry a typed body), then a bare {error} bounce, then a plain HTTP-code
		 * fallback via `fail`. Takes its client/url/tokens as parameters rather than reading `this` so a
		 * MockWebServer test can drive it with no Context-backed ConsoleClient; production code never
		 * calls this directly - it goes through the instance-level `postEvieDirect(tag, describe, body,
		 * logBody, fail)` above `enroll()`, which fills in this ConsoleClient's own client/url/tokens.
		 * `tag`+`describe` together must stay unique enough to disambiguate in the debug log (e.g. the
		 * Trust pair, or provisionTenant vs enroll sharing the "Enroll" tag). `logBody` gates only the
		 * resp line's body preview - requestGatewayTransport (a minted SA token) and provisionTenant (a
		 * one-time invite nonce) pass false so their 2xx bodies never reach the debug log, which the
		 * debug build ships off-device to evie /ingest as well as logcat. */
		internal suspend inline fun <reified R> postEvieDirect(
			httpClient: OkHttpClient,
			url: String,
			saToken: String,
			appToken: String,
			tag: String,
			describe: String,
			body: RequestBody,
			logBody: Boolean,
			fail: (String) -> R,
		): R {
			val req = Request.Builder()
				.url(url)
				.header("Authorization", "Bearer $saToken")
				.header("X-Console-Bridge-Token", "Bearer $appToken")
				.post(body)
				.build()
			DebugLog.log(tag, "POST $url $describe")
			val resp =
				try {
					executeCancellable(httpClient, req)
				} catch (e: Exception) {
					// A cancellation racing this call is not a transport failure - skip the log line
					// (which the debug build ships off-device) so a teardown cancel does not read as a
					// spurious connection error in the ingest stream. The rethrow is unconditional either
					// way; only the logging is skipped.
					if (e !is CancellationException) {
						DebugLog.log(tag, "$describe transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
					}
					throw e
				}
			DebugLog.log(tag, "$describe resp HTTP ${resp.code} ${loggedBodyPreview(resp.text, logBody)}")
			if (resp.isSuccessful) {
				return runCatching { wireJson.decodeFromString<R>(resp.text) }
					.getOrElse { fail("unexpected response (HTTP ${resp.code})") }
			}
			runCatching { wireJson.decodeFromString<R>(resp.text) }.getOrNull()?.let { return it }
			val err = runCatching { wireJson.decodeFromString<BounceBody>(resp.text).error }.getOrNull()
			return fail(err ?: "HTTP ${resp.code}")
		}

		/** The fresh device N's public path: a plain HTTPS POST of the op JSON to evie's nonce-gated
		 * ingress, carrying NO SA token and NO app token (N holds none). Only the join/fetch steps reach
		 * here; the nonce in the op body is the gate. TLS is the public host's real cert (system trust).
		 * Always answers a ConsoleApprovalResult (the ingress returns 200 with the ok flag in the body).
		 * Deliberately NOT built on postEvieDirect: different client (publicClient, no CA pin), no auth
		 * headers, and no isSuccessful branch on the decode (the ingress always answers 200). */
		fun postPublicApproval(reachUrl: String, op: ConsoleApprovalOp): ConsoleApprovalResult {
			val req = Request.Builder()
				.url(reachUrl)
				.post(wireJson.encodeToString(ConsoleApprovalOp.serializer(), op).toRequestBody(JSON))
				.build()
			DebugLog.log("DeviceApproval", "PUBLIC POST $reachUrl step=${op::class.simpleName}")
			val resp =
				try {
					publicClient.newCall(req).execute()
				} catch (e: Exception) {
					DebugLog.log("DeviceApproval", "public transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
					throw e
				}
			resp.use {
				val text = resp.body?.string().orEmpty()
				DebugLog.log("DeviceApproval", "public resp HTTP ${resp.code} ${text.take(160)}")
				runCatching { wireJson.decodeFromString<ConsoleApprovalResult>(text) }.getOrNull()?.let { return it }
				return ConsoleApprovalResult(ok = false, error = "HTTP ${resp.code}")
			}
		}

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
			// headroom for a 500 MB attachment upload on slow links. No callTimeout here
			// deliberately: it varies per call (tight for poll/relay, unbounded for send's
			// upload), so relay() sets it per-call instead - see DEFAULT_RELAY_CALL_TIMEOUT_MS.
			return OkHttpClient.Builder()
				.sslSocketFactory(ssl.socketFactory, tm)
				.connectTimeout(PINNED_CONNECT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
				.readTimeout(PINNED_READ_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
				.writeTimeout(PINNED_WRITE_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
				.build()
		}
	}
}
