import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ROUTER_PORT, type RouterReach } from "../../shared/router-reach.js";
import { BEARER_PREFIX } from "../../shared/wire-vocabulary.js";

export interface RouterTransport {
	routerUrl: string;
	routerCertFp: string;
	bearer: string;
}

type RawTransport = Partial<RouterTransport>;

// Missing fields keep the Gateway standalone.
function normalize(raw: RawTransport): RouterTransport | null {
	if (!raw.routerUrl || !raw.routerCertFp || !raw.bearer) return null;
	return {
		routerUrl: raw.routerUrl.replace(/\/$/, ""),
		routerCertFp: raw.routerCertFp.toLowerCase(),
		bearer: raw.bearer,
	};
}

export function loadRouterTransport(federationDir: string): RouterTransport | null {
	const file = path.join(federationDir, "transport.json");
	if (!fs.existsSync(file)) return null;
	try {
		return normalize(JSON.parse(fs.readFileSync(file, "utf8")) as RawTransport);
	} catch {
		return null;
	}
}

export function routerWsConnection(t: RouterTransport): {
	url: string;
	headers: Record<string, string>;
	tls: { certFp: string };
} {
	return {
		url: t.routerUrl,
		headers: { Authorization: BEARER_PREFIX + t.bearer },
		// Use the pinned leaf as the Router trust anchor.
		tls: { certFp: t.routerCertFp },
	};
}

export function routerBootstrapOverride(hostValue: string | undefined, portValue: string | undefined): string | null {
	const host = (hostValue ?? "").trim();
	if (!host) return null;
	if (host.includes("://")) return host.replace(/\/+$/, "");
	const port = Number((portValue ?? "").trim()) || DEFAULT_ROUTER_PORT;
	return `https://${host}:${port}`;
}

// Keep learned reach separate from credentials.
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

export function saveRouterReach(federationDir: string, reach: RouterReach): void {
	try {
		fs.writeFileSync(path.join(federationDir, "reach.json"), JSON.stringify(reach), { mode: 0o600 });
	} catch (e) {
		console.warn(`[router] could not cache the Router's reach: ${e instanceof Error ? e.message : e}`);
	}
}
