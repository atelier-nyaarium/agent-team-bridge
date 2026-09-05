import type { DomainSnapshot } from "../shared/admission.js";
import { FEDERATION_VALUE_PROTOCOL_VERSION } from "../shared/router-protocol.js";
import { type InboxRow, parseInboxAddress } from "../shared/schemasInbox.js";
import { GATEWAY_ERROR_STALE_INCARNATION } from "../shared/wire-vocabulary.js";
import type { ReferenceHeldStore } from "./blobs/referenceHeldStore.js";
import type { BlobOrigin, RouterBlobCache } from "./blobs/routerBlobCache.js";
import { FrameDispatchTable, MIGRATION_FENCED_GATEWAY_FRAMES } from "./bridge/frameDispatch.js";
import { INCARNATION_GATED_FRAMES, InboxFrames } from "./bridge/inboxFrames.js";
import { RegistrationHandler } from "./bridge/registrationHandler.js";
import { RelayRouter } from "./bridge/relayRouter.js";
import type { DomainMeta } from "./enrollmentCoordinator.js";
import { type ConnectionId, GatewayTransport, type ToolProvider } from "./gatewayTransport.js";
import { BlobFetchRoute } from "./inbox/blobFetchRoute.js";
import type { InboxService, PeerRowGate } from "./inbox/inboxService.js";
import { readRouterMigrationWindow } from "./migration/leaseService.js";

export interface GatewayBridgeParams {
	port: number;
	authToken: string;
	// Four callbacks enforce registration trust.
	getDomain: (domainId: string) => DomainSnapshot | null;
	getDomainMeta: (domainId: string) => DomainMeta | null;
	hasLinkEdge: (srcDomainId: string, dstDomainId: string) => boolean;
	adminDomainId: () => string | null;
	/** Registration carries reach because `reach` is gated. */
	reach?: () => { publicHost?: string | null; publicPort?: number | null; lanAddresses?: string[] };
	inbox?: InboxService;
	blobCache?: RouterBlobCache;
	referenceHeld?: ReferenceHeldStore;
	now?: () => number;
}

