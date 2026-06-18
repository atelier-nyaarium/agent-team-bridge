import type { ServerWebSocket } from "bun";
import WebSocket from "ws";
import type { WsData } from "./websocket.js";

const upstreamMap = new Map<ServerWebSocket<WsData>, WebSocket>();

export function setupProxy(clientWs: ServerWebSocket<WsData>, project: string, authHeader: string): void {
	const url = `ws://${project}:20002/ws`;
	const upstream = new WebSocket(url, { headers: authHeader ? { Authorization: authHeader } : {} });

	upstream.on("open", () => {
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
		console.log(`[proxy] upstream ${project} closed`);
		upstreamMap.delete(clientWs);
		try {
			clientWs.close();
		} catch {
			// Already closed
		}
	});

	upstream.on("error", (err) => {
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
