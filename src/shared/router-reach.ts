// One Router, several addresses, and which one answers depends on where the client is standing. At
// home the LAN address answers and the public one may not (a home router that does not hairpin drops
// a LAN-to-public SYN); away, the reverse. This is the ORDER every client tries them in, and nothing
// else: the phone runs it per HTTP op, the Gateway runs it per WS reconnect, and they consume the
// list differently on purpose.
//
// The Kotlin twin is `android/.../RouterReach.kt`, held equivalent by
// `tests/fixtures/router-reach/vectors.json`. Two hand-written copies of an ordering rule drift, and
// the drift shows up as an outage in exactly one physical location, which is the hardest kind to see.

////////////////////////////////
//  Constants

/** The Router's own port. Every LAN address is served on it; only the public host may sit behind a
 * forward that remaps it. */
export const DEFAULT_ROUTER_PORT = 20001;

/** A private address answers from the same subnet or not at all, so it gets seconds rather than a
 * full connect timeout. This is what makes "LAN first, always" cheap when away from home: a wrong
 * guess costs this, once, instead of a long stall on every attempt. */
export const LAN_CONNECT_TIMEOUT_MS = 2_000;

////////////////////////////////
//  Interfaces & Types

/** What the Router said about itself. Every field optional-shaped: a Router that has been told
 * nothing advertises nothing, and the client then keeps whatever address it already had. */
export interface RouterReach {
	publicHost?: string | null;
	/** The port the public host is forwarded on. Absent means the Router's own. */
	publicPort?: number | null;
	lanAddresses?: string[];
}

////////////////////////////////
//  Functions & Helpers

/** True for an RFC1918 / loopback / link-local host, i.e. one reachable only from the same network.
 * Matched on the literal address, never by resolving: a DNS lookup inside a routing decision is a
 * network call, and a name that resolves to a private address is still dialed on its own merits. */
export function isPrivateHost(host: string): boolean {
	return (
		host.startsWith("10.") ||
		host.startsWith("192.168.") ||
		host.startsWith("169.254.") ||
		host.startsWith("127.") ||
		host === "localhost" ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host)
	);
}

/**
 * The ordered base URLs to try. Pure, so the rule is testable without a socket:
 *
 * 1. Every LAN address. At home these answer in milliseconds and never leave the network; away they
 *    are unroutable and fail inside LAN_CONNECT_TIMEOUT_MS, so trying them first is nearly free.
 * 2. The public host, on `publicPort` when one was advertised, else the Router's own port. Behind
 *    the LAN ones because reaching it from inside depends on the home router hairpinning, which some
 *    do only intermittently.
 * 3. The bootstrap address last, deduplicated. Whatever the owner typed or was handed at setup: still
 *    a real address, and all a Router that advertises nothing leaves us.
 *
 * Deliberately NO "last address that worked". One existed on the phone and was removed: connecting
 * once from away recorded the public host, which then jumped the queue at home and paid a full
 * hairpin timeout on every cold start. It optimised the rare case and pessimised the common one.
 */
export function reachCandidates(reach: RouterReach, bootstrapUrl: string, routerPort: number): string[] {
	// Anything already carrying a scheme is a full base URL and is kept verbatim; only a bare host
	// gains https and the port. Matched on "://" rather than an http prefix because the Gateway's
	// bootstrap can be ws:// or wss://, and prefixing THAT with https yields an address that
	// resolves to nothing and fails as a connect error rather than a visible mistake.
	const url = (host: string, port: number): string =>
		host.includes("://") ? host.replace(/\/+$/, "") : `https://${host}:${port}`;
	const out: string[] = [];
	// Every address goes through `usableHost` and every port through `usablePort`, on all three
	// candidates. The two runtimes disagreed on exactly this and the disagreement was invisible: the
	// TypeScript side leaned on truthiness, so a whitespace-only address built `https://   :20001` and
	// a `publicPort` of 0 silently became the Router's own, while Kotlin dropped the first and dialed
	// the second. Same advertised reach, two clients, two different sockets.
	for (const lan of reach.lanAddresses ?? []) {
		const host = usableHost(lan);
		if (host) out.push(url(host, routerPort));
	}
	const publicHost = usableHost(reach.publicHost);
	if (publicHost) out.push(url(publicHost, usablePort(reach.publicPort) ?? routerPort));
	const bootstrap = usableHost(bootstrapUrl);
	if (bootstrap) out.push(url(bootstrap, routerPort));
	return [...new Set(out)];
}

/** An address worth dialing, trimmed, or null. Blank is dropped rather than trimmed to nothing and
 * dialed: an address made only of whitespace names no host, and building a URL from it spends a
 * whole connect timeout proving it. Padding is stripped rather than rejected, since a padded address
 * is a producer's slip and the host inside it is real. */
export function usableHost(host: string | null | undefined): string | null {
	if (typeof host !== "string") return null;
	const trimmed = host.trim();
	return trimmed === "" ? null : trimmed;
}

/** A port worth dialing, or null for the caller's own default. Checked explicitly rather than by
 * falsiness or nullishness, which is what split the two runtimes on 0: neither language's operator
 * was right, since 0 is not a valid port and must not resolve to one silently on either side. */
export function usablePort(port: number | null | undefined): number | null {
	return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** The port a base URL names, else `fallback`. */
export function reachPort(baseUrl: string, fallback: number): number {
	try {
		return usablePort(Number(new URL(baseUrl).port)) ?? fallback;
	} catch {
		return fallback;
	}
}

/** The host a base URL names, else the input unchanged (it was a bare host to begin with). */
export function reachHost(baseUrl: string): string {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return baseUrl;
	}
}
