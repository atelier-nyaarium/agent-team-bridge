package com.atelier_nyaarium.switchboard

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Router's own port. */
const val DEFAULT_ROUTER_PORT = 20001

/** Router reachability snapshot. */
@Serializable
data class RouterReach(
	val publicHost: String? = null,
	/** Public forwarding port. */
	val publicPort: Int? = null,
	val lanAddresses: List<String> = emptyList(),
	/** Domain admitting this console, when the request named its signer. */
	val domainId: String? = null,
) {
	fun encode(): String = json.encodeToString(this)

	companion object {
		private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

		fun decode(text: String?): RouterReach = text?.let { runCatching { json.decodeFromString<RouterReach>(it) }.getOrNull() } ?: RouterReach()
	}
}

/** Candidates: LAN, public, configured URL. */
fun reachCandidates(reach: RouterReach, blobRouterUrl: String, routerPort: Int): List<String> {
	// Preserve any scheme.
	fun url(host: String, port: Int): String = if (host.contains("://")) host.trimEnd('/') else "https://$host:$port"
	// LAN uses the Router port; public uses its forwarded port.
	return buildList {
		reach.lanAddresses.forEach { lan -> usableHost(lan)?.let { add(url(it, routerPort)) } }
		usableHost(reach.publicHost)?.let { add(url(it, usablePort(reach.publicPort) ?: routerPort)) }
		usableHost(blobRouterUrl)?.let { add(url(it, routerPort)) }
	}.distinct()
}

/** Advance with wraparound, preserve concurrent advances. */
fun nextReachIndex(candidates: List<String>, current: Int, base: String): Int? = when {
	base != candidates.getOrNull(current) -> current.takeIf { candidates.isNotEmpty() }
	candidates.size < 2 -> null
	else -> (current + 1) % candidates.size
}

/** Trimmed nonblank host. */
fun usableHost(host: String?): String? = host?.trim()?.takeIf { it.isNotEmpty() }

/** Valid port, or null. */
fun usablePort(port: Int?): Int? = port?.takeIf { it in 1..65535 }

/** Short timeout for private addresses. */
const val LAN_CONNECT_TIMEOUT_MS = 2_000L

/** Literal private or loopback host. */
fun isPrivateHost(host: String): Boolean =
	host.startsWith("10.") ||
		host.startsWith("192.168.") ||
		host.startsWith("169.254.") ||
		host == "localhost" ||
		host.startsWith("127.") ||
		Regex("""^172\.(1[6-9]|2\d|3[01])\.""").containsMatchIn(host)

/** Port from URL, or default. */
fun reachPort(blobRouterUrl: String, default: Int): Int =
	usablePort(runCatching { java.net.URI(blobRouterUrl).port }.getOrNull()) ?: default
