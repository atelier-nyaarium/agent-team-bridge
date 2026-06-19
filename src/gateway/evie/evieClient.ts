import crypto from "node:crypto";
import WebSocket from "ws";
import {
	type BridgeTool,
	EvieInboundFrameSchema,
	FEDERATION_PROTOCOL_VERSION,
	type ToolCallFrame,
} from "../../shared/evie-protocol.js";

////////////////////////////////
//  Interfaces & Types

export type EvieToolSchema = BridgeTool;

export interface EvieToolCallResult {
	callId: string;
	result?: unknown;
	error?: string;
}

export interface EvieClientConfig {
	url: string;
	// WebSocket handshake headers. Legacy (kubectl port-forward) carries the bridge
	// token as Authorization; the service-proxy transport carries the SA token as
	// Authorization (consumed by the API server) plus the bridge token in a forwarded
	// header, so the auth shape lives with the caller, not here.
	headers: Record<string, string>;
	// Cluster CA (PEM) to pin TLS against when dialing the service-proxy (wss://). Unset
	// for the legacy plaintext localhost tunnel.
	tls?: { ca: string };
	// This Gateway's id, registered with the Router on connect so cross-Gateway frames
	// can be routed to this Gateway.
	gatewayId: string;
	onToolRegistry?: (tools: EvieToolSchema[]) => void;
	// The relay pump owns full ConsoleRelayFrameSchema validation; the envelope
	// union only routes by type, so the frame travels as unknown.
	onConsoleRelay?: (frame: unknown) => void;
	// A cross-Gateway frame the Router routed to this Gateway; the gateway-relay pump owns
	// full GatewayRelayFrameSchema validation, so the frame travels as unknown.
	onGatewayRelay?: (frame: unknown) => void;
	// Extra `gateway_register` params (the admitted-identity proof: signPub/boxPub
	// + owner-signed admission + a fresh possession proof), computed at each
	// (re)register so the proof timestamp is current. Returns null pre-enrollment,
	// leaving registration token-only.
	buildRegisterAuth?: () => Record<string, unknown> | null;
	// The mirrored Domain (owner root + allowlist) evie returns in the register
	// reply; the Gateway applies it so a revocation bites even while evie is offline.
	// Travels as unknown; the consumer validates with DomainSnapshotSchema.
	onDomainSync?: (domain: unknown) => void;
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
// Application-level keepalive over the link. The k8s API service-proxy (and any LB in
// front of the apiserver) drops idle upgraded connections, so a ping well under that
// idle window keeps the tunnel warm AND detects a silently-dropped path: two missed
// pongs terminate the socket and trigger the normal reconnect. Mirrors the gateway's
// own team-socket heartbeat.
const HEARTBEAT_INTERVAL_MS = 20_000;
const MISSED_PONGS_LIMIT = 2;

export function startEvieClient(config: EvieClientConfig): EvieClient {
	let ws: WebSocket | null = null;
	let stopped = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let missedPongs = 0;
	let cachedTools: EvieToolSchema[] = [];
	let droppedFrames = 0;
	const pendingCalls = new Map<
		string,
		{ resolve: (result: EvieToolCallResult) => void; timer: ReturnType<typeof setTimeout> }
	>();

	function connect(): void {
		if (stopped) return;

		console.log(`[evie-client] connecting to ${config.url}...`);

		ws = new WebSocket(config.url, {
			headers: config.headers,
			...(config.tls ? { ca: config.tls.ca } : {}),
		});

		ws.on("open", () => {
			console.log(`[evie-client] connected`);
			missedPongs = 0;
			startHeartbeat();
			// Register this Gateway with the Router so cross-Gateway frames can find it.
			// Re-runs on every reconnect (the Router re-keys gateway id -> socket).
			void callTool("gateway_register", {
				gatewayId: config.gatewayId,
				protocolVersion: FEDERATION_PROTOCOL_VERSION,
				...(config.buildRegisterAuth?.() ?? {}),
			}).then((res) => {
				const r = res.result as
					| { ok?: boolean; error?: string; gateways?: string[]; domain?: unknown }
					| undefined;
				if (res.error) console.error(`[evie-client] gateway_register failed: ${res.error}`);
				else if (r?.ok === false) console.error(`[evie-client] Router rejected registration: ${r.error}`);
				else {
					const peers = r?.gateways?.length ? `, peers: ${r.gateways.join(", ")}` : "";
					console.log(`[evie-client] registered as Gateway "${config.gatewayId}"${peers}`);
					if (r?.domain) config.onDomainSync?.(r.domain);
				}
			});
		});

		ws.on("message", (raw: WebSocket.Data) => {
			let msg: unknown;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				droppedFrames++;
				console.warn(`[evie-client] dropped non-JSON frame (${droppedFrames} dropped total)`);
				return;
			}

			// Boundary parse: unknown frame types and malformed envelopes drop
			// with a counter instead of being blind-cast (or silently ignored).
			const parsed = EvieInboundFrameSchema.safeParse(msg);
			if (!parsed.success) {
				droppedFrames++;
				const kind = (msg as { type?: unknown } | null)?.type;
				console.warn(
					`[evie-client] dropped frame type=${JSON.stringify(kind)} (${droppedFrames} dropped total): ${parsed.error.issues[0]?.message ?? "malformed"}`,
				);
				return;
			}
			const frame = parsed.data;

			switch (frame.type) {
				case "tool_registry": {
					cachedTools = frame.tools;
					console.log(`[evie-client] received ${cachedTools.length} tool schemas`);
					config.onToolRegistry?.(cachedTools);
					break;
				}
				case "console_relay": {
					config.onConsoleRelay?.(frame);
					break;
				}
				case "gateway_relay": {
					config.onGatewayRelay?.(frame);
					break;
				}
				case "domain_update": {
					// evie pushed an updated keyring (an owner admit/revoke). Apply it
					// immediately so a revocation bites without waiting for the next register.
					config.onDomainSync?.(frame.domain);
					break;
				}
				case "tool_result": {
					const pending = pendingCalls.get(frame.callId);
					if (pending) {
						clearTimeout(pending.timer);
						pendingCalls.delete(frame.callId);
						pending.resolve({ callId: frame.callId, result: frame.result });
					}
					break;
				}
				case "tool_error": {
					// tool_error legitimately carries callId: null (evie could not
					// attribute the failure to a call); nothing pends under null.
					if (frame.callId === null) {
						console.warn(`[evie-client] tool_error with no callId: ${frame.error ?? "unknown"}`);
						break;
					}
					const pending = pendingCalls.get(frame.callId);
					if (pending) {
						clearTimeout(pending.timer);
						pendingCalls.delete(frame.callId);
						pending.resolve({ callId: frame.callId, error: frame.error ?? "unknown error" });
					}
					break;
				}
			}
		});

		ws.on("pong", () => {
			missedPongs = 0;
		});

		ws.on("close", () => {
			ws = null;
			stopHeartbeat();
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

	function startHeartbeat(): void {
		stopHeartbeat();
		heartbeatTimer = setInterval(() => {
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			// Increment first, then check (a pong resets the count to 0), so two
			// consecutive unanswered pings terminate - matching the gateway's team socket.
			missedPongs++;
			if (missedPongs >= MISSED_PONGS_LIMIT) {
				console.error(`[evie-client] no pong for ${missedPongs} beats, terminating to reconnect`);
				ws.terminate();
				return;
			}
			try {
				ws.ping();
			} catch {}
		}, HEARTBEAT_INTERVAL_MS);
		heartbeatTimer.unref?.();
	}

	function stopHeartbeat(): void {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
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

			const frame: ToolCallFrame = { type: "tool_call", callId, action, params };
			ws!.send(JSON.stringify(frame));
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
		stopHeartbeat();
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