/** Authenticated frame identity, not payload identity. */
export interface GatewayRegistration {
	domainId: string;
	gatewayId: string;
	signPub: string;
	incarnation: number;
	protocolVersion?: number;
}
export type GatewayFrameHandler = (
	reg: GatewayRegistration,
	params: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** A registered connection's identity and inbox incarnation. Null incarnation means no inbox claim. */
export interface ConnGatewayRecord {
	domainId: string;
	gatewayId: string;
	signPub: string | null;
	incarnation: number | null;
	protocolVersion?: number;
}

export class GatewayBridge implements ToolProvider {
	private readonly frameTable = new FrameDispatchTable();
	private readonly sessionForgottenListeners: Array<(reg: GatewayRegistration, sessionId: string) => void> = [];
	/** Whether a gateway is migration-fenced. */
	private migrationFenced: ((domainId: string, gatewayId: string) => boolean) | null = null;
	private migrationReady: ((domainId: string) => boolean) | null = null;
	private migrationLease: ((domainId: string, gatewayId: string) => void) | null = null;
	private readonly registeredListeners: Array<(reg: GatewayRegistration) => void> = [];
	private readonly droppedListeners: Array<(reg: GatewayRegistration) => void> = [];
	private transport: GatewayTransport | null = null;
	private gatewayConnections = new Map<string, Map<string, ConnectionId>>();
	private connGateways = new Map<ConnectionId, ConnGatewayRecord>();
	private readonly inbox: InboxService | null;
	private readonly blobCache: RouterBlobCache | null;
	private readonly referenceHeld: ReferenceHeldStore | null;
	private readonly blobFetch: BlobFetchRoute | null;
	private readonly registrationHandler: RegistrationHandler;
	private readonly relayRouter: RelayRouter;
	private readonly inboxFrames: InboxFrames;
	private readonly port: number;
	private readonly authToken: string;
	private readonly getDomain: (domainId: string) => DomainSnapshot | null;
	private readonly getDomainMeta: (domainId: string) => DomainMeta | null;
	private readonly hasLinkEdge: (srcDomainId: string, dstDomainId: string) => boolean;
	private readonly adminDomainIdGetter: () => string | null;
	private readonly reachGetter: GatewayBridgeParams["reach"];
	private readonly now: () => number;

	public constructor({
		port,
		authToken,
		getDomain,
		getDomainMeta,
		hasLinkEdge,
		adminDomainId,
		reach,
		inbox,
		blobCache,
		referenceHeld,
		now,
	}: GatewayBridgeParams) {
		this.now = now ?? Date.now;
		this.port = port;
		this.authToken = authToken;
		this.getDomain = getDomain;
		this.getDomainMeta = getDomainMeta;
		this.hasLinkEdge = hasLinkEdge;
		this.adminDomainIdGetter = adminDomainId;
		this.reachGetter = reach;
		this.inbox = inbox ?? null;
		this.blobCache = blobCache ?? null;
		this.referenceHeld = referenceHeld ?? null;
		this.blobFetch = blobCache
			? new BlobFetchRoute(blobCache, (domainId, gatewayId) => {
					const connId = this.gatewayConnections.get(domainId)?.get(gatewayId);
					const ws = connId ? this.transport?.getConnection(connId) : null;
					const incarnation = connId ? this.connGateways.get(connId)?.incarnation : null;
					return connId && ws && incarnation !== null && incarnation !== undefined
						? { connId, incarnation, send: (frame) => ws.send(JSON.stringify(frame)) }
						: null;
				})
			: null;
		this.relayRouter = new RelayRouter({
			hasLinkEdge: this.hasLinkEdge,
			now: this.now,
			gatewayConnections: this.gatewayConnections,
			getConnection: (connId) => this.transport?.getConnection(connId) ?? null,
			registrationOf: (connId) => {
				const reg = this.connGateways.get(connId);
				return reg ? { domainId: reg.domainId, gatewayId: reg.gatewayId } : undefined;
			},
		});
		this.registrationHandler = new RegistrationHandler({
			getDomain: this.getDomain,
			getDomainMeta: this.getDomainMeta,
			adminDomainId: this.adminDomainIdGetter,
			reach: this.reachGetter,
			inbox: this.inbox,
			now: this.now,
			migrationLease: (domainId, gatewayId) => this.migrationLease?.(domainId, gatewayId),
			migrationFenced: (domainId, gatewayId) => this.migrationFenced?.(domainId, gatewayId) ?? false,
			setConnection: (domainId, gatewayId, connId) => this.domainMap(domainId).set(gatewayId, connId),
			gatewaysInDomain: (domainId) => [...this.domainMap(domainId).keys()],
			setRegistration: (connId, reg) => this.connGateways.set(connId, reg),
			notifyRegistered: (registered) => {
				for (const listener of this.registeredListeners) listener(registered);
			},
			getConnectionId: (domainId, gatewayId) => this.gatewayConnections.get(domainId)?.get(gatewayId),
			getIncarnation: (connId) => this.connGateways.get(connId)?.incarnation,
			send: (domainId, gatewayId, frame) => this.pushToGatewayInDomain(domainId, gatewayId, frame),
		});
		this.inboxFrames = new InboxFrames({
			inbox: this.inbox,
			hasLinkEdge: this.hasLinkEdge,
			getDomain: this.getDomain,
			blobCache: this.blobCache,
			referenceHeld: this.referenceHeld,
			blobFetch: this.blobFetch,
			isMigrationFenced: (domainId, gatewayId) => this.migrationFenced?.(domainId, gatewayId) ?? false,
			getRegistration: (connId) => this.connGateways.get(connId),
			getConnectionId: (domainId, gatewayId) => this.gatewayConnections.get(domainId)?.get(gatewayId),
			getConnection: (connId) => this.transport?.getConnection(connId) ?? null,
			send: (domainId, gatewayId, frame) => this.pushToGatewayInDomain(domainId, gatewayId, frame),
			notifySessionForgotten: (identity, sessionId) => {
				for (const listener of this.sessionForgottenListeners) listener(identity, sessionId);
			},
		});
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

	public get registeredGatewayCount(): number {
		return this.connGateways.size;
	}

	public registeredGateways(domainId: string): {
		gatewayId: string;
		signPub: string | null;
		incarnation: number;
		protocolVersion: number;
	}[] {
		const out: { gatewayId: string; signPub: string | null; incarnation: number; protocolVersion: number }[] = [];
		for (const reg of this.connGateways.values()) {
			if (reg.domainId === domainId)
				out.push({
					gatewayId: reg.gatewayId,
					signPub: reg.signPub,
					incarnation: reg.incarnation ?? 0,
					protocolVersion: reg.protocolVersion ?? 0,
				});
		}
		return out.sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
	}

	public gatewayProtocol(domainId: string, gatewayId: string): number | null {
		const connId = this.gatewayConnections.get(domainId)?.get(gatewayId);
		return connId ? (this.connGateways.get(connId)?.protocolVersion ?? null) : null;
	}

	public stop(): void {
		this.transport?.stop();
		this.transport = null;
		this.relayRouter.stop();
		this.inboxFrames.stop();
		this.blobFetch?.stop();
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

	public pushInboxRows(domainId: string, addressText: string, rows: InboxRow[]): boolean {
		const address = parseInboxAddress(addressText);
		if (!address) return false;
		if (address.kind === "owner") return true;
		const connId = this.gatewayConnections.get(domainId)?.get(address.gatewayId);
		const reg = connId ? this.connGateways.get(connId) : undefined;
		if (!reg || reg.incarnation === null) return false;
		if (
			reg.protocolVersion !== undefined &&
			reg.protocolVersion < FEDERATION_VALUE_PROTOCOL_VERSION &&
			rows.some((row) => row.envelope.kind === "console_op")
		)
			return false;
		return this.pushToGatewayInDomain(domainId, address.gatewayId, {
			type: "inbox_deliver",
			address: addressText,
			rows,
			incarnation: reg.incarnation,
			deliveryEpoch: this.inbox?.deliveryEpoch(address) ?? 1,
		});
	}

	/** Handlers receive connection identity. */
	public registerGatewayFrame(name: string, handler: GatewayFrameHandler): void {
		this.frameTable.register(name, handler);
	}

	public onSessionForgotten(listener: (reg: GatewayRegistration, sessionId: string) => void): void {
		this.sessionForgottenListeners.push(listener);
	}

	public onGatewayRegistered(listener: (reg: GatewayRegistration) => void): void {
		this.registeredListeners.push(listener);
	}

	/** Fires for the registered connection only. */
	public onGatewayDropped(listener: (reg: GatewayRegistration) => void): void {
		this.droppedListeners.push(listener);
	}

	/** Stamp frames with the registration incarnation. */
	public pushFrameTo(domainId: string, gatewayId: string, frame: Record<string, unknown>): boolean {
		const incarnation = this.gatewayIncarnation(domainId, gatewayId);
		if (incarnation === null) return false;
		return this.pushToGatewayInDomain(domainId, gatewayId, { ...frame, incarnation });
	}

	public gatewayIncarnation(domainId: string, gatewayId: string): number | null {
		const connId = this.gatewayConnections.get(domainId)?.get(gatewayId);
		if (!connId) return null;
		return this.connGateways.get(connId)?.incarnation ?? null;
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
		this.relayRouter.evictDomain(domainId, reason);
	}

	public async handleCall(connId: ConnectionId, name: string, params: Record<string, unknown>): Promise<unknown> {
		if (name === "gateway_register") return this.registrationHandler.handle(connId, params);
		if (INCARNATION_GATED_FRAMES.has(name)) return this.inboxFrames.handle(connId, name, params);
		const frameHandler = this.frameTable.get(name);
		if (frameHandler) {
			const reg = this.connGateways.get(connId);
			if (!reg?.signPub || reg.incarnation === null) return { ok: false, error: "inbox_unavailable" };
			if (params.incarnation !== reg.incarnation) {
				console.warn(`[BridgeServer] stale gateway incarnation for ${name}`);
				return { ok: false, error: GATEWAY_ERROR_STALE_INCARNATION };
			}
			if (
				readRouterMigrationWindow().fenced &&
				MIGRATION_FENCED_GATEWAY_FRAMES.has(name) &&
				this.migrationReady &&
				!this.migrationReady(reg.domainId)
			)
				return { outcome: "refused", reason: "migrating" };
			// Strip caller-supplied identity fields.
			const { domainId: _domainId, gatewayId: _gatewayId, ...payload } = params;
			return frameHandler(
				{
					domainId: reg.domainId,
					gatewayId: reg.gatewayId,
					signPub: reg.signPub,
					incarnation: reg.incarnation,
				},
				payload,
			);
		}
		if (name === "gateway_relay") return this.relayRouter.handleGatewayRelay(connId, params);
		if (name === "gateway_relay_reply") return this.relayRouter.handleGatewayRelayReply(connId, params);
		if (name === "cross_domain_handshake") return this.relayRouter.handleCrossDomainHandshake(connId, params);
		if (name === "cross_domain_handshake_reply")
			return this.relayRouter.handleCrossDomainHandshakeReply(connId, params);
		if (name === "cross_domain_handshake_reveal")
			return this.relayRouter.handleCrossDomainHandshakeReveal(connId, params);
		if (name === "cross_domain_handshake_reveal_reply")
			return this.relayRouter.handleCrossDomainHandshakeRevealReply(connId, params);
		if (name === "list_gateways") return this.handleListGateways(connId);
		return this.handleActionCall(name, params);
	}

	public onConnect(_connId: ConnectionId): void {
		console.log(`[BridgeServer] Client connected`);
	}

	public onDisconnect(connId: ConnectionId): void {
		this.inboxFrames.dropConnection(connId);
		const reg = this.connGateways.get(connId);
		const wasCurrent = reg ? this.gatewayConnections.get(reg.domainId)?.get(reg.gatewayId) === connId : false;
		console.log(`[BridgeServer] Client disconnected${reg ? ` (gateway ${reg.domainId}/${reg.gatewayId})` : ""}`);
		this.connGateways.delete(connId);
		if (reg) {
			const domainMap = this.gatewayConnections.get(reg.domainId);
			const current = domainMap?.get(reg.gatewayId) === connId;
			if (current) {
				domainMap.delete(reg.gatewayId);
				if (domainMap.size === 0) this.gatewayConnections.delete(reg.domainId);
			}
		}
		this.blobFetch?.failConnection(connId);
		if (reg && wasCurrent && reg.signPub && reg.incarnation !== null) {
			const dropped = {
				domainId: reg.domainId,
				gatewayId: reg.gatewayId,
				signPub: reg.signPub,
				incarnation: reg.incarnation,
			};
			for (const listener of this.droppedListeners) listener(dropped);
		}
		this.relayRouter.dropConnection(connId, reg, wasCurrent);
	}

	public setPeerRowGate(gate: PeerRowGate): void {
		this.inboxFrames.setPeerRowGate(gate);
	}

	/** Owner rows a gateway appends reach the bound console sockets through this. */
	public setOwnerRowPush(push: (domainId: string, row: InboxRow) => void): void {
		this.inboxFrames.setOwnerRowPush(push);
	}

	public setMigrationFence(fenced: (domainId: string, gatewayId: string) => boolean): void {
		this.migrationFenced = fenced;
	}

	public setMigrationReady(ready: (domainId: string) => boolean): void {
		this.migrationReady = ready;
	}

	public setMigrationLease(put: (domainId: string, gatewayId: string) => void): void {
		this.migrationLease = put;
	}

	/** Owner reads use the same cross-Domain gate. */
	public fetchBlobForOwner(
		domainId: string,
		params: { opId: string; blobId: string; range?: { offset: number; length: number }; origin?: BlobOrigin },
	): Promise<unknown> {
		if (!this.blobFetch) return Promise.resolve({ outcome: "unreachable" });
		const origin = params.origin;
		if (origin && origin.domainId !== domainId && !this.hasLinkEdge(domainId, origin.domainId))
			return Promise.resolve({ outcome: "unreachable" });
		return this.blobFetch.fetch(domainId, { ...params, incarnation: 1 });
	}

	public forwardGatewayValue(
		domainId: string,
		params: {
			opId: string;
			conversationId: string;
			signerSignPub: string;
			device: string;
			gatewayId: string;
			value: unknown;
		},
	): Promise<unknown> {
		return this.inboxFrames.forwardGatewayValue(domainId, params);
	}

	private domainMap(domainId: string): Map<string, ConnectionId> {
		let m = this.gatewayConnections.get(domainId);
		if (!m) {
			m = new Map();
			this.gatewayConnections.set(domainId, m);
		}
		return m;
	}

	private handleListGateways(connId: ConnectionId): unknown {
		const reg = this.connGateways.get(connId);
		// Preserve refusal versus an empty peer list.
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
