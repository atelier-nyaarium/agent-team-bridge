import type { ServerWebSocket } from "bun";
import WebSocket from "ws";
import type { WsData } from "./websocket.js";

const upstreamMap = new Map<ServerWebSocket<WsData>, WebSocket>();

// terminate() forces an error/close event even mid-CONNECTING, so the ordinary cleanup runs.
const CONNECT_DEADLINE_MS = 15_000;

/**
 * Bridges a client WebSocket to the per-project connector at ws://<project>:20002/ws.
 * The caller MUST validate `project` against the trusted host catalog (offlineCatalog) first:
 * this dials the name verbatim, so an unvalidated value is an SSRF vector. That gate lives at the
 * /connector upgrade site in index.ts, not here.
 */
export function setupProxy(clientWs: ServerWebSocket<WsData>, project: string, authHeader: string): void {
	const url = `ws://${project}:20002/ws`;
	const upstream = new WebSocket(url, { headers: authHeader ? { Authorization: authHeader } : {} });

	// A dial that hangs in CONNECTING emits neither close nor error, and those are the only two
	// cleanup paths - without a deadline the map retains both sockets forever.
	const connectDeadline = setTimeout(() => {
		console.log(`[proxy] upstream ${project} never connected, giving up`);
		upstream.terminate();
	}, CONNECT_DEADLINE_MS);

	upstream.on("open", () => {
		clearTimeout(connectDeadline);
		console.log(`[proxy] connected to upstream ${project}`);
	});

	upstream.on("message", (data) => {
		try {
			if (typeof data === "string") {
				clientWs.send(data);
			} else if (Buffer.isBuffer(data)) {
				clientWs.send(data);
			} else if (data instanceof ArrayBuffer) {
				clientWs.send(new Uint8Array(data));
			} else {
				clientWs.send(Buffer.concat(data));
			}
		} catch {
			// Client already closed
		}
	});

	upstream.on("close", () => {
		clearTimeout(connectDeadline);
		console.log(`[proxy] upstream ${project} closed`);
		upstreamMap.delete(clientWs);
		try {
			clientWs.close();
		} catch {
			// Already closed
		}
	});

	upstream.on("error", (err) => {
		clearTimeout(connectDeadline);
		console.log(`[proxy] upstream ${project} error: ${err.message}`);
		upstreamMap.delete(clientWs);
		try {
			clientWs.close();
		} catch {
			// Already closed
		}
	});

	upstreamMap.set(clientWs, upstream);
}

export function handleProxyMessage(clientWs: ServerWebSocket<WsData>, data: string | Buffer): void {
	const upstream = upstreamMap.get(clientWs);
	if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
	upstream.send(data);
}

export function handleProxyClose(clientWs: ServerWebSocket<WsData>): void {
	const upstream = upstreamMap.get(clientWs);
	upstreamMap.delete(clientWs);
	if (!upstream) return;
	console.log(`[proxy] client disconnected, closing upstream ${clientWs.data.proxyProject}`);
	try {
		if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
			upstream.close();
		}
	} catch {
		// Already closed
	}
}

export function isProxyConnection(ws: ServerWebSocket<WsData>): boolean {
	return upstreamMap.has(ws);
}
