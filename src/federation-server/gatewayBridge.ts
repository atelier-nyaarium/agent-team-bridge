import { type DomainSnapshot, REGISTER_MAX_SKEW_MS } from "../shared/admission.js";
import {
	type CrossDomainHandshakeReplyParams,
	CrossDomainHandshakeReplyParamsSchema,
	type CrossDomainHandshakeRevealReplyParams,
	CrossDomainHandshakeRevealReplyParamsSchema,
	CrossDomainHandshakeRevealRouteSchema,
	CrossDomainHandshakeRouteSchema,
	FEDERATION_PROTOCOL_VERSION,
	GatewayRegisterParamsSchema,
	type GatewayRelayReplyParams,
	GatewayRelayReplyParamsSchema,
	GatewayRelayRouteSchema,
} from "../shared/router-protocol.js";
import { type DomainMeta, sanitizeDomainId } from "./enrollmentCoordinator.js";
import { type ConnectionId, GatewayTransport, type ToolProvider } from "./gatewayTransport.js";
import { HANDSHAKE_RATE_MAX, HANDSHAKE_RATE_WINDOW_MS } from "./handshakeRateLimit.js";
import { verifyRegistrationClaim } from "./registrationVerification.js";
import { CROSS_DOMAIN_HANDSHAKE_TIMEOUT_MS, GATEWAY_RELAY_TIMEOUT_MS } from "./relayTimeouts.js";

////////////////////////////////
//  Class

export interface GatewayBridgeParams {
	port: number;
	authToken: string;
	// Required: an absent getDomain would skip the whole registration verification block.
	getDomain: (domainId: string) => DomainSnapshot | null;
	getDomainMeta: (domainId: string) => DomainMeta | null;
	hasLinkEdge: (srcDomainId: string, dstDomainId: string) => boolean;
	adminDomainId: () => string | null;
	/** The Router's own addresses, put on every register reply so a Gateway learns where else it can
	 * be reached. The Gateway holds a WS bearer, not the console app token, so it cannot ask the
	 * `reach` op; this reply is the only channel it has. */
	reach?: () => { publicHost?: string | null; publicPort?: number | null; lanAddresses?: string[] };
}

export class GatewayBridge implements ToolProvider {
	private transport: GatewayTransport | null = null;
	private gatewayConnections = new Map<string, Map<string, ConnectionId>>();
	private connGateways = new Map<ConnectionId, { domainId: string; gatewayId: string; signPub: string | null }>();
	private pendingRelays = new Map<
		string,
		{
			resolve: (r: GatewayRelayReplyParams) => void;
			timer: ReturnType<typeof setTimeout>;
			dstDomainId: string;
			dstGateway: string;
		}
	>();
	private pendingHandshakes = new Map<
		string,
		{
			resolve: (r: CrossDomainHandshakeReplyParams | CrossDomainHandshakeRevealReplyParams) => void;
			timer: ReturnType<typeof setTimeout>;
			dstConnId: ConnectionId;
			dstGateway: string;
		}
	>();
	private handshakeAttempts = new Map<string, number[]>();
	private consoleRelaySettler: ((opId: string, reply: Record<string, unknown>) => void) | null = null;
	private readonly port: number;
	private readonly authToken: string;
	private readonly getDomain: (domainId: string) => DomainSnapshot | null;
	private readonly getDomainMeta: (domainId: string) => DomainMeta | null;
	private readonly hasLinkEdge: (srcDomainId: string, dstDomainId: string) => boolean;
	private readonly adminDomainIdGetter: () => string | null;
	private readonly reachGetter: GatewayBridgeParams["reach"];
	private readonly seenRegisterNonces = new Map<string, number>();

