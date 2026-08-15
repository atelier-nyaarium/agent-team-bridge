package com.atelier_nyaarium.switchboard

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** The Router's own port. Every address it advertises is served on this one port, so a fresh field
 * needs only a host typed into it and every candidate is dialed the same way. */
const val DEFAULT_ROUTER_PORT = 20001

////////////////////////////////
//  How this device reaches its Router
//
//  One Router, several addresses, and which one works depends on where the phone is standing: at
//  home the LAN address answers and the public one does not (a home router that does not hairpin
//  drops a LAN-to-public SYN); away, the reverse. Nothing here is typed by the owner beyond the one
//  address they used to set up. The Router advertises the rest through the app-token-gated `reach`
//  op, this device remembers it, and every fresh connection tries the candidates in order.

/** What the Router said about itself, plus which candidate answered last. All fields survive an
 * app restart; none survive a re-provision. */
@Serializable
data class RouterReach(
	val publicHost: String? = null,
	val lanAddresses: List<String> = emptyList(),
	/** The candidate that answered most recently. Tried first next time, so a stable location pays
	 * the fallback cost once, not on every call. */
	val preferred: String? = null,
) {
	fun encode(): String = json.encodeToString(this)

	companion object {
		private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

		fun decode(text: String?): RouterReach = text?.let { runCatching { json.decodeFromString<RouterReach>(it) }.getOrNull() } ?: RouterReach()
	}
}

/**
 * The ordered list of base URLs to try. Pure, so the rule is testable without a socket:
 *
 * 1. `preferred` first, when it is still one of the known candidates. It answered last time.
 * 2. Every LAN address. At home these answer instantly and never leave the network.
 * 3. The public host. The only one that works away from home; behind the LAN ones so a phone at
 *    home does not pay a hairpin timeout on every call.
 * 4. The blob's own `routerUrl` last, deduplicated. It is whatever the owner typed at setup, so it
 *    is still a real address, and it is what an older Router that advertises nothing leaves us.
 *
 * Every entry is a full base URL with scheme and port; the caller appends the path.
 */
fun reachCandidates(reach: RouterReach, blobRouterUrl: String, port: Int): List<String> {
	fun url(host: String): String = if (host.startsWith("http")) host.trimEnd('/') else "https://$host:$port"
	val ordered = buildList {
		reach.lanAddresses.forEach { add(url(it)) }
		reach.publicHost?.takeIf { it.isNotBlank() }?.let { add(url(it)) }
		if (blobRouterUrl.isNotBlank()) add(url(blobRouterUrl))
	}.distinct()
	val preferred = reach.preferred?.let { url(it) }
	return if (preferred != null && preferred in ordered) listOf(preferred) + (ordered - preferred) else ordered
}

/** The port a candidate is dialed on: the blob's `routerUrl` port when it has one, else the default.
 * A Router serves every address on the same port, so one number covers the whole list. */
fun reachPort(blobRouterUrl: String, default: Int): Int =
	runCatching { java.net.URI(blobRouterUrl).port }.getOrNull()?.takeIf { it > 0 } ?: default
