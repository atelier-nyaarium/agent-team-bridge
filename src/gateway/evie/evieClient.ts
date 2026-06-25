import crypto from "node:crypto";
import WebSocket from "ws";
import { EvieInboundFrameSchema, FEDERATION_PROTOCOL_VERSION, type ToolCallFrame } from "../../shared/evie-protocol.js";

////////////////////////////////
//  Interfaces & Types

export interface EvieToolCallResult {
	callId: string;
	result?: unknown;
	error?: string;
}

export interface EvieClientConfig {
	url: string;
	// WebSocket handshake headers. The service-proxy transport carries the SA token as
	// Authorization (consumed by the API server) plus the bridge token in a forwarded
	// header, so the auth shape lives with the caller, not here.
	headers: Record<string, string>;
	// Cluster CA (PEM) to pin TLS against when dialing the service-proxy (wss://).
	tls?: { ca: string };
	// This Gateway's id, registered with the Router on connect so cross-Gateway frames
	// can be routed to this Gateway.
	gatewayId: string;
	// This Gateway's Domain id (multi-tenant evie), sent on register so the Router keys
	// the connection by (domainId, gatewayId). Always set: the evie client is constructed
	// only when both the transport and the Domain id are non-null.
	domainId: string;
	// The relay pump owns full ConsoleRelayFrameSchema validation; the envelope
	// union only routes by type, so the frame travels as unknown.
	onConsoleRelay?: (frame: unknown) => void;
	// A cross-Gateway frame the Router routed to this Gateway; the gateway-relay pump owns
	// full GatewayRelayFrameSchema validation, so the frame travels as unknown.
	onGatewayRelay?: (frame: unknown) => void;
	// A pre-trust cross-Domain handshake frame the Router routed to this Gateway (the
	// receiver leg); the handshake pump owns full validation, so it travels as unknown.
	onCrossDomainHandshake?: (frame: unknown) => void;
	// Extra `gateway_register` params (the admitted-identity proof: signPub/boxPub
	// + owner-signed admission + a fresh possession proof), computed at each
	// (re)register so the proof timestamp is current. Returns null pre-enrollment,
	// leaving registration token-only.
	buildRegisterAuth?: () => Record<string, unknown> | null;
	// The mirrored Domain (owner root + allowlist) evie returns in the register
	// reply; the Gateway applies it so a revocation bites even while evie is offline.
	// Travels as unknown; the consumer validates with DomainSnapshotSchema.
	onDomainSync?: (domain: unknown) => void;
	// This Gateway's own Domain lifecycle metadata from the register reply: its status
	// ("pending"/"rooted"/"unrooted") and the network display name. The Gateway
	// surfaces these to its console (the register reply's domainStatus + the discovery
	// roster's displayName). Re-applied on every reconnect, so a rename made elsewhere
	// reaches the Gateway at its next register. Fields absent against a pre-feature evie.
	onDomainMeta?: (meta: { domainStatus?: string; displayName?: string | null; isAdminDomain?: boolean }) => void;
	// A live display-name refresh from a domain_update push (the owner renamed THIS Domain's
	// network). Refreshes the held displayName without a reconnect, so teams()/discover reflect
	// the rename immediately. The allowlist the domain_update's snapshot feeds drops displayName,
	// so this is the only path that updates it between registers. Absent against a pre-feature evie.
	onDomainUpdate?: (meta: { displayName?: string | null }) => void;
	onDisconnect?: () => void;
	// Override the pending-Domain re-register cadence. Production leaves it unset (the
	// PENDING_REREGISTER_DELAY_MS default); tests pass a small value to exercise the retry
	// without waiting out the real interval.
	pendingReregisterDelayMs?: number;
}

export interface EvieClient {
	callTool: (action: string, params: Record<string, unknown>) => Promise<EvieToolCallResult>;
	isConnected: () => boolean;
	stop: () => void;
}

////////////////////////////////
//  Functions & Helpers