	public constructor({
		port,
		authToken,
		getDomain,
		getDomainMeta,
		hasLinkEdge,
		adminDomainId,
		reach,
	}: GatewayBridgeParams) {
		this.port = port;
		this.authToken = authToken;
		this.getDomain = getDomain;
		this.getDomainMeta = getDomainMeta;
		this.hasLinkEdge = hasLinkEdge;
		this.adminDomainIdGetter = adminDomainId;
		this.reachGetter = reach;
		this.handleCall = this.handleCall.bind(this);
		this.onConnect = this.onConnect.bind(this);
		this.onDisconnect = this.onDisconnect.bind(this);
	}

	public start(): void {
		this.transport = new GatewayTransport({
			port: this.port,
			authToken: this.authToken,
			provider: this,
			label: "BridgeServer",
		});
		this.transport.start();
	}

	public attach(): void {
		if (this.transport) return;
		this.transport = new GatewayTransport({
			port: this.port,
			authToken: this.authToken,
			provider: this,
			label: "GatewayBridge",
		});
	}

	public get transportAdapter(): GatewayTransport | null {
		return this.transport;
	}

	/** How many Gateways are registered right now. The Router's own count, so an operator can hold
	 * it against a Gateway's `router_connected`, which is only that Gateway's view of its socket and
	 * still reads true across a half-open one. */
	public get registeredGatewayCount(): number {
		return this.connGateways.size;
	}

	/** The gateways registered into ONE Domain, with the signing key each presented. Scoped by Domain
	 * because the app token every console holds is shared across tenants, so an unscoped list would
	 * hand one tenant another's gateway names. `signPub` is null for an identity-less admin-Domain
	 * registration, which is the only kind that reaches the map without one. */
	public registeredGateways(domainId: string): { gatewayId: string; signPub: string | null }[] {
		const out: { gatewayId: string; signPub: string | null }[] = [];
		for (const reg of this.connGateways.values()) {
			if (reg.domainId === domainId) out.push({ gatewayId: reg.gatewayId, signPub: reg.signPub });
		}
		return out.sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
	}

	public stop(): void {
		this.transport?.stop();
		this.transport = null;
		for (const [relayId, pending] of this.pendingRelays) {
			clearTimeout(pending.timer);
			pending.resolve({ relayId, ok: false, error: "gateway bridge shutting down" });
		}
		this.pendingRelays.clear();
		for (const [handshakeId, pending] of this.pendingHandshakes) {
			clearTimeout(pending.timer);
			pending.resolve({ handshakeId, ok: false, error: "gateway bridge shutting down" });
		}
		this.pendingHandshakes.clear();
		this.handshakeAttempts.clear();
		this.gatewayConnections.clear();
		this.connGateways.clear();
	}

	private adminDomain(): string | null {
		return this.adminDomainIdGetter();
	}

	public isConnected(): boolean {
		return this.adminFallbackConnection() !== null;
	}

	public pushGatewayFrame(frame: Record<string, unknown>): boolean {
		const connId = this.adminFallbackConnection();
		if (!connId) return false;
		const ws = this.transport?.getConnection(connId);
		if (!ws) return false;
		try {
			ws.send(JSON.stringify(frame));
			return true;
		} catch (err) {
			console.error(`[BridgeServer] pushGatewayFrame failed:`, err);
			return false;
		}
	}

	private adminFallbackConnection(): ConnectionId | null {
		if (!this.transport) return null;
		const dom = this.adminDomain();
		if (!dom) return null;
		for (const connId of this.gatewayConnections.get(dom)?.values() ?? []) {
			const ws = this.transport.getConnection(connId);
			if (ws && ws.readyState === 1) return connId;
		}
		return null;
	}

	public pushToGateway(gatewayId: string, frame: Record<string, unknown>): boolean {
		const dom = this.adminDomain();
		if (!dom) return false;
		return this.pushToGatewayInDomain(dom, gatewayId, frame);
	}

