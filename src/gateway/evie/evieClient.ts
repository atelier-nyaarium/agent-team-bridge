import crypto from "node:crypto";
import WebSocket from "ws";
import { EvieInboundFrameSchema, FEDERATION_PROTOCOL_VERSION, type ToolCallFrame } from "../../shared/evie-protocol.js";
import { createReconnector } from "../../shared/reconnect.js";
import {
	DEFAULT_ROUTER_PORT,
	isPrivateHost,
	LAN_CONNECT_TIMEOUT_MS,
	type RouterReach,
	reachCandidates,
	reachHost,
} from "../../shared/router-reach.js";

// One relay-frame ceiling, set explicitly on BOTH ends of the gateway<->evie socket (here and
// evie-bot's BridgeTransport). 64 MiB clears a max-cap attachment payload's sealed frame (~1.78x
// the decoded bytes) with headroom; routes.test.ts pins that relationship.
export const EVIE_WS_MAX_PAYLOAD_BYTES = 67_108_864;

////////////////////////////////
//  Interfaces & Types

export interface EvieToolCallResult {
	callId: string;
	result?: unknown;
	error?: string;
}

export interface EvieClientConfig {
	/** The bootstrap base URL: the docker alias on the Router's own machine, or whatever Gateway
	 * Setup was told elsewhere. Only the FIRST door - once the Router answers, its advertised
	 * addresses lead the ring and this falls to last. */
	url: string;
	/** What the Router last said about itself, restored across restarts. Absent on a first connect. */
	reach?: RouterReach;
	/** The Router advertised its addresses on the register reply. Persist them; the next connect
	 * attempt (and every reconnect) re-derives the ring from them. */
	onReach?: (reach: RouterReach) => void;
	// WebSocket handshake headers. The bearer the Router gates the upgrade on, so the auth
	// shape lives with the caller, not here.
	headers: Record<string, string>;
	// How TLS is trusted: the Router's leaf fingerprint. A self-signed leaf has no chain,
	// so pinning it IS the trust.
	tls?: { certFp: string };
	// This Gateway's id, registered with the Router on connect so cross-Gateway frames
	// can be routed to this Gateway.
	gatewayId: string;
	// This Gateway's Domain id, sent on register so the Router keys the connection by
	// (domainId, gatewayId). Always set: the client is constructed only when both the
	// transport and the Domain id are non-null.
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
	// Extra `gateway_register` params (the admitted-identity proof: signPub/boxPub +
	// owner-signed admission + a fresh possession proof), recomputed at each (re)register
	// so the proof timestamp is current. Returns null pre-enrollment.
	buildRegisterAuth?: () => Record<string, unknown> | null;
	// The mirrored Domain (owner root + allowlist) evie returns in the register
	// reply; the Gateway applies it so a revocation bites even while evie is offline.
	// Travels as unknown; the consumer validates with DomainSnapshotSchema.
	onDomainSync?: (domain: unknown) => void;
	// This Gateway's own Domain lifecycle metadata from the register reply: its status
	// ("pending"/"rooted"/"unrooted") and display name, surfaced to the console. Re-applied
	// on every reconnect, so a rename made elsewhere reaches the Gateway at its next register.
	onDomainMeta?: (meta: { domainStatus?: string; displayName?: string | null; isAdminDomain?: boolean }) => void;
	// A live display-name refresh from a domain_update push. Refreshes the held displayName
	// without a reconnect, so teams()/discover reflect the rename immediately. The snapshot
	// the push feeds drops displayName, so this is the only path that updates it between registers.
	onDomainUpdate?: (meta: { displayName?: string | null }) => void;
	onDisconnect?: () => void;
	// Override the pending-Domain re-register cadence. Production leaves it unset (the
	// PENDING_REREGISTER_DELAY_MS default); tests pass a small value to exercise the retry
	// without waiting out the real interval.
	pendingReregisterDelayMs?: number;
	// Override the reconnect backoff floor, same reason: a test proving the dial ring steps past a
	// dead address should not hold a socket open for the production 5s between attempts.
	reconnectInitialDelayMs?: number;
}

export interface EvieClient {
	callTool: (action: string, params: Record<string, unknown>) => Promise<EvieToolCallResult>;
	isConnected: () => boolean;
	stop: () => void;
}

////////////////////////////////
//  Functions & Helpers

