import type WebSocket from "ws";
import type { Ambient, IntervalHandle, TimerHandle } from "../../shared/ambient.js";
import { createReconnector } from "../../shared/reconnect.js";
import { RouterInboundFrameSchema, type ToolCallFrame } from "../../shared/router-protocol.js";
import {
	DEFAULT_ROUTER_PORT,
	isPrivateHost,
	LAN_CONNECT_TIMEOUT_MS,
	type RouterReach,
	reachCandidates,
	reachHost,
} from "../../shared/router-reach.js";
import { GatewayRegisterAnswerSchema } from "../../shared/schemasRegister.js";
import { pinnedDial, pinRefusal, realWebSocket } from "./pinnedSocket.js";
import { registerFrame } from "./registerAuth.js";

// Shared relay-frame ceiling. The peer transport and tests use the same value.
export const ROUTER_WS_MAX_PAYLOAD_BYTES = 67_108_864;

export interface RouterToolCallResult {
	callId: string;
	result?: unknown;
	error?: string;
}

export interface RouterClientConfig {
	/** Bootstrap URL used before the Router advertises reachability. */
	url: string;
	/** Previously advertised Router reachability. */
	reach?: RouterReach;
	/** Persists Router addresses learned during registration. */
	onReach?: (reach: RouterReach) => void;
	// WebSocket upgrade headers, including the caller-owned bearer.
	headers: Record<string, string>;
	// TLS trusts the pinned Router leaf fingerprint.
	tls?: { certFp: string };
	ambient: Ambient;
	// Gateway id used for relay routing.
	gatewayId: string;
	// Domain id used with the Gateway id as the Router connection key.
	domainId: string;
	// The gateway relay pump validates the payload.
	onGatewayRelay?: (frame: unknown) => void;
	// The handshake pump validates the payload.
	onCrossDomainHandshake?: (frame: unknown) => void;
	// Recomputes the admitted-identity proof for each registration.
	buildRegisterAuth?: () => Record<string, unknown> | null;
	// Applies the Router's opaque Domain snapshot after consumer validation.
	onDomainSync?: (domain: unknown) => void;
	/** Called after accepted registration. */
	onRegistered?: () => void;
	// Domain status and display metadata from registration.
	onDomainMeta?: (meta: { domainStatus?: string; displayName?: string | null; isAdminDomain?: boolean }) => void;
	// Applies display-name updates without reconnecting.
	onDomainUpdate?: (meta: { displayName?: string | null }) => void;
	onInboxDeliver?: (frame: unknown) => void;
	onPresenceResync?: (frame: unknown) => void;
	onUnlink?: (frame: unknown) => void;
	onBlobFetch?: (frame: unknown) => void;
	onValueOp?: (frame: unknown) => void;
	onDisconnect?: () => void;
	// Test override for pending-Domain registration retry cadence.
	pendingReregisterDelayMs?: number;
	// Test override for reconnect backoff.
	reconnectInitialDelayMs?: number;
}

export interface RouterClient {
	callTool: (action: string, params: Record<string, unknown>) => Promise<RouterToolCallResult>;
	callInboxTool: (action: string, params: Record<string, unknown>) => Promise<RouterToolCallResult>;
	incarnation: () => number | null;
	isConnected: () => boolean;
	/** True while registration is accepted. */
	isRegistered: () => boolean;
	acceptedOpLedgerProtocol: () => number | null;
	stop: () => void;
}

const TOOL_CALL_TIMEOUT_MS = 120_000;
// Retry pending registration on a bounded cadence.
const PENDING_REREGISTER_DELAY_MS = 15_000;
const PENDING_REREGISTER_MAX_ATTEMPTS = 40;
// Reconnect after two unanswered pings.
const HEARTBEAT_INTERVAL_MS = 20_000;
const MISSED_PONGS_LIMIT = 2;
// Bound candidate connection time before trying the next address.
const CONNECT_TIMEOUT_MS = 15_000;

// Use the package implementation because TLS pinning requires its socket hook.
const RealWebSocket = realWebSocket();

// Derive the pinned socket host from the selected candidate.
function dialHost(target: string): string {
	return reachHost(target);
}

function dialPort(target: string): number {
	const parsed = Number(new URL(target).port);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROUTER_PORT;
}