	private pushToGatewayInDomain(domainId: string, gatewayId: string, frame: Record<string, unknown>): boolean {
		if (!this.transport) return false;
		const connId = this.gatewayConnections.get(domainId)?.get(gatewayId);
		if (!connId) return false;
		const ws = this.transport.getConnection(connId);
		if (!ws) return false;
		try {
			ws.send(JSON.stringify(frame));
			return true;
		} catch (err) {
			console.error(`[BridgeServer] pushToGateway(${domainId}/${gatewayId}) failed:`, err);
			return false;
		}
	}

	public gatewayIds(): string[] {
		const dom = this.adminDomain();
		if (!dom) return [];
		return [...(this.gatewayConnections.get(dom)?.keys() ?? [])];
	}

	public onlineDomainIds(): Set<string> {
		const out = new Set<string>();
		for (const [domainId, conns] of this.gatewayConnections) {
			if (conns.size > 0) out.add(domainId);
		}
		return out;
	}

	public broadcastDomainUpdate(domainId: string): void {
		const domain = this.getDomain(domainId);
		if (!domain) return;
		const frame = { type: "domain_update", domain, displayName: domain.displayName ?? null };
		for (const gatewayId of this.gatewayConnections.get(domainId)?.keys() ?? []) {
			this.pushToGatewayInDomain(domainId, gatewayId, frame);
		}
	}

	public evictDomain(domainId: string, reason: string): void {
		const domainMap = this.gatewayConnections.get(domainId);
		if (domainMap) {
			for (const [gatewayId, connId] of domainMap) {
				const ws = this.transport?.getConnection(connId);
				try {
					ws?.close(1000, reason);
				} catch {}
				this.connGateways.delete(connId);
				console.log(`[BridgeServer] evicted gateway ${domainId}/${gatewayId}: ${reason}`);
			}
			this.gatewayConnections.delete(domainId);
		}
		for (const [relayId, pending] of this.pendingRelays) {
			if (pending.dstDomainId !== domainId) continue;
			clearTimeout(pending.timer);
			this.pendingRelays.delete(relayId);
			pending.resolve({ relayId, ok: false, error: reason });
		}
	}

	public setConsoleRelaySettler(fn: (opId: string, reply: Record<string, unknown>) => void): void {
		this.consoleRelaySettler = fn;
	}

	////////////////////////////////
	//  ToolProvider implementation

	public async handleCall(connId: ConnectionId, name: string, params: Record<string, unknown>): Promise<unknown> {
		if (name === "console_relay_reply") {
			if (typeof params.opId === "string") this.consoleRelaySettler?.(params.opId, params);
			return { settled: true };
		}
		if (name === "gateway_register") return this.handleGatewayRegister(connId, params);
		if (name === "gateway_relay") return this.handleGatewayRelay(connId, params);
		if (name === "gateway_relay_reply") return this.handleGatewayRelayReply(connId, params);
		if (name === "cross_domain_handshake") return this.handleCrossDomainHandshake(connId, params);
		if (name === "cross_domain_handshake_reply") return this.handleCrossDomainHandshakeReply(connId, params);
		if (name === "cross_domain_handshake_reveal") return this.handleCrossDomainHandshakeReveal(connId, params);
		if (name === "cross_domain_handshake_reveal_reply")
			return this.handleCrossDomainHandshakeRevealReply(connId, params);
		if (name === "list_gateways") return this.handleListGateways(connId);
		return this.handleActionCall(name, params);
	}

	public onConnect(_connId: ConnectionId): void {
		console.log(`[BridgeServer] Client connected`);
	}

