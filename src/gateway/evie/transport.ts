import fs from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

/** The Gateway's reach-evie credentials: the same SA-token-over-service-proxy shape the
 * Console uses, so one mechanism serves both members. Delivered host-side for the local
 * Gateway (provision-owner) or inside the sealed bootstrap bundle for a remote one. */
export interface EvieTransport {
	apiUrl: string;
	namespace: string;
	saToken: string;
	caPem: string;
	service: string;
	port: number;
}

////////////////////////////////
//  Functions & Helpers

function normalize(raw: Partial<EvieTransport> & { apiUrl?: string }): EvieTransport | null {
	if (!raw.apiUrl || !raw.saToken || !raw.caPem) return null;
	return {
		apiUrl: raw.apiUrl.replace(/\/$/, ""),
		namespace: raw.namespace || "evie-bot",
		saToken: raw.saToken,
		caPem: raw.caPem,
		service: raw.service || "evie-bridge",
		port: raw.port || 20001,
	};
}

/** Resolve the service-proxy transport: the `EVIE_API_URL`/`EVIE_SA_TOKEN`/`EVIE_CA_PEM`
 * env trio first, else a `transport.json` written into the federation dir by enrollment.
 * Null when neither is present, which leaves the gateway off the evie bridge (standalone). */
export function loadEvieTransport(federationDir: string): EvieTransport | null {
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
	const file = path.join(federationDir, "transport.json");
	if (!fs.existsSync(file)) return null;
	try {
		return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

/** Build the WebSocket connection params for the service-proxy transport: a `wss://`
 * URL through the API server's service-proxy, the SA token as Authorization (the API
 * server authenticates it), and the cluster CA pinned for TLS. */
export function evieWsConnection(t: EvieTransport): {
	url: string;
	headers: Record<string, string>;
	tls: { ca: string };
} {
	const wsBase = t.apiUrl.replace(/^http/, "ws");
	const url = `${wsBase}/api/v1/namespaces/${t.namespace}/services/${t.service}:${t.port}/proxy/`;
	const headers: Record<string, string> = { Authorization: `Bearer ${t.saToken}` };
	return { url, headers, tls: { ca: t.caPem } };
}
