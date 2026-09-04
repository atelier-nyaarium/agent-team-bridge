// A socket the gateway's WebSocket handlers accept, with a real send the peer side reads.

import type { ServerWebSocket } from "bun";
import type { WsData } from "../gateway/wsTypes.js";

export type Frame = Record<string, unknown>;

export interface FakeSocket {
	ws: ServerWebSocket<WsData>;
	/** Every frame the gateway sent this socket, in order. */
	sent: Frame[];
	/** Called for every frame the gateway sends, after the current handler returns. */
	onFrame: (handler: (frame: Frame) => void) => void;
}

export function createFakeSocket(): FakeSocket {
	const sent: Frame[] = [];
	const handlers: Array<(frame: Frame) => void> = [];
	const ws = {
		data: {
			teamName: null,
			subId: "",
			conversationId: null,
			mode: "channel",
			missedPings: 0,
			isStale: false,
			handshakeConfirmed: false,
		} as WsData,
		readyState: 1,
		send(text: string) {
			const frame = JSON.parse(text) as Frame;
			sent.push(frame);
			// Never re-enter mid-update.
			queueMicrotask(() => {
				for (const handler of handlers) handler(frame);
			});
		},
		close() {
			ws.readyState = 3;
		},
		ping() {},
	};
	return {
		ws: ws as unknown as ServerWebSocket<WsData>,
		sent,
		onFrame: (handler) => {
			handlers.push(handler);
		},
	};
}
