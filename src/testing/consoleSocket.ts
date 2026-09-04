// The phone's console socket against the Router's real TLS listener: hello in, pushes out.

import WebSocket from "ws";
import { APP_TOKEN_HEADER } from "../federation-server/consoleSurface.js";
import type { OwnerOp } from "../shared/schemasInbox.js";
import type { Frame } from "./fakeSocket.js";

export interface ConsoleSocket {
	/** Every frame the Router pushed, in order. */
	frames: Frame[];
	send(frame: Frame): void;
	close(): Promise<void>;
}

export interface ConsoleSocketOptions {
	port: number;
	token: string;
	hello: OwnerOp;
	/** Plane-only sockets register no inbox consumer. */
	planesOnly?: boolean;
}

export function openConsoleSocket(options: ConsoleSocketOptions): Promise<ConsoleSocket> {
	const frames: Frame[] = [];
	const ws = new WebSocket(`wss://127.0.0.1:${options.port}/console`, {
		headers: { [APP_TOKEN_HEADER]: `Bearer ${options.token}` },
		rejectUnauthorized: false,
	});
	return new Promise((resolve, reject) => {
		ws.once("error", reject);
		ws.on("message", (data) => {
			frames.push(JSON.parse(String(data)) as Frame);
		});
		ws.once("open", () => {
			ws.send(
				JSON.stringify({
					type: "hello",
					ownerOp: options.hello,
					...(options.planesOnly ? { mode: "planes" } : {}),
				}),
			);
			resolve({
				frames,
				send: (frame) => ws.send(JSON.stringify(frame)),
				close: () =>
					new Promise((done) => {
						if (ws.readyState === WebSocket.CLOSED) return done();
						ws.once("close", () => done());
						ws.close();
					}),
			});
		});
	});
}