	public onDisconnect(connId: ConnectionId): void {
		const reg = this.connGateways.get(connId);
		console.log(`[BridgeServer] Client disconnected${reg ? ` (gateway ${reg.domainId}/${reg.gatewayId})` : ""}`);
		this.connGateways.delete(connId);
		if (reg) {
			const domainMap = this.gatewayConnections.get(reg.domainId);
			if (domainMap?.get(reg.gatewayId) === connId) {
				domainMap.delete(reg.gatewayId);
				if (domainMap.size === 0) this.gatewayConnections.delete(reg.domainId);
			}
		}
		if (reg) {
			for (const [relayId, pending] of this.pendingRelays) {
				if (pending.dstDomainId !== reg.domainId || pending.dstGateway !== reg.gatewayId) continue;
				clearTimeout(pending.timer);
				this.pendingRelays.delete(relayId);
				pending.resolve({ relayId, ok: false, error: `gateway "${reg.gatewayId}" disconnected` });
			}
		}
		for (const [handshakeId, pending] of this.pendingHandshakes) {
			if (pending.dstConnId !== connId) continue;
			clearTimeout(pending.timer);
			this.pendingHandshakes.delete(handshakeId);
			pending.resolve({ handshakeId, ok: false, error: `gateway "${pending.dstGateway}" disconnected` });
		}
	}

	////////////////////////////////
	//  Internal call handlers

	private handleGatewayRegister(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = GatewayRegisterParamsSchema.safeParse(params);
		if (!parsed.success)
			return { ok: false, error: `invalid gateway_register: ${parsed.error.issues[0]?.message}` };
		const { gatewayId, protocolVersion } = parsed.data;
		const domainId = sanitizeDomainId(parsed.data.domainId);
		if (protocolVersion < FEDERATION_PROTOCOL_VERSION) {
			return { ok: false, error: "version_too_old", floor: FEDERATION_PROTOCOL_VERSION };
		}
		const meta = this.getDomainMeta(domainId);
		if (meta?.status === "pending") {
			// Reject pending registrations.
			console.warn(`[BridgeServer] rejected gateway_register into pending domain "${domainId}/${gatewayId}"`);
			return {
				ok: false,
				pending: true,
				error: `registration_denied: admitted-identity proof required for domain "${domainId}"`,
			};
		}
		const domain = this.getDomain(domainId);
		if (domain) {
			const presented = !!(parsed.data.signPub || parsed.data.admission || parsed.data.proof);
			if (presented) {
				const denied = verifyRegistrationClaim(parsed.data, {
					ownerSignPub: domain.ownerSignPub,
					revocations: domain.revocations,
				});
				if (denied) {
					console.warn(`[BridgeServer] rejected registration for "${domainId}/${gatewayId}": ${denied}`);
					return { ok: false, error: `registration_denied: ${denied}` };
				}
				if (!this.rememberRegisterNonce(parsed.data.proofNonce)) {
					console.warn(`[BridgeServer] rejected replayed registration proof for "${domainId}/${gatewayId}"`);
					return { ok: false, error: `registration_denied: registration proof replayed` };
				}
			} else if (domainId !== this.adminDomain()) {
				// Leak nothing to unadmitted callers.
				console.warn(
					`[BridgeServer] rejected identity-less registration into a rooted non-admin domain "${domainId}/${gatewayId}"`,
				);
				return {
					ok: false,
					error: `registration_denied: admitted-identity proof required for domain "${domainId}"`,
				};
			}
		}
		this.domainMap(domainId).set(gatewayId, connId);
		this.connGateways.set(connId, { domainId, gatewayId, signPub: parsed.data.signPub ?? null });
		console.log(`[BridgeServer] Gateway registered: ${domainId}/${gatewayId} (v${protocolVersion})`);
		const peers = [...this.domainMap(domainId).keys()].filter((h) => h !== gatewayId);
		const reply: Record<string, unknown> = {
			ok: true,
			protocolVersion: FEDERATION_PROTOCOL_VERSION,
			domainId,
			gateways: peers,
		};
		if (domain) reply.domain = domain;
		if (meta) {
			reply.domainStatus = meta.status;
			if (meta.displayName != null) reply.displayName = meta.displayName;
		}
		reply.isAdminDomain = domainId === this.adminDomain();
		// Only when there is something to say: an empty reach would overwrite what a Gateway already
		// learned with nothing, and a Router configured with neither address has nothing to teach.
		const reach = this.reachGetter?.();
		if (reach && (reach.publicHost || reach.lanAddresses?.length)) reply.reach = reach;
		return reply;
	}

