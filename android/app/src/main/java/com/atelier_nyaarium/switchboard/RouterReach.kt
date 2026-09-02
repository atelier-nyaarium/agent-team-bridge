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
 *
 * The TWIN of `src/shared/router-reach.ts`, held equivalent by tests/fixtures/router-reach/vectors.json,
 * which RouterReachVectorsTest and the vitest suite both iterate. The Gateway runs the same rule over
 * its own transport, so a change here that is not made there diverges two clients of one Router.
 */
fun reachCandidates(reach: RouterReach, blobRouterUrl: String, routerPort: Int): List<String> {
	// Anything already carrying a scheme is a full base URL, kept verbatim; only a bare host gains
	// https and the port. Matched on "://" rather than an http prefix because the Gateway twin's
	// bootstrap can be ws:// or wss://.
	fun url(host: String, port: Int): String = if (host.contains("://")) host.trimEnd('/') else "https://$host:$port"
	// Every address goes through [usableHost] and every port through [usablePort], on all three
	// candidates. This side and the TypeScript twin disagreed on exactly that, invisibly: TS leaned on
	// truthiness, so a whitespace-only address built `https://   :20001` there and was dropped here,
	// and a publicPort of 0 became the Router's own port there and was dialed as 0 here. Same
	// advertised reach, two clients of one Router, two different sockets.
	return buildList {
		reach.lanAddresses.forEach { lan -> usableHost(lan)?.let { add(url(it, routerPort)) } }
		usableHost(reach.publicHost)?.let { add(url(it, usablePort(reach.publicPort) ?: routerPort)) }
		usableHost(blobRouterUrl)?.let { add(url(it, routerPort)) }
	}.distinct()
}

/** The next candidate after an unreachable base, or null when there is nowhere to go. A base that is
 * no longer the current one means a concurrent attempt already moved the ring, so the answer is that
 * attempt's choice rather than a second advance past it. Wrapping is what carries a phone off a LAN
 * address it can no longer see and back again once it can. */
fun nextReachIndex(candidates: List<String>, current: Int, base: String): Int? = when {
	base != candidates.getOrNull(current) -> current.takeIf { candidates.isNotEmpty() }
	candidates.size < 2 -> null
	else -> (current + 1) % candidates.size
}

/** An address worth dialing, trimmed, or null. Blank is dropped rather than trimmed to nothing and
 * dialed: an address made only of whitespace names no host, and building a URL from it spends a
 * whole connect timeout proving it. Padding is stripped rather than rejected, since a padded address
 * is a producer's slip and the host inside it is real.
 *
 * `isNotBlank` alone was this side's old rule and was not enough: it KEEPS a padded address, so
 * " 192.168.1.5 " became `https:// 192.168.1.5 :20001` here while the twin kept it too. */
fun usableHost(host: String?): String? = host?.trim()?.takeIf { it.isNotEmpty() }

/** A port worth dialing, or null for the caller's own default. Checked explicitly rather than by
 * nullishness, which is what split the two runtimes on 0: `?:` here kept it and `||` there replaced
 * it, and neither was right, since 0 is not a valid port. */
fun usablePort(port: Int?): Int? = port?.takeIf { it in 1..65535 }

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
	usablePort(runCatching { java.net.URI(blobRouterUrl).port }.getOrNull()) ?: default
