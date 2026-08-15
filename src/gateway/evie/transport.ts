import fs from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

/** The Gateway's reach-relay credentials: the self-hosted Router, dialed by URL and pinned by its
 * leaf fingerprint. `transport` survives the k8s retirement as a stored discriminant, since blobs
 * written before it still carry the field and a Gateway must reject one rather than mis-read it. */
export interface EvieTransport {
	transport: "direct";
	routerUrl: string;
	routerCertFp: string;
	bearer: string;
}

type RawTransport = Partial<EvieTransport>;

////////////////////////////////
//  Functions & Helpers

function normalize(raw: RawTransport): EvieTransport | null {
	if (raw.transport !== "direct" || !raw.routerUrl || !raw.routerCertFp || !raw.bearer) return null;
	return {
		transport: "direct",
		routerUrl: raw.routerUrl.replace(/\/$/, ""),
		routerCertFp: raw.routerCertFp.toLowerCase(),
		bearer: raw.bearer,
	};
}

/** Resolve the transport from `transport.json` in the federation dir. Null when it is absent,
 * unparseable, or not the direct shape, which leaves the gateway standalone and armed for
 * enrollment rather than dialing something it cannot authenticate. */
export function loadEvieTransport(federationDir: string): EvieTransport | null {
	const file = path.join(federationDir, "transport.json");
	if (!fs.existsSync(file)) return null;
	try {
		return normalize(JSON.parse(fs.readFileSync(file, "utf8")) as RawTransport);
	} catch {
		return null;
	}
}

/** Build the WebSocket connection params. The Router's cert is self-signed and carries no useful
 * subject, so the leaf fingerprint IS the trust and hostname verification is irrelevant. */
export function evieWsConnection(t: EvieTransport): {
	url: string;
	headers: Record<string, string>;
	tls: { certFp: string };
} {
	return {
		url: t.routerUrl.replace(/^http/, "ws"),
		headers: { Authorization: `Bearer ${t.bearer}` },
		tls: { certFp: t.routerCertFp },
	};
}