const TOOL_CALL_TIMEOUT_MS = 120_000;
// When evie refuses gateway_register because the Domain is still pending (staged but not
// yet rooted), re-register on this cadence. The open-handler's register fires before the
// admin's phone first-roots the Domain, and the heartbeat keeps the WS warm so the socket
// never reconnects to re-register on its own. The cap bounds the spin so a genuinely stuck
// setup stops re-trying instead of polling evie indefinitely.
const PENDING_REREGISTER_DELAY_MS = 15_000;
const PENDING_REREGISTER_MAX_ATTEMPTS = 40;
// Application-level keepalive: a ping detects a silently-dropped path that neither end has
// noticed, since two missed pongs terminate the socket and trigger a reconnect.
const HEARTBEAT_INTERVAL_MS = 20_000;
const MISSED_PONGS_LIMIT = 2;
// How long a candidate gets to OPEN before the ring steps past it. Without this the socket inherits
// the OS connect timeout, which for an unroutable address is minutes - so a stale LAN address the
// Router once advertised would wedge the Gateway offline long past the point the public host would
// have worked. A private address answers from the same subnet or not at all, so it gets the short
// budget; anything else may legitimately be slow to reach.
const CONNECT_TIMEOUT_MS = 15_000;

function tlsOptions(tls: EvieClientConfig["tls"]): Record<string, unknown> {
	if (!tls) return {};
	// A pinned leaf has no chain to validate, so chain verification is turned off and
	// verifyPinnedLeaf below is what actually authenticates the peer.
	return { rejectUnauthorized: false, tls: { rejectUnauthorized: false } };
}

/** Destroy the socket unless its leaf matches the pin. Nothing else authenticates a self-signed
 * Router, so a mismatch must close the connection rather than warn. */
function verifyPinnedLeaf(ws: WebSocket, expectedFp: string): void {
	ws.once("upgrade", (response) => {
		const socket = (response as { socket?: { getPeerCertificate?: (d?: boolean) => { raw?: Buffer } } }).socket;
		const raw = socket?.getPeerCertificate?.(true)?.raw;
		const actual = raw ? crypto.createHash("sha256").update(raw).digest("hex") : "";
		if (actual !== expectedFp.toLowerCase()) {
			console.error(`[evie-client] router cert fingerprint mismatch; refusing the connection`);
			ws.terminate();
		}
	});
}