export function startRouterClient(config: RouterClientConfig): RouterClient {
	let ws: WebSocket | null = null;
	let stopped = false;
	// Registration can be refused while the socket remains open.
	let registered = false;
	let gatewayIncarnation: number | null = null;
	let opLedgerProtocol: number | null = null;
	// One socket fails over through the advertised address ring.
	let reach: RouterReach = config.reach ?? {};
	let candidateIndex = 0;
	const candidatesNow = (): string[] => {
		const ring = reachCandidates(reach, config.url, DEFAULT_ROUTER_PORT);
		return ring.length ? ring : [config.url];
	};
	const { ambient } = config;
	const reconnector = createReconnector(connect, {
		initialDelayMs: config.reconnectInitialDelayMs ?? 5_000,
		maxDelayMs: 30_000,
		ambient,
	});
	let heartbeatTimer: IntervalHandle | null = null;
	let pendingRetryTimer: TimerHandle | null = null;
	let pendingRetryAttempts = 0;
	let missedPongs = 0;
	let droppedFrames = 0;
	const pendingCalls = new Map<string, { resolve: (result: RouterToolCallResult) => void; timer: TimerHandle }>();

	function connect(): void {
		if (stopped) return;

		const ring = candidatesNow();
		const target = ring[candidateIndex % ring.length] ?? config.url;
		const wsUrl = target.replace(/^http/, "ws");
		// Distinguish an address that never opened from a dropped connection.
		let opened = false;
		console.log(`[router-client] connecting to ${target}...`);

		// Pin TLS before sending the bearer headers.
		const dial = config.tls?.certFp ? pinnedDial(dialHost(target), dialPort(target), config.tls.certFp) : null;
		ws = new RealWebSocket(wsUrl, {
			headers: config.headers,
			// Keep this at least as large as the Router listener limit.
			maxPayload: ROUTER_WS_MAX_PAYLOAD_BYTES,
			// ws types this as node's overloaded net.connect; ours is the one form ws actually calls.
			...(dial ? { createConnection: dial.createConnection as WebSocket.ClientOptions["createConnection"] } : {}),
		});

		// Route timeouts through the close handler so the ring advances uniformly.
		const budget = isPrivateHost(reachHost(target)) ? LAN_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
		const connectTimer = ambient.setTimer(() => {
			if (opened) return;
			console.error(`[router-client] ${target} did not answer in ${budget}ms, trying the next address`);
			ws?.terminate();
		}, budget);

		ws.on("open", () => {
			// A self-signed Router is trusted only after the pin runs.
			if (dial && dial.verdict() !== "match") {
				console.error(`[router-client] ${pinRefusal(dial.verdict())}; refusing the connection`);
				ws?.terminate();
				return;
			}
			console.log(`[router-client] connected`);
			missedPongs = 0;
			opened = true;
			ambient.clearTimer(connectTimer);
			// Resume from the working candidate.
			candidateIndex = Math.max(0, ring.indexOf(target));
			reconnector.reset();
			// Avoid duplicate registration retry timers.
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
				console.warn(`[router-client] dropped non-JSON frame (${droppedFrames} dropped total)`);
				return;
			}

			// Drop malformed or unknown frames at the boundary.
			const parsed = RouterInboundFrameSchema.safeParse(msg);
			if (!parsed.success) {
				droppedFrames++;
				const kind = (msg as { type?: unknown } | null)?.type;
				console.warn(
					`[router-client] dropped frame type=${JSON.stringify(kind)} (${droppedFrames} dropped total): ${parsed.error.issues[0]?.message ?? "malformed"}`,
				);
				return;
			}
			const frame = parsed.data;
			// A frame from a PREVIOUS registration is stale and is dropped. One that arrives before
			// this client has read its own register reply is not: the Router pushes the registration
			// burst immediately, and the reply is resolved a microtask later, so a null incarnation
			// here means "not yet known", never "wrong". Dropping those strands the held inbox rows
			// the burst exists to deliver.
			if ("incarnation" in frame && gatewayIncarnation !== null && frame.incarnation !== gatewayIncarnation) {
				droppedFrames++;
				console.warn(
					`[router-client] dropped foreign incarnation=${frame.incarnation} (${droppedFrames} dropped total)`,
				);
				return;
			}
			if ((frame as { type?: string }).type === "blob_fetch") {
				config.onBlobFetch?.(frame);
				return;
			}
			if ((frame as { type?: string }).type === "value_op") {
				config.onValueOp?.(frame);
				return;
			}

			switch (frame.type) {
				case "gateway_relay": {
					config.onGatewayRelay?.(frame);
					break;
				}
				case "cross_domain_handshake":
				case "cross_domain_handshake_reveal": {
					config.onCrossDomainHandshake?.(frame);
					break;
				}
				case "domain_update": {
					// Apply admission and revocation updates immediately.
					config.onDomainSync?.(frame.domain);
					// Refresh the display name without reconnecting.
					if (frame.displayName !== undefined) config.onDomainUpdate?.({ displayName: frame.displayName });
					break;
				}
				case "inbox_deliver": {
					config.onInboxDeliver?.(frame);
					break;
				}
				case "presence_resync": {
					config.onPresenceResync?.(frame);
					break;
				}
				case "unlink": {
					config.onUnlink?.(frame);
					break;
				}
				case "tool_result": {
					const pending = pendingCalls.get(frame.callId);
					if (pending) {
						ambient.clearTimer(pending.timer);
						pendingCalls.delete(frame.callId);
						pending.resolve({ callId: frame.callId, result: frame.result });
					}
					break;
				}
				case "tool_error": {
					// Null call ids have no pending request.
					if (frame.callId === null) {
						console.warn(`[router-client] tool_error with no callId: ${frame.error ?? "unknown"}`);
						break;
					}
					const pending = pendingCalls.get(frame.callId);
					if (pending) {
						ambient.clearTimer(pending.timer);
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

		const socket = ws;
		ws.on("close", () => {
			if (ws !== socket) return;
			ws = null;
			ambient.clearTimer(connectTimer);
			stopHeartbeat();
			registered = false;
			gatewayIncarnation = null;
			opLedgerProtocol = null;
			// Advance after a failed candidate.
			if (!opened) candidateIndex = (candidateIndex + 1) % Math.max(1, ring.length);
			// Do not register through a dead socket.
			clearPendingRetry();
			// Fail in-flight calls so callers can retry promptly.
			for (const [callId, pending] of pendingCalls) {
				ambient.clearTimer(pending.timer);
				pending.resolve({ callId, error: `Disconnected from the federation Router` });
			}
			pendingCalls.clear();
			config.onDisconnect?.();
			if (!stopped) {
				console.error(`[router-client] disconnected, reconnecting with backoff...`);
				reconnector.schedule();
			}
		});

		ws.on("error", (err: Error) => {
			console.error(`[router-client] error: ${err.message}`);
			// Reject runtimes that bypass the pinning hook.
			if (dial && dial.verdict() === "pending" && /self.signed|SELF_SIGNED|DEPTH_ZERO/i.test(err.message)) {
				console.error(`[router-client] ${pinRefusal("pending")}`);
			}
		});
	}

	// Register on open and while the Domain remains pending.
	function registerGateway(): void {
		if (!ws || ws.readyState !== RealWebSocket.OPEN) return;
		void callTool("gateway_register", registerFrame(config, config.buildRegisterAuth?.() ?? null))
			.then((res) => {
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
							reach?: RouterReach;
							incarnation?: number;
					  }
					| undefined;
				if (res.error) {
					registered = false;
					gatewayIncarnation = null;
					opLedgerProtocol = null;
					console.error(`[router-client] gateway_register failed: ${res.error}`);
					return;
				}
				if (r?.ok === false) {
					registered = false;
					gatewayIncarnation = null;
					opLedgerProtocol = null;
					// Pending registration is retried; other refusals are terminal.
					if (r.pending) schedulePendingRetry(r.error);
					else console.error(`[router-client] Router rejected registration: ${r.error}`);
					return;
				}
				// Successful registration clears pending retries.
				clearPendingRetry();
				registered = true;
				const registerAnswer = GatewayRegisterAnswerSchema.safeParse(r);
				opLedgerProtocol = registerAnswer.success ? (registerAnswer.data.opLedgerProtocol ?? null) : null;
				gatewayIncarnation = typeof r?.incarnation === "number" ? r.incarnation : null;
				const peers = r?.gateways?.length ? `, peers: ${r.gateways.join(", ")}` : "";
				console.log(`[router-client] registered as Gateway "${config.gatewayId}"${peers}`);
				config.onRegistered?.();
				if (r?.domain) config.onDomainSync?.(r.domain);
				else
					console.warn(
						`[federation] registered but the Router returned no Domain snapshot - the Domain may not be rooted, or the Router is outdated`,
					);
				// Use addresses from the registration reply when present.
				if (r?.reach && (r.reach.publicHost || r.reach.lanAddresses?.length)) {
					reach = r.reach;
					config.onReach?.(r.reach);
				}
				// Surface Domain metadata to the console.
				if (r?.domainStatus !== undefined || r?.displayName !== undefined || r?.isAdminDomain !== undefined) {
					config.onDomainMeta?.({
						domainStatus: r.domainStatus,
						displayName: r.displayName,
						isAdminDomain: r.isAdminDomain,
					});
				}
			})
			.catch((e) =>
				console.error(`[router-client] gateway_register chain error: ${e instanceof Error ? e.message : e}`),
			);
	}

	function schedulePendingRetry(reason?: string): void {
		if (stopped) return;
		if (pendingRetryTimer) return; // one timer in flight; do not stack
		if (pendingRetryAttempts >= PENDING_REREGISTER_MAX_ATTEMPTS) {
			console.error(
				`[router-client] Domain still pending after ${pendingRetryAttempts} re-register attempts, giving up: ${reason ?? "pending"}`,
			);
			return;
		}
		const delayMs = config.pendingReregisterDelayMs ?? PENDING_REREGISTER_DELAY_MS;
		pendingRetryAttempts++;
		console.warn(
			`[router-client] Domain not yet rooted (${reason ?? "pending"}); re-registering in ${delayMs / 1000}s (attempt ${pendingRetryAttempts}/${PENDING_REREGISTER_MAX_ATTEMPTS})`,
		);
		pendingRetryTimer = ambient.setTimer(() => {
			pendingRetryTimer = null;
			registerGateway();
		}, delayMs);
	}

	function clearPendingRetry(): void {
		if (pendingRetryTimer) {
			ambient.clearTimer(pendingRetryTimer);
			pendingRetryTimer = null;
		}
		pendingRetryAttempts = 0;
	}

	function startHeartbeat(): void {
		stopHeartbeat();
		heartbeatTimer = ambient.setInterval(() => {
			if (!ws || ws.readyState !== RealWebSocket.OPEN) return;
			// Two unanswered pings terminate the socket.
			missedPongs++;
			if (missedPongs >= MISSED_PONGS_LIMIT) {
				console.error(`[router-client] no pong for ${missedPongs} beats, terminating to reconnect`);
				ws.terminate();
				return;
			}
			try {
				ws.ping();
			} catch {}
		}, HEARTBEAT_INTERVAL_MS);
	}

	function stopHeartbeat(): void {
		if (heartbeatTimer) {
			ambient.clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
	}

	async function callTool(action: string, params: Record<string, unknown>): Promise<RouterToolCallResult> {
		if (!ws || ws.readyState !== RealWebSocket.OPEN) {
			return { callId: "", error: `Not connected to the federation Router` };
		}

		const callId = ambient.newId();

		return new Promise<RouterToolCallResult>((resolve) => {
			const timer = ambient.setTimer(() => {
				pendingCalls.delete(callId);
				resolve({ callId, error: `Tool call timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s` });
			}, TOOL_CALL_TIMEOUT_MS);

			pendingCalls.set(callId, { resolve, timer });

			const frame: ToolCallFrame = { type: "tool_call", callId, action, params };
			ws!.send(JSON.stringify(frame));
		});
	}

	async function callInboxTool(action: string, params: Record<string, unknown>): Promise<RouterToolCallResult> {
		const incarnation = gatewayIncarnation;
		if (incarnation === null) return { callId: "", error: "Gateway is not registered" };
		return callTool(action, { ...params, incarnation });
	}

	function isConnected(): boolean {
		return ws !== null && ws.readyState === RealWebSocket.OPEN;
	}

	function stop(): void {
		stopped = true;
		stopHeartbeat();
		clearPendingRetry();
		reconnector.cancel();
		for (const [, pending] of pendingCalls) {
			ambient.clearTimer(pending.timer);
			pending.resolve({ callId: "", error: `Client stopped` });
		}
		pendingCalls.clear();
		if (ws) {
			ws.close();
			ws = null;
		}
		console.log(`[router-client] stopped`);
	}

	connect();

	function isRegistered(): boolean {
		return registered && isConnected();
	}

	return {
		callTool,
		callInboxTool,
		incarnation: () => gatewayIncarnation,
		isConnected,
		isRegistered,
		acceptedOpLedgerProtocol: () => opLedgerProtocol,
		stop,
	};
}
