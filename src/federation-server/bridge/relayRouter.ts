import {
	type CrossDomainHandshakeReplyParams,
	CrossDomainHandshakeReplyParamsSchema,
	type CrossDomainHandshakeRevealReplyParams,
	CrossDomainHandshakeRevealReplyParamsSchema,
	CrossDomainHandshakeRevealRouteSchema,
	CrossDomainHandshakeRouteSchema,
	FEDERATION_PROTOCOL_VERSION,
	type GatewayRelayReplyParams,
	GatewayRelayReplyParamsSchema,
	GatewayRelayRouteSchema,
} from "../../shared/router-protocol.js";
import type { ConnectionId, GatewayTransport } from "../gatewayTransport.js";
import { HANDSHAKE_RATE_MAX, HANDSHAKE_RATE_WINDOW_MS } from "../handshakeRateLimit.js";
import { CROSS_DOMAIN_HANDSHAKE_TIMEOUT_MS, GATEWAY_RELAY_TIMEOUT_MS } from "../relayTimeouts.js";

type WSLike = ReturnType<GatewayTransport["getConnection"]>;

export interface RelayRouterDeps {
	hasLinkEdge: (srcDomainId: string, dstDomainId: string) => boolean;
	now: () => number;
	gatewayConnections: ReadonlyMap<string, ReadonlyMap<string, ConnectionId>>;
	getConnection: (connId: ConnectionId) => WSLike;
	/** Domain and gateway id of a registered connection, if any. */
	registrationOf: (connId: ConnectionId) => { domainId: string; gatewayId: string } | undefined;
}

/** Cross-gateway relay and cross-Domain handshake forwarding. */
export class RelayRouter {
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

	constructor(private readonly deps: RelayRouterDeps) {}

	stop(): void {
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
	}

	evictDomain(domainId: string, reason: string): void {
		for (const [relayId, pending] of this.pendingRelays) {
			if (pending.dstDomainId !== domainId) continue;
			clearTimeout(pending.timer);
			this.pendingRelays.delete(relayId);
			pending.resolve({ relayId, ok: false, error: reason });
		}
	}

	/** Fails relays and handshakes owned by a dropped connection. */
	dropConnection(
		connId: ConnectionId,
		reg: { domainId: string; gatewayId: string } | undefined,
		wasCurrent: boolean,
	): void {
		if (reg && wasCurrent) {
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

	handleGatewayRelay(connId: ConnectionId, params: Record<string, unknown>): Promise<GatewayRelayReplyParams> {
		const parsed = GatewayRelayRouteSchema.safeParse(params);
		if (!parsed.success) {
			return Promise.resolve({
				relayId: "",
				ok: false,
				error: `invalid gateway_relay: ${parsed.error.issues[0]?.message}`,
			});
		}
		const { relayId, srcGateway, dstGateway, payload } = parsed.data;
		const senderDomainId = this.deps.registrationOf(connId)?.domainId;
		if (!senderDomainId) return Promise.resolve({ relayId, ok: false, error: "sender Gateway not registered" });
		let dstDomainId = senderDomainId;
		let dstConnId = this.deps.gatewayConnections.get(senderDomainId)?.get(dstGateway);
		if (!dstConnId) {
			const foreign = this.resolveForeignGateway(senderDomainId, dstGateway);
			if (foreign === "ambiguous") {
				return Promise.resolve({
					relayId,
					ok: false,
					error: `gateway "${dstGateway}" is ambiguous across Domains`,
				});
			}
			// Link edges authorize cross-Domain relays.
			if (foreign && this.deps.hasLinkEdge(senderDomainId, foreign.domainId)) {
				dstDomainId = foreign.domainId;
				dstConnId = foreign.connId;
			}
		}
		const ws = dstConnId ? this.deps.getConnection(dstConnId) : null;
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

	handleGatewayRelayReply(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = GatewayRelayReplyParamsSchema.safeParse(params);
		if (!parsed.success) return { settled: false };
		const pending = this.pendingRelays.get(parsed.data.relayId);
		const reg = this.deps.registrationOf(connId);
		if (!pending || !reg || reg.domainId !== pending.dstDomainId || reg.gatewayId !== pending.dstGateway) {
			return { settled: false };
		}
		clearTimeout(pending.timer);
		this.pendingRelays.delete(parsed.data.relayId);
		pending.resolve(parsed.data);
		return { settled: true };
	}

	handleCrossDomainHandshake(
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
		const senderDomainId = this.deps.registrationOf(connId)?.domainId;
		if (!senderDomainId) return Promise.resolve({ handshakeId, ok: false, error: "sender Gateway not registered" });
		const dst = this.resolveForeignGateway(senderDomainId, dstGateway);
		if (dst === "ambiguous") {
			return Promise.resolve({
				handshakeId,
				ok: false,
				error: `gateway "${dstGateway}" is ambiguous across Domains`,
			});
		}
		const ws = dst ? this.deps.getConnection(dst.connId) : null;
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

	handleCrossDomainHandshakeReveal(
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
		const senderDomainId = this.deps.registrationOf(connId)?.domainId;
		if (!senderDomainId) return Promise.resolve({ handshakeId, ok: false, error: "sender Gateway not registered" });
		const dst = this.resolveForeignGateway(senderDomainId, dstGateway);
		if (dst === "ambiguous") {
			return Promise.resolve({
				handshakeId,
				ok: false,
				error: `gateway "${dstGateway}" is ambiguous across Domains`,
			});
		}
		const ws = dst ? this.deps.getConnection(dst.connId) : null;
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

	handleCrossDomainHandshakeReply(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = CrossDomainHandshakeReplyParamsSchema.safeParse(params);
		if (!parsed.success) return { settled: false };
		return this.settleHandshake(connId, parsed.data);
	}

	handleCrossDomainHandshakeRevealReply(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = CrossDomainHandshakeRevealReplyParamsSchema.safeParse(params);
		if (!parsed.success) return { settled: false };
		return this.settleHandshake(connId, parsed.data);
	}

	private forwardHandshakeFrame(
		type: "cross_domain_handshake" | "cross_domain_handshake_reveal",
		dstConnId: ConnectionId,
		frame: { handshakeId: string; srcDomain: string; srcGateway: string; dstGateway: string; payload: unknown },
	): Promise<CrossDomainHandshakeReplyParams> {
		const { handshakeId, dstGateway } = frame;
		const ws = this.deps.getConnection(dstConnId);
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
		for (const [domainId, gw] of this.deps.gatewayConnections) {
			if (domainId === senderDomainId) continue;
			const connId = gw.get(dstGateway);
			if (!connId) continue;
			const ws = this.deps.getConnection(connId);
			if (ws?.readyState !== 1) continue;
			if (found) return "ambiguous";
			found = { domainId, connId };
		}
		return found;
	}

	private allowHandshakeAttempt(srcDomain: string, dstGateway: string): boolean {
		const now = this.deps.now();
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
}