export function startEvieClient(config: EvieClientConfig): EvieClient {
	let ws: WebSocket | null = null;
	let stopped = false;
	// The addresses this Gateway knows for its Router, and which one the next connect dials. Unlike
	// the phone, which fails over per HTTP op, a Gateway holds ONE socket: the ring advances on a
	// failed connect and resets on a successful open, so a Router that moved is found on the next
	// backoff rather than never. Before this the client redialed one fixed URL forever, and an
	// address that stopped working was an outage no amount of reconnecting could clear.
	let reach: RouterReach = config.reach ?? {};
	let candidateIndex = 0;
	const candidatesNow = (): string[] => {
		const ring = reachCandidates(reach, config.url, DEFAULT_ROUTER_PORT);
		return ring.length ? ring : [config.url];
	};
	const reconnector = createReconnector(connect, {
		initialDelayMs: config.reconnectInitialDelayMs ?? 5_000,
		maxDelayMs: 30_000,
	});
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

		const ring = candidatesNow();
		const target = ring[candidateIndex % ring.length] ?? config.url;
		const wsUrl = target.replace(/^http/, "ws");
		// Whether THIS socket ever opened, so the close handler can tell "that address is shut" from
		// "the connection we had dropped", which must not walk the ring off a working address.
		let opened = false;
		console.log(`[evie-client] connecting to ${target}...`);

		ws = new WebSocket(wsUrl, {
			headers: config.headers,
			// Explicit rather than ws's inherited 100 MiB default: this socket carries every relay
			// frame for the whole gateway, and an oversized inbound message does not merely fail,
			// it can close the connection and drop all federation traffic with it. Must stay >= the
			// matching explicit limit on evie's BridgeTransport, or a frame evie accepts kills us.
			maxPayload: EVIE_WS_MAX_PAYLOAD_BYTES,
			// Bun's WebSocket reads pinned TLS options under `tls`, NOT at the top level. A top-level
			// `ca` is silently ignored, so it falls back to the system trust store and rejects the
			// private cluster-signed API server cert ("TLS handshake failed").
			...tlsOptions(config.tls),
		});
		if (config.tls && "certFp" in config.tls) verifyPinnedLeaf(ws, config.tls.certFp);

		// Bound the wait on THIS candidate. Terminating routes into the close handler, which is the
		// one place the ring advances, so a timeout and a refused connection are handled identically.
		const budget = isPrivateHost(reachHost(target)) ? LAN_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
		const connectTimer = setTimeout(() => {
			if (opened) return;
			console.error(`[evie-client] ${target} did not answer in ${budget}ms, trying the next address`);
			ws?.terminate();
		}, budget);

		ws.on("open", () => {
			console.log(`[evie-client] connected`);
			missedPongs = 0;
			opened = true;
			clearTimeout(connectTimer);
			// This candidate answered, so the next reconnect starts here rather than walking the ring
			// again. A LAN address that works stays first, which is the whole point of the order.
			candidateIndex = Math.max(0, ring.indexOf(target));
			reconnector.reset();
			// Drop any pending-retry timer left from a prior socket so its cadence does not
			// double up with the new open-handler's register.
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
					// own Gateway reflects it in teams()/discover at once (applySnapshot drops it).
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
			clearTimeout(connectTimer);
			stopHeartbeat();
			// This candidate did not stay up. Advance so the next attempt tries a different address:
			// a socket that never opened means this door is shut, and one that opened and dropped is
			// re-tried from here anyway because the open handler pinned the index to it.
			if (!opened) candidateIndex = (candidateIndex + 1) % Math.max(1, ring.length);
			// The reconnect re-registers from the open handler, so cancel the pending-retry
			// timer rather than fire a register at a dead socket.
			clearPendingRetry();
			// Fail in-flight calls now rather than letting each wait out its timeout across
			// a reconnect; callers see a fast retryable error.
			for (const [callId, pending] of pendingCalls) {
				clearTimeout(pending.timer);
				pending.resolve({ callId, error: `Disconnected from the federation Router` });
			}
			pendingCalls.clear();
			config.onDisconnect?.();
			if (!stopped) {
				console.error(`[evie-client] disconnected, reconnecting with backoff...`);
				reconnector.schedule();
			}
		});

		ws.on("error", (err: Error) => {
			console.error(`[evie-client] error: ${err.message}`);
		});
	}

	// Register this Gateway with the Router so cross-Gateway frames can find it. Fired from
	// the open handler (the Router re-keys gateway id -> socket on every reconnect) and
	// re-fired by the pending-retry timer when the Domain was still pending.
	function registerGateway(): void {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		void callTool("gateway_register", {
			gatewayId: config.gatewayId,
			domainId: config.domainId,
			protocolVersion: FEDERATION_PROTOCOL_VERSION,
			...(config.buildRegisterAuth?.() ?? {}),
		})
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
					  }
					| undefined;
				if (res.error) {
					console.error(`[evie-client] gateway_register failed: ${res.error}`);
					return;
				}
				if (r?.ok === false) {
					// A pending-tagged refusal is transient: the Domain is staged but not yet rooted.
					// Retry on a bounded cadence so registration lands as soon as the root arrives.
					// Any other ok:false is terminal (revoked / wrong-domain / version), so log only
					// rather than mask a real denial behind an endless re-register loop.
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
				// The Router's own addresses, learned on the reply rather than asked for: the Gateway
				// authenticates with a WS bearer and cannot call the console-token `reach` op at all.
				// An older Router sends nothing and the ring keeps what it had.
				if (r?.reach && (r.reach.publicHost || r.reach.lanAddresses?.length)) {
					reach = r.reach;
					config.onReach?.(r.reach);
				}
				// Surface the Gateway's own Domain status + display name + admin-Domain flag to the
				// console register reply / discovery roster.
				if (r?.domainStatus !== undefined || r?.displayName !== undefined || r?.isAdminDomain !== undefined) {
					config.onDomainMeta?.({
						domainStatus: r.domainStatus,
						displayName: r.displayName,
						isAdminDomain: r.isAdminDomain,
					});
				}
			})
			.catch((e) =>
				console.error(`[evie-client] gateway_register chain error: ${e instanceof Error ? e.message : e}`),
			);
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
			return { callId: "", error: `Not connected to the federation Router` };
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
		reconnector.cancel();
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