	private domainMap(domainId: string): Map<string, ConnectionId> {
		let m = this.gatewayConnections.get(domainId);
		if (!m) {
			m = new Map();
			this.gatewayConnections.set(domainId, m);
		}
		return m;
	}

	private rememberRegisterNonce(nonce: string | undefined): boolean {
		if (!nonce) return false;
		const now = Date.now();
		for (const [key, expiry] of this.seenRegisterNonces) if (expiry <= now) this.seenRegisterNonces.delete(key);
		if (this.seenRegisterNonces.has(nonce)) return false;
		this.seenRegisterNonces.set(nonce, now + REGISTER_MAX_SKEW_MS);
		return true;
	}

	private handleGatewayRelay(
		connId: ConnectionId,
		params: Record<string, unknown>,
	): Promise<GatewayRelayReplyParams> {
		const parsed = GatewayRelayRouteSchema.safeParse(params);
		if (!parsed.success) {
			return Promise.resolve({
				relayId: "",
				ok: false,
				error: `invalid gateway_relay: ${parsed.error.issues[0]?.message}`,
			});
		}
		const { relayId, srcGateway, dstGateway, payload } = parsed.data;
		const senderDomainId = this.connGateways.get(connId)?.domainId;
		if (!senderDomainId) return Promise.resolve({ relayId, ok: false, error: "sender Gateway not registered" });
		let dstDomainId = senderDomainId;
		let dstConnId = this.gatewayConnections.get(senderDomainId)?.get(dstGateway);
		if (!dstConnId) {
			// Link edges gate foreign relays.
			const foreign = this.resolveForeignGateway(senderDomainId, dstGateway);
			if (foreign === "ambiguous") {
				return Promise.resolve({
					relayId,
					ok: false,
					error: `gateway "${dstGateway}" is ambiguous across Domains`,
				});
			}
			if (foreign && this.hasLinkEdge(senderDomainId, foreign.domainId)) {
				dstDomainId = foreign.domainId;
				dstConnId = foreign.connId;
			}
		}
		const ws = dstConnId ? this.transport?.getConnection(dstConnId) : null;
		if (!ws) return Promise.resolve({ relayId, ok: false, error: `gateway "${dstGateway}" is offline` });
		return new Promise<GatewayRelayReplyParams>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingRelays.delete(relayId);
				resolve({ relayId, ok: false, error: `gateway "${dstGateway}" did not answer in time` });
			}, GATEWAY_RELAY_TIMEOUT_MS);
			this.pendingRelays.set(relayId, { resolve, timer, dstDomainId, dstGateway });
			try {
				ws.send(
					JSON.stringify({
						type: "gateway_relay",
						// REQUIRED by the schema every destination parses this with. Omitted here, so every
						// gateway-to-gateway relay was rejected at the far end as "expected number, received
						// undefined" - discovery, cross-Gateway send, board and push fan-out, all of it. It
						// stayed invisible because a Domain with one Gateway never relays to another, and
						// `discover()` maps a failed relay to an empty list with no log.
						v: FEDERATION_PROTOCOL_VERSION,
						relayId,
						srcGateway,
						srcDomain: senderDomainId,
						dstGateway,
						payload,
					}),
				);
			} catch (err) {
				clearTimeout(timer);
				this.pendingRelays.delete(relayId);
				resolve({ relayId, ok: false, error: `forward to "${dstGateway}" failed: ${err}` });
			}
		});
	}

	private handleGatewayRelayReply(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = GatewayRelayReplyParamsSchema.safeParse(params);
		if (!parsed.success) return { settled: false };
		const pending = this.pendingRelays.get(parsed.data.relayId);
		const reg = this.connGateways.get(connId);
		if (!pending || !reg || reg.domainId !== pending.dstDomainId || reg.gatewayId !== pending.dstGateway) {
			return { settled: false };
		}
		clearTimeout(pending.timer);
		this.pendingRelays.delete(parsed.data.relayId);
		pending.resolve(parsed.data);
		return { settled: true };
	}

	private handleCrossDomainHandshake(
		connId: ConnectionId,
		params: Record<string, unknown>,
	): Promise<CrossDomainHandshakeReplyParams> {
		const parsed = CrossDomainHandshakeRouteSchema.safeParse(params);
		if (!parsed.success) {
			return Promise.resolve({
				handshakeId: "",
				ok: false,
				error: `invalid cross_domain_handshake: ${parsed.error.issues[0]?.message}`,
			});
		}
		const { handshakeId, srcDomain, srcGateway, dstGateway, payload } = parsed.data;
		const senderDomainId = this.connGateways.get(connId)?.domainId;
		if (!senderDomainId) return Promise.resolve({ handshakeId, ok: false, error: "sender Gateway not registered" });
		const dst = this.resolveForeignGateway(senderDomainId, dstGateway);
		if (dst === "ambiguous") {
			return Promise.resolve({
				handshakeId,
				ok: false,
				error: `gateway "${dstGateway}" is ambiguous across Domains`,
			});
		}
		const ws = dst ? this.transport?.getConnection(dst.connId) : null;
		if (!dst || !ws)
			return Promise.resolve({ handshakeId, ok: false, error: `gateway "${dstGateway}" is offline` });
		if (!this.allowHandshakeAttempt(senderDomainId, dstGateway)) {
			return Promise.resolve({
				handshakeId,
				ok: false,
				error: `too many cross-Domain handshake attempts; try again later`,
			});
		}
		return this.forwardHandshakeFrame("cross_domain_handshake", dst.connId, {
			handshakeId,
			srcDomain,
			srcGateway,
			dstGateway,
			payload,
		});
	}

	private handleCrossDomainHandshakeReveal(
		connId: ConnectionId,
		params: Record<string, unknown>,
	): Promise<CrossDomainHandshakeRevealReplyParams> {
		const parsed = CrossDomainHandshakeRevealRouteSchema.safeParse(params);
		if (!parsed.success) {
			return Promise.resolve({
				handshakeId: "",
				ok: false,
				error: `invalid cross_domain_handshake_reveal: ${parsed.error.issues[0]?.message}`,
			});
		}
		const { handshakeId, srcDomain, srcGateway, dstGateway, payload } = parsed.data;
		const senderDomainId = this.connGateways.get(connId)?.domainId;
		if (!senderDomainId) return Promise.resolve({ handshakeId, ok: false, error: "sender Gateway not registered" });
		const dst = this.resolveForeignGateway(senderDomainId, dstGateway);
		if (dst === "ambiguous") {
			return Promise.resolve({
				handshakeId,
				ok: false,
				error: `gateway "${dstGateway}" is ambiguous across Domains`,
			});
		}
		const ws = dst ? this.transport?.getConnection(dst.connId) : null;
		if (!dst || !ws)
			return Promise.resolve({ handshakeId, ok: false, error: `gateway "${dstGateway}" is offline` });
		return this.forwardHandshakeFrame("cross_domain_handshake_reveal", dst.connId, {
			handshakeId,
			srcDomain,
			srcGateway,
			dstGateway,
			payload,
		});
	}

	private forwardHandshakeFrame(
		type: "cross_domain_handshake" | "cross_domain_handshake_reveal",
		dstConnId: ConnectionId,
		frame: { handshakeId: string; srcDomain: string; srcGateway: string; dstGateway: string; payload: unknown },
	): Promise<CrossDomainHandshakeReplyParams> {
		const { handshakeId, dstGateway } = frame;
		const ws = this.transport?.getConnection(dstConnId);
		if (!ws) return Promise.resolve({ handshakeId, ok: false, error: `gateway "${dstGateway}" is offline` });
		return new Promise<CrossDomainHandshakeReplyParams>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingHandshakes.delete(handshakeId);
				resolve({ handshakeId, ok: false, error: `gateway "${dstGateway}" did not answer in time` });
			}, CROSS_DOMAIN_HANDSHAKE_TIMEOUT_MS);
			this.pendingHandshakes.set(handshakeId, { resolve, timer, dstConnId, dstGateway });
			try {
				ws.send(JSON.stringify({ type, ...frame }));
			} catch (err) {
				clearTimeout(timer);
				this.pendingHandshakes.delete(handshakeId);
				resolve({ handshakeId, ok: false, error: `forward to "${dstGateway}" failed: ${err}` });
			}
		});
	}

	private handleCrossDomainHandshakeReply(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = CrossDomainHandshakeReplyParamsSchema.safeParse(params);
		if (!parsed.success) return { settled: false };
		return this.settleHandshake(connId, parsed.data);
	}

	private handleCrossDomainHandshakeRevealReply(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = CrossDomainHandshakeRevealReplyParamsSchema.safeParse(params);
		if (!parsed.success) return { settled: false };
		return this.settleHandshake(connId, parsed.data);
	}

	private settleHandshake(
		connId: ConnectionId,
		reply: CrossDomainHandshakeReplyParams | CrossDomainHandshakeRevealReplyParams,
	): { settled: boolean } {
		const pending = this.pendingHandshakes.get(reply.handshakeId);
		if (!pending || pending.dstConnId !== connId) return { settled: false };
		clearTimeout(pending.timer);
		this.pendingHandshakes.delete(reply.handshakeId);
		pending.resolve(reply);
		return { settled: true };
	}

	private resolveForeignGateway(
		senderDomainId: string,
		dstGateway: string,
	): { domainId: string; connId: ConnectionId } | null | "ambiguous" {
		let found: { domainId: string; connId: ConnectionId } | null = null;
		for (const [domainId, gw] of this.gatewayConnections) {
			if (domainId === senderDomainId) continue;
			const connId = gw.get(dstGateway);
			if (!connId) continue;
			const ws = this.transport?.getConnection(connId);
			if (ws?.readyState !== 1) continue;
			if (found) return "ambiguous";
			found = { domainId, connId };
		}
		return found;
	}

	private allowHandshakeAttempt(srcDomain: string, dstGateway: string): boolean {
		const now = Date.now();
		const key = `${srcDomain}|${dstGateway}`;
		const cutoff = now - HANDSHAKE_RATE_WINDOW_MS;
		for (const [k, timestamps] of this.handshakeAttempts) {
			const live = timestamps.filter((t) => t > cutoff);
			if (live.length === 0) this.handshakeAttempts.delete(k);
			else this.handshakeAttempts.set(k, live);
		}
		const recent = (this.handshakeAttempts.get(key) ?? []).filter((t) => t > cutoff);
		if (recent.length >= HANDSHAKE_RATE_MAX) {
			this.handshakeAttempts.set(key, recent);
			return false;
		}
		recent.push(now);
		this.handshakeAttempts.set(key, recent);
		return true;
	}

	private handleListGateways(connId: ConnectionId): unknown {
		const reg = this.connGateways.get(connId);
		// Refused, not answered empty: "you are not registered" and "you have no peers" must stay
		// distinct answers, or a revoked Gateway reads its own refusal as an empty mesh. An older
		// gateway folds the error to [] exactly as it folded this empty answer.
		if (!reg) throw new Error("not registered");
		const { domainId, gatewayId: self } = reg;
		const gateways = [...(this.gatewayConnections.get(domainId)?.keys() ?? [])]
			.filter((h) => h !== self)
			.map((gatewayId) => ({ gatewayId, online: true }));
		return { gateways };
	}

	private async handleActionCall(name: string, _params: Record<string, unknown>): Promise<unknown> {
		throw new Error(`unsupported gateway action: ${name}`);
	}
}
