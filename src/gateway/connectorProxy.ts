import type { ServerWebSocket } from "bun";
import WebSocket from "ws";
import type { Ambient } from "../shared/ambient.js";
import type { WsData } from "./wsTypes.js";

const upstreamMap = new Map<ServerWebSocket<WsData>, WebSocket>();

// Termination triggers cleanup during CONNECTING.
const CONNECT_DEADLINE_MS = 15_000;

/** Caller must validate project against the trusted host catalog. */
export function setupProxy(
	clientWs: ServerWebSocket<WsData>,
	project: string,
	authHeader: string,
	ambient: Pick<Ambient, "setTimer" | "clearTimer">,
): void {
	const url = `ws://${project}:20002/ws`;
	const upstream = new WebSocket(url, { headers: authHeader ? { Authorization: authHeader } : {} });

	// A stalled CONNECTING dial emits no cleanup event.
	const connectDeadline = ambient.setTimer(() => {
		console.log(`[proxy] upstream ${project} never connected, giving up`);
		upstream.terminate();
	}, CONNECT_DEADLINE_MS);

	upstream.on("open", () => {
		ambient.clearTimer(connectDeadline);
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
			// Client may already be closed.
		}
	});

	upstream.on("close", () => {
		ambient.clearTimer(connectDeadline);
		console.log(`[proxy] upstream ${project} closed`);
		upstreamMap.delete(clientWs);
		try {
			clientWs.close();
		} catch {
			// Client may already be closed.
		}
	});

	upstream.on("error", (err) => {
		ambient.clearTimer(connectDeadline);
		console.log(`[proxy] upstream ${project} error: ${err.message}`);
		upstreamMap.delete(clientWs);
		try {
			clientWs.close();
		} catch {
			// Client may already be closed.
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
		// Upstream may already be closed.
	}
}

export function isProxyConnection(ws: ServerWebSocket<WsData>): boolean {
	return upstreamMap.has(ws);
}
