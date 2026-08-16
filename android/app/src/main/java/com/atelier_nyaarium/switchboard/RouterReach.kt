package com.atelier_nyaarium.switchboard

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** The Router's own port. Every LAN address is dialed on it; the public host may sit behind a port
 * forward that remaps it, which is what `publicPort` in [RouterReach] carries. */
const val DEFAULT_ROUTER_PORT = 20001

////////////////////////////////
//  How this device reaches its Router
//
//  One Router, several addresses, and which one works depends on where the phone is standing: at
//  home the LAN address answers and the public one does not (a home router that does not hairpin
//  drops a LAN-to-public SYN); away, the reverse. Nothing here is typed by the owner beyond the one
//  address they used to set up. The Router advertises the rest through the app-token-gated `reach`
//  op, this device remembers it, and every fresh connection tries the candidates in order.

/** What the Router said about itself. Survives an app restart; not a re-provision.
 *
 * Deliberately NO "last address that worked" field. One was tried and removed: connecting once from
 * away recorded the public host as preferred, which then jumped the queue at home and paid a full
 * hairpin timeout on every cold start. It optimised the rare case and pessimised the common one.
 * Ordering is a fixed rule instead, and the short LAN timeout below is what makes it cheap. */
@Serializable
data class RouterReach(
	val publicHost: String? = null,
	/** The port the public host is forwarded on. Absent means the Router's own port. */
	val publicPort: Int? = null,
	val lanAddresses: List<String> = emptyList(),
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
 * 1. Every LAN address. At home these answer in milliseconds and never leave the network; away they
 *    are unroutable and fail inside [LAN_CONNECT_TIMEOUT_MS], so trying them first is nearly free.
 * 2. The public host. The only one that works away from home, and behind the LAN ones because
 *    reaching it from inside depends on the home router hairpinning - which some do only
 *    intermittently, and an intermittent path is the hardest kind of outage to see.
 * 3. The blob's own `routerUrl` last, deduplicated. Whatever the owner typed at setup, which is
 *    still a real address and is all an older Router that advertises nothing leaves us.
 *
 * Every entry is a full base URL with scheme and port; the caller appends the path. LAN addresses
 * are dialed on [routerPort], the Router's own; the public host on its advertised `publicPort`, or
 * the Router's own when none is advertised. The two differ whenever a port forward remaps, and one
 * number for both is exactly the mistake that would dial the LAN on the forwarded port.
 */
fun reachCandidates(reach: RouterReach, blobRouterUrl: String, routerPort: Int): List<String> {
	fun url(host: String, port: Int): String = if (host.startsWith("http")) host.trimEnd('/') else "https://$host:$port"
	return buildList {
		reach.lanAddresses.forEach { add(url(it, routerPort)) }
		reach.publicHost?.takeIf { it.isNotBlank() }?.let { add(url(it, reach.publicPort ?: routerPort)) }
		if (blobRouterUrl.isNotBlank()) add(url(blobRouterUrl, routerPort))
	}.distinct()
}

/** A private address answers from the same subnet or not at all, so it gets seconds rather than the
 * full connect timeout. This is what makes "LAN first, always" cheap when away from home: the cost
 * of a wrong guess is this, once per process, not a 15-second stall on every launch. */
const val LAN_CONNECT_TIMEOUT_MS = 2_000L

/** True for an RFC1918 / link-local host, i.e. one only reachable from the same network. Matched on
 * the literal address, never by resolving: a DNS lookup here would be a network call inside a
 * routing decision, and a name that resolves to a private address is still dialed on its own merits. */
fun isPrivateHost(host: String): Boolean =
	host.startsWith("10.") ||
		host.startsWith("192.168.") ||
		host.startsWith("169.254.") ||
		host == "localhost" ||
		host.startsWith("127.") ||
		Regex("""^172\.(1[6-9]|2\d|3[01])\.""").containsMatchIn(host)

/** The port the blob's `routerUrl` names, else [default]. Used to keep a bootstrap rewrite on the
 * port the owner typed when the Router advertises none. */
fun reachPort(blobRouterUrl: String, default: Int): Int =
	runCatching { java.net.URI(blobRouterUrl).port }.getOrNull()?.takeIf { it > 0 } ?: default
