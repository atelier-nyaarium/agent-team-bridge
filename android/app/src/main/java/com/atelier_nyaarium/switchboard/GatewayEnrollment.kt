package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapFrame
import com.atelier_nyaarium.switchboard.proto.GatewayTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

internal class GatewayEnrollment(private val repo: ChatRepository) {
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

	suspend fun enrollGateway(scanned: ScannedGateway): EnrollDelivery = withContext(Dispatchers.IO) {
		val signed = repo.ownerFacts.admitGateway(scanned.gatewayId, scanned.signPub, scanned.boxPub)
			?: return@withContext EnrollDelivery(false, repo._state.value.error ?: "Couldn't add the Gateway. Try again.", null)
		val nonce = scanned.nonce
			?: return@withContext EnrollDelivery(true, "Added. This Gateway will come online shortly.", null)
		val prov = runCatching { repo.store.load()?.let { ConsoleCredentials.parse(it, repo.store) } }.getOrNull()
			?: return@withContext EnrollDelivery(true, "Added, but this device is not provisioned - re-import your setup blob.", null)
		val result = try {
			repo.client().requestGatewayTransport(repo.federation.signTransportRequest(System.currentTimeMillis()))
		} catch (e: Exception) {
			e.rethrowIfCancellation()
			return@withContext EnrollDelivery(
				true,
				"Added, but couldn't finish Gateway setup: ${e.message?.take(120) ?: "unknown error"}",
				null,
			)
		}
		val missing = result.routerUrl == null || result.routerCertFp == null || result.bearer == null
		if (!result.ok || missing) {
			return@withContext EnrollDelivery(
				true,
				"Added, but couldn't finish Gateway setup: ${result.error?.take(120) ?: "transport unavailable"}",
				null,
			)
		}
		val transport = GatewayTransport(
			routerUrl = result.routerUrl,
			routerCertFp = result.routerCertFp,
			bearer = result.bearer,
		)
		val contentKeys = repo.readyOrNull()?.contentKeyring ?: error("Domain not yet confirmed by a local session")
		val frame = repo.federation.sealBundle(nonce, transport, signed, scanned.boxPub, prov.pendingTenant?.domainId, contentKeys)
		val frameJson = wireJson.encodeToString(GatewayBootstrapFrame.serializer(), frame)
		// Bound the paste fallback size.
		val pasteFrame = repo.federation.sealBundle(
			nonce,
			transport,
			signed,
			scanned.boxPub,
			prov.pendingTenant?.domainId,
			contentKeys,
			maxContentEpochs = 3,
		)
		val pasteFrameJson = wireJson.encodeToString(GatewayBootstrapFrame.serializer(), pasteFrame)
		return@withContext deliver(scanned.gatewayId, frameJson, pasteFrameJson, scanned.lanHost, scanned.lanPort, scanned.certFp)
	}

	suspend fun resumeEnroll(gatewayId: String): EnrollDelivery = withContext(Dispatchers.IO) {
		val p = pendingEnrolls()[gatewayId]
			?: return@withContext EnrollDelivery(true, "Nothing left to finish for this Gateway.", null)
		return@withContext deliver(p.gatewayId, p.bundle, p.bundle, p.lanHost, p.lanPort, p.certFp)
	}

	fun pendingEnrolls(): Map<String, PendingEnroll> = decodePendingEnrolls(repo.store.loadPendingEnrolls())

	fun clearPending(gatewayId: String) {
		val now = pendingEnrolls()
		if (!now.containsKey(gatewayId)) return
		repo.store.savePendingEnrolls(encodePendingEnrolls(now - gatewayId))
	}

	private fun notePending(p: PendingEnroll) {
		repo.store.savePendingEnrolls(encodePendingEnrolls(pendingEnrolls() + (p.gatewayId to p)))
	}

	private fun deliver(
		gatewayId: String,
		frameJson: String,
		pasteFrameJson: String,
		lanHost: String?,
		lanPort: Int?,
		certFp: String?,
	): EnrollDelivery {
		val usable = lanHost != null && lanPort != null && certFp != null && isPrivateLanHost(lanHost)
		val fallback = pasteFrameJson
		val pending = PendingEnroll(
			gatewayId = gatewayId,
			bundle = fallback,
			lanHost = if (usable) lanHost else null,
			lanPort = if (usable) lanPort else null,
			certFp = if (usable) certFp else null,
			at = System.currentTimeMillis(),
		)
		// Persist before POST for recovery.
		notePending(pending)
		if (!usable) {
			return EnrollDelivery(true, "Added. Copy the bundle to the Gateway's enrollment prompt.", fallback)
		}
		val target = "$lanHost:$lanPort"
		return when (val r = postBundle(lanHost, lanPort, certFp, frameJson)) {
			is BundlePost.Ok -> {
				DebugLog.log("Enroll", "LAN delivery ok -> $target")
				clearPending(gatewayId)
				EnrollDelivery(true, "Sent to the Gateway. It's coming online.", null)
			}
			is BundlePost.Rejected -> {
				DebugLog.log("Enroll", "LAN delivery rejected $target HTTP ${r.code} body=${r.body}")
				// A 404 makes the bundle unusable.
				val stale = r.code == 404
				val msg = if (stale) {
					"That Gateway is not accepting enrollment now. Re-arm it with ./setup.sh, then scan its new code."
				} else {
					"The Gateway rejected the bundle (HTTP ${r.code}). Paste it into the Gateway's terminal instead."
				}
				notePending(pending.copy(lastError = msg))
				EnrollDelivery(true, msg, if (stale) null else fallback)
			}
			is BundlePost.Unreachable -> {
				DebugLog.log("Enroll", "LAN delivery unreachable $target cause=${r.cause}")
				val msg = "Couldn't reach the Gateway over the LAN. Paste the bundle into its terminal instead."
				notePending(pending.copy(lastError = msg))
				EnrollDelivery(true, msg, fallback)
			}
		}
	}

	private sealed interface BundlePost {
		object Ok : BundlePost
		data class Rejected(val code: Int, val body: String) : BundlePost
		data class Unreachable(val cause: String) : BundlePost
	}

	// Pin TLS to the QR fingerprint.
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

	// Accept private IP literals only.
	private fun isPrivateLanHost(host: String): Boolean = runCatching {
		android.net.InetAddresses.isNumericAddress(host) &&
			java.net.InetAddress.getByName(host).let { it.isLoopbackAddress || it.isSiteLocalAddress || it.isLinkLocalAddress }
	}.getOrDefault(false)
}
