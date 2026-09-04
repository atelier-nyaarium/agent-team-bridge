// A session's MCP plugin as the gateway sees it.

import type { GatewayGraph } from "../gateway/composeGateway.js";
import { createFakeSocket, type Frame } from "./fakeSocket.js";

export interface FakeSessionOptions {
	/** `spawn.session`, the composite the register frame carries. */
	team: string;
	conversationId: string;
	sessionToken?: string;
	cwdName?: string;
}

export interface FakeSession {
	team: string;
	conversationId: string;
	/** Frames pushed to this session, handshakes excluded. */
	inbound: Frame[];
	/** Resolves once the gateway has confirmed the lead handshake. */
	ready(): Promise<void>;
	/** Posts a reply to a channel push, as the plugin's channel_reply does. */
	reply(sessionId: string, response: string, extra?: Record<string, unknown>): Promise<Response>;
	post(path: string, body: Record<string, unknown>): Promise<Response>;
	close(): void;
}

export function attachFakeSession(graph: GatewayGraph, options: FakeSessionOptions): FakeSession {
	const socket = createFakeSocket();
	const inbound: Frame[] = [];
	let confirm: () => void = () => undefined;
	const confirmed = new Promise<void>((resolve) => {
		confirm = resolve;
	});
	const post = (path: string, body: Record<string, unknown>): Promise<Response> =>
		graph.router(
			new Request(`http://gateway.test${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(options.sessionToken ? { "x-session-token": options.sessionToken } : {}),
				},
				body: JSON.stringify(body),
			}),
		);
	socket.onFrame((frame) => {
		if (frame.type !== "channel_push") return;
		if (frame.replyJsonSchema) {
			void post("/respond", {
				session_id: frame.session_id,
				replyAsJson: { isMainOrLead: true },
				conversationId: options.conversationId,
			}).then(() => confirm());
			return;
		}
		inbound.push(frame);
		if (typeof frame.delivery_id === "string") {
			graph.wsHandlers.message(
				socket.ws,
				JSON.stringify({ type: "channel_delivery_ack", delivery_id: frame.delivery_id }),
			);
		}
	});
	graph.wsHandlers.open(socket.ws);
	graph.wsHandlers.message(
		socket.ws,
		JSON.stringify({
			type: "register",
			team: options.team,
			subId: "fake-session",
			mode: "channel",
			conversationId: options.conversationId,
			version: "harness",
			deliveryProtocol: 1,
			cwdName: options.cwdName ?? options.team,
			...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
		}),
	);
	return {
		team: options.team,
		conversationId: options.conversationId,
		inbound,
		ready: () => confirmed,
		reply: (sessionId, response, extra = {}) =>
			post("/respond", { session_id: sessionId, response, conversationId: options.conversationId, ...extra }),
		post,
		close: () => {
			socket.ws.close();
			graph.wsHandlers.close(socket.ws);
		},
	};
}
