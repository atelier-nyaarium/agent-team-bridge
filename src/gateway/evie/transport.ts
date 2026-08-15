import fs from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

/** The Gateway's reach-relay credentials. Two shapes, told apart by `transport`:
 * `k8s` is the SA-token-over-service-proxy the console also uses; `direct` is the self-hosted
 * Router, dialed by URL and pinned by its leaf fingerprint. Absent reads as `k8s`. */
export interface EvieTransport {
	transport: "k8s" | "direct";
	apiUrl: string;
	namespace: string;
	saToken: string;
	caPem: string;
	service: string;
	port: number;
	routerUrl: string;
	routerCertFp: string;
	bearer: string;
}

type RawTransport = Partial<EvieTransport>;

////////////////////////////////
//  Functions & Helpers

function normalize(raw: RawTransport): EvieTransport | null {
	const direct = raw.transport === "direct";
	if (direct) {
		if (!raw.routerUrl || !raw.routerCertFp || !raw.bearer) return null;
	} else if (!raw.apiUrl || !raw.saToken || !raw.caPem) {
		return null;
	}
	return {
		transport: direct ? "direct" : "k8s",
		apiUrl: (raw.apiUrl ?? "").replace(/\/$/, ""),
		namespace: raw.namespace || "evie-bot",
		saToken: raw.saToken ?? "",
		caPem: raw.caPem ?? "",
		service: raw.service || "evie-bridge",
		port: raw.port || 20001,
		routerUrl: (raw.routerUrl ?? "").replace(/\/$/, ""),
		routerCertFp: (raw.routerCertFp ?? "").toLowerCase(),
		bearer: raw.bearer ?? "",
	};
}

/** Resolve the transport: the `EVIE_*` env trio first, else `transport.json` from the federation
 * dir. Null when neither resolves, which leaves the gateway standalone. The env branch only ever
 * describes the k8s shape, so it is skipped once a direct file exists - otherwise a stale env
 * would silently shadow the Router. */
export function loadEvieTransport(federationDir: string): EvieTransport | null {
	const file = path.join(federationDir, "transport.json");
	const fromFile = fs.existsSync(file)
		? (() => {
				try {
					return JSON.parse(fs.readFileSync(file, "utf8")) as RawTransport;
				} catch {
					return null;
				}
			})()
		: null;
	if (fromFile?.transport === "direct") return normalize(fromFile);
	if (process.env.EVIE_API_URL) {
		return normalize({
			apiUrl: process.env.EVIE_API_URL,
			namespace: process.env.EVIE_NAMESPACE,
			saToken: process.env.EVIE_SA_TOKEN,
			caPem: process.env.EVIE_CA_PEM,
			service: process.env.EVIE_BRIDGE_SERVICE,
			port: process.env.EVIE_BRIDGE_PROXY_PORT ? parseInt(process.env.EVIE_BRIDGE_PROXY_PORT, 10) : undefined,
		});
	}
	return fromFile ? normalize(fromFile) : null;
}

/** Build the WebSocket connection params. The k8s branch tunnels through the API server's
 * service-proxy with the SA token and the cluster CA pinned; the direct branch dials the Router
 * and pins its leaf fingerprint, which is why hostname verification is irrelevant there. */
export function evieWsConnection(t: EvieTransport): {
	url: string;
	headers: Record<string, string>;
	tls: { ca: string } | { certFp: string };
} {
	if (t.transport === "direct") {
		return {
			url: t.routerUrl.replace(/^http/, "ws"),
			headers: { Authorization: `Bearer ${t.bearer}` },
			tls: { certFp: t.routerCertFp },
		};
	}
	const wsBase = t.apiUrl.replace(/^http/, "ws");
	const url = `${wsBase}/api/v1/namespaces/${t.namespace}/services/${t.service}:${t.port}/proxy/`;
	const headers: Record<string, string> = { Authorization: `Bearer ${t.saToken}` };
	return { url, headers, tls: { ca: t.caPem } };
}
