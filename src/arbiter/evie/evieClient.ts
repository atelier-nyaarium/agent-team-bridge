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
	authToken: string;
	// This Switch's id, registered with the Router on connect so cross-Switch frames
	// can be switched to this Switch.
	switchId: string;
	onToolRegistry?: (tools: EvieToolSchema[]) => void;
	// The relay pump owns full PhoneRelayFrameSchema validation; the envelope
	// union only routes by type, so the frame travels as unknown.
	onPhoneRelay?: (frame: unknown) => void;
	// A cross-Switch frame the Router switched to this Switch; the switch-relay pump owns
	// full SwitchRelayFrameSchema validation, so the frame travels as unknown.
	onSwitchRelay?: (frame: unknown) => void;
	// Extra `switch_register` params (the admitted-identity proof: signPub/boxPub
	// + owner-signed admission + a fresh possession proof), computed at each
	// (re)register so the proof timestamp is current. Returns null pre-enrollment,
	// leaving registration token-only.
	buildRegisterAuth?: () => Record<string, unknown> | null;
	// The mirrored Domain (owner root + allowlist) evie returns in the register
	// reply; the Switch applies it so a revocation bites even while evie is offline.
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

export function startEvieClient(config: EvieClientConfig): EvieClient {
	let ws: WebSocket | null = null;
	let stopped = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
			headers: { Authorization: `Bearer ${config.authToken}` },
		});

		ws.on("open", () => {
			console.log(`[evie-client] connected`);
			// Register this Switch with the Router so cross-Switch frames can find it.
			// Re-runs on every reconnect (the Router re-keys switch id -> socket).
			void callTool("switch_register", {
				switchId: config.switchId,
				protocolVersion: FEDERATION_PROTOCOL_VERSION,
				...(config.buildRegisterAuth?.() ?? {}),
			}).then((res) => {
				const r = res.result as
					| { ok?: boolean; error?: string; switches?: string[]; domain?: unknown }
					| undefined;
				if (res.error) console.error(`[evie-client] switch_register failed: ${res.error}`);
				else if (r?.ok === false) console.error(`[evie-client] Router rejected registration: ${r.error}`);
				else {
					const peers = r?.switches?.length ? `, peers: ${r.switches.join(", ")}` : "";
					console.log(`[evie-client] registered as Switch "${config.switchId}"${peers}`);
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
				case "phone_relay": {
					config.onPhoneRelay?.(frame);
					break;
				}
				case "switch_relay": {
					config.onSwitchRelay?.(frame);
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
