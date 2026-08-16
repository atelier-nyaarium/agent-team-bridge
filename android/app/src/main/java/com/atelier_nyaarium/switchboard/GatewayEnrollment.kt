package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapFrame
import com.atelier_nyaarium.switchboard.proto.GatewayTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Scanning an admit-gateway QR and delivering that Gateway its sealed bootstrap bundle. Carries its
 * own transport and its own security surface: TLS pinned to the leaf fingerprint the QR named, and a
 * LAN target restricted to a private address literal. */
internal class GatewayEnrollment(private val repo: ChatRepository) {
	/** Parse a scanned admit-gateway QR, or null if it is not one. The SAS is the
	 * fingerprint of the Gateway's signing key, confirmed against the Gateway terminal. */
	fun parseAdmitGateway(scanned: String): ScannedGateway? = runCatching {
		val j = org.json.JSONObject(scanned.trim())
		if (j.optString("type") != "admit-gateway") return null
		val signPub = j.getString("signPub")
		val lan = j.optJSONObject("lan")
		ScannedGateway(
			gatewayId = j.getString("gatewayId"),
			signPub = signPub,
			boxPub = j.getString("boxPub"),
			sas = Crypto.fingerprint(signPub),
			lanHost = lan?.optString("host")?.ifEmpty { null },
			lanPort = lan?.optInt("port", 0)?.takeIf { it > 0 },
			nonce = j.optString("nonce").ifEmpty { null },
			certFp = lan?.optString("certFp")?.ifEmpty { null },
		)
	}.getOrNull()

	/** Enroll a scanned Gateway end to end: owner-admit it, then (if it offered LAN delivery)
	 * fetch the bootstrap transport from the route Gateway, seal a bootstrap bundle, and deliver
	 * it over the LAN, falling back to handing the admin the sealed text to paste. A
	 * host-configured Gateway (no LAN, no nonce) just needs the admission, which reaches it
	 * through evie's domain sync. */
	suspend fun enrollGateway(scanned: ScannedGateway): EnrollDelivery = withContext(Dispatchers.IO) {
		val signed = repo.ownerFacts.admitGateway(scanned.gatewayId, scanned.signPub, scanned.boxPub)
			// admitGateway sets _state.error to the real cause (e.g. "Admit failed: admission not
			// owner-signed" - this phone's owner key does not match the Domain root). Surface that
			// instead of a generic retry prompt so an owner-key mismatch is visible, not a black box.
			?: return@withContext EnrollDelivery(false, repo._state.value.error ?: "Couldn't add the Gateway. Try again.", null)
		val nonce = scanned.nonce
			?: return@withContext EnrollDelivery(true, "Added. This Gateway will come online shortly.", null)
		// Pull the gateway-bridge transport (proxy SA token + CA) from evie by proving this owner roots
		// a network. apiUrl + the network id come from the provisioning blob: apiUrl is the SAME external
		// apiserver the console bridge uses, and domainId is the rooted Domain the Gateway adopts.
		val prov = runCatching { repo.store.load()?.let { Provisioning.parse(it) } }.getOrNull()
			?: return@withContext EnrollDelivery(true, "Added, but this device is not provisioned - re-import your setup blob.", null)
		val result = try {
			repo.client().requestGatewayTransport(repo.federation.signTransportRequest(System.currentTimeMillis()))
		} catch (e: Exception) {
			e.rethrowIfCancellation()
			// Surface the REAL transport-fetch cause (reached-but-rejected, an op failure) instead of
			// asserting "couldn't reach" + a re-provision that will not fix an admission/seal mismatch.
			return@withContext EnrollDelivery(
				true,
				"Added, but couldn't finish Gateway setup: ${e.message?.take(120) ?: "unknown error"}",
				null,
			)
		}
		// The Router names its own branch. Direct carries what the Gateway dials and pins; the k8s
		// branch stays readable only so an older Router still enrolls a Gateway, and goes when the
		// last one is retired. Either way the required fields are checked HERE, so a half-answer
		// fails with a cause rather than sealing a bundle the Gateway will refuse to install.
		val direct = result.transport == "direct"
		val missing = if (direct) {
			result.routerUrl == null || result.routerCertFp == null || result.bearer == null
		} else {
			result.saToken == null || result.caPem == null
		}
		if (!result.ok || missing) {
			return@withContext EnrollDelivery(
				true,
				"Added, but couldn't finish Gateway setup: ${result.error?.take(120) ?: "transport unavailable"}",
				null,
			)
		}
		// The Gateway dials `routerUrl` as its BOOTSTRAP and re-learns the Router's other addresses
		// from its own register reply, so this address only has to work once, from wherever that
		// machine stands.
		val transport = if (direct) {
			GatewayTransport(
				transport = "direct",
				routerUrl = result.routerUrl,
				routerCertFp = result.routerCertFp,
				bearer = result.bearer,
			)
		} else {
			GatewayTransport(apiUrl = prov.apiUrl, saToken = result.saToken, caPem = result.caPem)
		}
		val frame = repo.federation.sealBundle(nonce, transport, signed, scanned.boxPub, prov.pendingTenant?.domainId)
		val frameJson = wireJson.encodeToString(GatewayBootstrapFrame.serializer(), frame)
		if (scanned.lanHost != null && scanned.lanPort != null && scanned.certFp != null && isPrivateLanHost(scanned.lanHost)) {
			val target = "${scanned.lanHost}:${scanned.lanPort}"
			when (val r = postBundle(scanned.lanHost, scanned.lanPort, scanned.certFp, frameJson)) {
				is BundlePost.Ok -> {
					DebugLog.log("Enroll", "LAN delivery ok -> $target")
					return@withContext EnrollDelivery(true, "Sent to the Gateway. It's coming online.", null)
				}
				is BundlePost.Rejected -> {
					DebugLog.log("Enroll", "LAN delivery rejected $target HTTP ${r.code} body=${r.body}")
					return@withContext EnrollDelivery(
						true,
						"The Gateway rejected the bundle (HTTP ${r.code}). Paste it into the Gateway's terminal instead.",
						frameJson,
					)
				}
				is BundlePost.Unreachable -> {
					DebugLog.log("Enroll", "LAN delivery unreachable $target cause=${r.cause}")
					return@withContext EnrollDelivery(
						true,
						"Couldn't reach the Gateway over the LAN. Paste the bundle into its terminal instead.",
						frameJson,
					)
				}
			}
		}
		EnrollDelivery(true, "Added. Copy the bundle to the Gateway's enrollment prompt.", frameJson)
	}