const RECONNECT_DELAY_MS = 5_000;
const TOOL_CALL_TIMEOUT_MS = 120_000;
// When evie refuses gateway_register because the Domain is still PENDING (staged but not
// yet rooted), re-register on this cadence. A fresh provision-admin-domain.sh stages a
// pending admin Domain and restarts evie BEFORE the admin's phone first-roots it, so the
// register the open-handler fires gets a pending refusal; without this retry the Gateway
// would sit unregistered into its own admin Domain forever (the heartbeat keeps the WS warm,
// so it never reconnects to re-register). The cap bounds the spin so a genuinely stuck setup
// stops re-trying instead of polling evie indefinitely.
const PENDING_REREGISTER_DELAY_MS = 15_000;
const PENDING_REREGISTER_MAX_ATTEMPTS = 40;
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
	let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingRetryAttempts = 0;
	let missedPongs = 0;
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
			// A fresh connection re-registers from scratch; drop any pending-retry timer left
			// from a prior socket so its cadence does not double up with the new open-handler.
			clearPendingRetry();
			startHeartbeat();
			registerGateway();
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
				case "console_relay": {
					config.onConsoleRelay?.(frame);
					break;
				}
				case "gateway_relay": {
					config.onGatewayRelay?.(frame);
					break;
				}
				case "cross_domain_handshake": {
					config.onCrossDomainHandshake?.(frame);
					break;
				}
				case "domain_update": {
					// evie pushed an updated keyring (an owner admit/revoke). Apply it
					// immediately so a revocation bites without waiting for the next register.
					config.onDomainSync?.(frame.domain);
					// A rename rides the same push: refresh the held displayName so the owner's
					// OWN Gateway reflects it in teams()/discover at once (applySnapshot drops it).
					// Only sent by a federation-aware evie, only to the renamed Domain's gateways.
					if (frame.displayName !== undefined) config.onDomainUpdate?.({ displayName: frame.displayName });
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
			// The pending-retry rides this socket; a reconnect re-registers from the open
			// handler, so cancel the timer rather than fire a register at a dead socket.
			clearPendingRetry();
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

	// Register this Gateway with the Router so cross-Gateway frames can find it. Fired
	// once from the open handler (the Router re-keys gateway id -> socket on every reconnect)
	// and re-fired by the pending-retry timer when the Domain was still PENDING.
	function registerGateway(): void {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		void callTool("gateway_register", {
			gatewayId: config.gatewayId,
			domainId: config.domainId,
			protocolVersion: FEDERATION_PROTOCOL_VERSION,
			...(config.buildRegisterAuth?.() ?? {}),
		}).then((res) => {
			const r = res.result as
				| {
						ok?: boolean;
						pending?: boolean;
						error?: string;
						gateways?: string[];
						domain?: unknown;
						domainStatus?: string;
						displayName?: string | null;
						isAdminDomain?: boolean;
				  }
				| undefined;
			if (res.error) {
				console.error(`[evie-client] gateway_register failed: ${res.error}`);
				return;
			}
			if (r?.ok === false) {
				// A PENDING-tagged refusal is transient: the Domain is staged but not yet rooted
				// (a fresh setup roots it once the admin's phone scans the QR). Retry on a
				// bounded cadence so registration lands as soon as the root arrives. Any other
				// ok:false is terminal (revoked / wrong-domain / version) - log only, no retry,
				// so a real denial is not masked behind an endless re-register loop.
				if (r.pending) schedulePendingRetry(r.error);
				else console.error(`[evie-client] Router rejected registration: ${r.error}`);
				return;
			}
			// A successful register clears any pending-retry left from earlier attempts.
			clearPendingRetry();
			const peers = r?.gateways?.length ? `, peers: ${r.gateways.join(", ")}` : "";
			console.log(`[evie-client] registered as Gateway "${config.gatewayId}"${peers}`);
			if (r?.domain) config.onDomainSync?.(r.domain);
			else
				console.warn(
					`[federation] registered but evie returned no Domain snapshot - the Domain may not be rooted, or evie is outdated`,
				);
			// Surface the Gateway's own Domain status + profile name + admin-Domain flag to the
			// console register reply / discovery roster. Sent only by a federation-aware evie.
			if (r?.domainStatus !== undefined || r?.displayName !== undefined || r?.isAdminDomain !== undefined) {
				config.onDomainMeta?.({
					domainStatus: r.domainStatus,
					displayName: r.displayName,
					isAdminDomain: r.isAdminDomain,
				});
			}
		});
	}

	function schedulePendingRetry(reason?: string): void {
		if (stopped) return;
		if (pendingRetryTimer) return; // one timer in flight; do not stack
		if (pendingRetryAttempts >= PENDING_REREGISTER_MAX_ATTEMPTS) {
			console.error(
				`[evie-client] Domain still pending after ${pendingRetryAttempts} re-register attempts, giving up: ${reason ?? "pending"}`,
			);
			return;
		}
		const delayMs = config.pendingReregisterDelayMs ?? PENDING_REREGISTER_DELAY_MS;
		pendingRetryAttempts++;
		console.warn(
			`[evie-client] Domain not yet rooted (${reason ?? "pending"}); re-registering in ${delayMs / 1000}s (attempt ${pendingRetryAttempts}/${PENDING_REREGISTER_MAX_ATTEMPTS})`,
		);
		pendingRetryTimer = setTimeout(() => {
			pendingRetryTimer = null;
			registerGateway();
		}, delayMs);
		pendingRetryTimer.unref?.();
	}

	function clearPendingRetry(): void {
		if (pendingRetryTimer) {
			clearTimeout(pendingRetryTimer);
			pendingRetryTimer = null;
		}
		pendingRetryAttempts = 0;
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

	function stop(): void {
		stopped = true;
		stopHeartbeat();
		clearPendingRetry();
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

	return { callTool, isConnected, stop };
}
