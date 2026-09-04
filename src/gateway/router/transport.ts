import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ROUTER_PORT, type RouterReach } from "../../shared/router-reach.js";
import { BEARER_PREFIX } from "../../shared/wire-vocabulary.js";

////////////////////////////////
//  Interfaces & Types

/** The Gateway's reach-relay credentials: the self-hosted Router, dialed by URL and pinned by its
 * leaf fingerprint. */
export interface RouterTransport {
	routerUrl: string;
	routerCertFp: string;
	bearer: string;
}

type RawTransport = Partial<RouterTransport>;

////////////////////////////////
//  Functions & Helpers

// All three or nothing: a file missing any of them leaves the gateway standalone rather than
// half-configured, which is also what refuses a file written in a retired shape.
function normalize(raw: RawTransport): RouterTransport | null {
	if (!raw.routerUrl || !raw.routerCertFp || !raw.bearer) return null;
	return {
		routerUrl: raw.routerUrl.replace(/\/$/, ""),
		routerCertFp: raw.routerCertFp.toLowerCase(),
		bearer: raw.bearer,
	};
}

/** Resolve the transport from `transport.json` in the federation dir. Null when it is absent,
 * unparseable, or not the direct shape, which leaves the gateway standalone and armed for
 * enrollment rather than dialing something it cannot authenticate. */
export function loadRouterTransport(federationDir: string): RouterTransport | null {
	const file = path.join(federationDir, "transport.json");
	if (!fs.existsSync(file)) return null;
	try {
		return normalize(JSON.parse(fs.readFileSync(file, "utf8")) as RawTransport);
	} catch {
		return null;
	}
}

/** Build the WebSocket connection params. The Router's cert is self-signed and carries no useful
 * subject, so the leaf fingerprint IS the trust and hostname verification is irrelevant.
 *
 * `url` is the BOOTSTRAP only: the client re-derives its dial ring from what the Router advertises,
 * and this stays as the last candidate. The ws:// rewrite happens per candidate in the client, so
 * this keeps the stored scheme. */
export function routerWsConnection(t: RouterTransport): {
	url: string;
	headers: Record<string, string>;
	tls: { certFp: string };
} {
	return {
		url: t.routerUrl,
		headers: { Authorization: BEARER_PREFIX + t.bearer },
		tls: { certFp: t.routerCertFp },
	};
}

/** The bootstrap address Gateway Setup wrote, as a base URL, or null when it asked for none. The
 * operator names a door that works from where THIS machine stands; the phone's sealed bundle names
 * the Router's public host, which is not always reachable from the Router's own LAN. */
export function routerBootstrapOverride(hostValue: string | undefined, portValue: string | undefined): string | null {
	const host = (hostValue ?? "").trim();
	if (!host) return null;
	if (host.includes("://")) return host.replace(/\/+$/, "");
	const port = Number((portValue ?? "").trim()) || DEFAULT_ROUTER_PORT;
	return `https://${host}:${port}`;
}

////////////////////////////////
//  Learned reach

/** What the Router last told this Gateway about its own addresses. Its own file beside
 * `transport.json`, not merged into it: the transport is DELIVERED (sealed, by the owner's phone)
 * and must stay byte-stable, while this is LEARNED and rewritten on any register. A restart with a
 * stale copy is harmless, since the ring re-derives on the next reply. */
export function loadRouterReach(federationDir: string): RouterReach {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(federationDir, "reach.json"), "utf8")) as RouterReach;
		return {
			publicHost: typeof raw.publicHost === "string" ? raw.publicHost : null,
			publicPort: typeof raw.publicPort === "number" ? raw.publicPort : null,
			lanAddresses: Array.isArray(raw.lanAddresses) ? raw.lanAddresses.filter((a) => typeof a === "string") : [],
		};
	} catch {
		return {};
	}
}

/** Persist what the Router advertised. Never throws: losing this costs one extra ring walk after a
 * restart, and a Gateway that cannot write its cache must still stay connected. */
export function saveRouterReach(federationDir: string, reach: RouterReach): void {
	try {
		fs.writeFileSync(path.join(federationDir, "reach.json"), JSON.stringify(reach), { mode: 0o600 });
	} catch (e) {
		console.warn(`[router] could not cache the Router's reach: ${e instanceof Error ? e.message : e}`);
	}
}