	/** The outcome of a LAN bundle POST, split so a Gateway-side rejection (a 4xx - meaning the bundle
	 * WAS delivered) is never reported as "couldn't reach": the two need very different user fixes. */
	private sealed interface BundlePost {
		object Ok : BundlePost
		data class Rejected(val code: Int, val body: String) : BundlePost
		data class Unreachable(val cause: String) : BundlePost
	}

	/** POST the sealed bundle to the Gateway's arming-only LAN listener over TLS pinned to the leaf
	 * fingerprint from the QR (see EnrollPinning). The bundle is already sealed to the Gateway box key,
	 * so this TLS only satisfies Android's no-cleartext policy without an app-wide permit and keeps the
	 * LAN wire private. Separates a connect failure from a Gateway-side rejection. */
	private fun postBundle(host: String, port: Int, certFp: String, frameJson: String): BundlePost {
		val client = buildLeafFingerprintPinnedClient(certFp)
		val req = Request.Builder()
			.url("https://$host:$port/enroll")
			.post(frameJson.toRequestBody("application/json".toMediaType()))
			.build()
		return try {
			client.newCall(req).execute().use { resp ->
				if (resp.isSuccessful) BundlePost.Ok
				else BundlePost.Rejected(resp.code, resp.body?.string()?.take(200) ?: "")
			}
		} catch (e: Exception) {
			BundlePost.Unreachable("${e.javaClass.simpleName}: ${e.message?.take(160) ?: ""}")
		}
	}

	/** True only for a private / loopback / link-local IP LITERAL. The admit-gateway QR
	 * carries the Gateway's LAN address and we POST the sealed bundle there, so restricting
	 * the target to an actual LAN address stops a tampered QR from redirecting the bundle
	 * (and the console's plaintext identity metadata) to a public attacker host - a non-LAN
	 * value falls through to the paste path instead. Numeric only: a QR-supplied hostname is
	 * never resolved, since that resolution is itself an attacker-chosen network call. */
	private fun isPrivateLanHost(host: String): Boolean = runCatching {
		android.net.InetAddresses.isNumericAddress(host) &&
			java.net.InetAddress.getByName(host).let { it.isLoopbackAddress || it.isSiteLocalAddress || it.isLinkLocalAddress }
	}.getOrDefault(false)
}
