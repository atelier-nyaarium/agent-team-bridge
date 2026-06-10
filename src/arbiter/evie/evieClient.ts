import crypto from "node:crypto";
import WebSocket from "ws";
import type { PhoneRelayFrame } from "../../shared/phone-protocol.js";
import type { ChannelFile } from "../../shared/types.js";

////////////////////////////////
//  Interfaces & Types

export interface EvieToolSchema {
	name: string;
	title: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface EvieToolCallResult {
	callId: string;
	result?: unknown;
	error?: string;
}

export interface DmForwardPayload {
	content: string;
	userId: string;
	channelId: string;
	messageId: string;
	files?: ChannelFile[];
}

export interface EvieClientConfig {
	url: string;
	authToken: string;
	onToolRegistry?: (tools: EvieToolSchema[]) => void;
	onDmForward?: (dm: DmForwardPayload) => void;
	onPhoneRelay?: (frame: PhoneRelayFrame) => void;
	onDisconnect?: () => void;
}

export interface EvieClient {
	callTool: (action: string, params: Record<string, unknown>) => Promise<EvieToolCallResult>;
	isConnected: () => boolean;
	getToolSchemas: () => EvieToolSchema[];
	stop: () => void;
}

////////////////////////////////
//  Functions & Helpers

const RECONNECT_DELAY_MS = 5_000;
const TOOL_CALL_TIMEOUT_MS = 120_000;

export function startEvieClient(config: EvieClientConfig): EvieClient {
	let ws: WebSocket | null = null;
	let stopped = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let cachedTools: EvieToolSchema[] = [];
	const pendingCalls = new Map<
		string,
		{ resolve: (result: EvieToolCallResult) => void; timer: ReturnType<typeof setTimeout> }
	>();

	function connect(): void {
		if (stopped) return;

		console.log(`[evie-client] connecting to ${config.url}...`);

		ws = new WebSocket(config.url, {
			headers: { Authorization: `Bearer ${config.authToken}` },
		});

		ws.on("open", () => {
			console.log(`[evie-client] connected`);
		});

		ws.on("message", (raw: WebSocket.Data) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}

			if (msg.type === "tool_registry" && Array.isArray(msg.tools)) {
				cachedTools = msg.tools as EvieToolSchema[];
				console.log(`[evie-client] received ${cachedTools.length} tool schemas`);
				config.onToolRegistry?.(cachedTools);
			}

			if (msg.type === "dm_forward") {
				config.onDmForward?.(msg as unknown as DmForwardPayload);
			}

			if (msg.type === "phone_relay") {
				config.onPhoneRelay?.(msg as unknown as PhoneRelayFrame);
			}

			if (msg.type === "tool_result" || msg.type === "tool_error") {
				const callId = msg.callId as string;
				const pending = pendingCalls.get(callId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingCalls.delete(callId);
					if (msg.type === "tool_error") {
						pending.resolve({ callId, error: msg.error as string });
					} else {
						pending.resolve({ callId, result: msg.result });
					}
				}
			}
		});

		ws.on("close", () => {
			ws = null;
			// Fail in-flight calls now rather than letting each wait out its 120s
			// timer across a reconnect; callers see a fast retryable error.
			for (const [callId, pending] of pendingCalls) {
				clearTimeout(pending.timer);
				pending.resolve({ callId, error: `Disconnected from evie-bot` });
			}
			pendingCalls.clear();
			config.onDisconnect?.();
			if (!stopped) {
				console.error(`[evie-client] disconnected, reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
				scheduleReconnect();
			}
		});

		ws.on("error", (err: Error) => {
			console.error(`[evie-client] error: ${err.message}`);
		});
	}

	function scheduleReconnect(): void {
		if (stopped) return;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
	}

	async function callTool(action: string, params: Record<string, unknown>): Promise<EvieToolCallResult> {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return { callId: "", error: `Not connected to evie-bot` };
		}

		const callId = crypto.randomUUID();

		return new Promise<EvieToolCallResult>((resolve) => {
			const timer = setTimeout(() => {
				pendingCalls.delete(callId);
				resolve({ callId, error: `Tool call timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s` });
			}, TOOL_CALL_TIMEOUT_MS);

			pendingCalls.set(callId, { resolve, timer });

			ws!.send(
				JSON.stringify({
					type: "tool_call",
					callId,
					action,
					params,
				}),
			);
		});
	}

	function isConnected(): boolean {
		return ws !== null && ws.readyState === WebSocket.OPEN;
	}

	function getToolSchemas(): EvieToolSchema[] {
		return cachedTools;
	}

	function stop(): void {
		stopped = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		for (const [, pending] of pendingCalls) {
			clearTimeout(pending.timer);
			pending.resolve({ callId: "", error: `Client stopped` });
		}
		pendingCalls.clear();
		if (ws) {
			ws.close();
			ws = null;
		}
		console.log(`[evie-client] stopped`);
	}

	connect();

	return { callTool, isConnected, getToolSchemas, stop };
}
