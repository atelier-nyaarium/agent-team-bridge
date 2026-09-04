import { z } from "zod";
import { type DomainSnapshot, REGISTER_MAX_SKEW_MS } from "../shared/admission.js";
import { parseBlobReference } from "../shared/blob-reference.js";
import {
	BlobBeginParamsSchema,
	BlobChunkParamsSchema,
	BlobFetchParamsSchema,
	BlobFetchReplyParamsSchema,
	type CrossDomainHandshakeReplyParams,
	CrossDomainHandshakeReplyParamsSchema,
	type CrossDomainHandshakeRevealReplyParams,
	CrossDomainHandshakeRevealReplyParamsSchema,
	CrossDomainHandshakeRevealRouteSchema,
	CrossDomainHandshakeRouteSchema,
	FEDERATION_PROTOCOL_FLOOR,
	FEDERATION_PROTOCOL_VERSION,
	FEDERATION_VALUE_PROTOCOL_VERSION,
	GatewayRegisterParamsSchema,
	type GatewayRelayReplyParams,
	GatewayRelayReplyParamsSchema,
	GatewayRelayRouteSchema,
	InboxAckParamsSchema,
	InboxAppendParamsSchema,
	SessionForgetParamsSchema,
	SessionUpsertParamsSchema,
	ValueResultParamsSchema,
} from "../shared/router-protocol.js";
import {
	formatInboxAddress,
	type InboxAddress,
	type InboxRow,
	InboxRowInputSchema,
	parseInboxAddress,
} from "../shared/schemasInbox.js";
import { OP_LEDGER_PROTOCOL } from "../shared/schemasRegister.js";
import type { ReferenceHeldStore } from "./blobs/referenceHeldStore.js";
import type { BlobOrigin, RouterBlobCache } from "./blobs/routerBlobCache.js";
import { type DomainMeta, sanitizeDomainId } from "./enrollmentCoordinator.js";
import { type ConnectionId, GatewayTransport, type ToolProvider } from "./gatewayTransport.js";
import { HANDSHAKE_RATE_MAX, HANDSHAKE_RATE_WINDOW_MS } from "./handshakeRateLimit.js";
import { BlobFetchRoute } from "./inbox/blobFetchRoute.js";
import { type InboxService, type PeerRowGate, sessionTargetOf } from "./inbox/inboxService.js";
import { readRouterMigrationWindow } from "./migration/leaseService.js";
import { OwnerQuarantined } from "./owner/ownerStateStore.js";
import { verifyRegistrationClaim } from "./registrationVerification.js";
import { CROSS_DOMAIN_HANDSHAKE_TIMEOUT_MS, GATEWAY_RELAY_TIMEOUT_MS } from "./relayTimeouts.js";

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

/** Stable producer identity deduplicates retries. */
const ProducerOpHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

const BUILT_IN_FRAMES = new Set([
	"gateway_register",
	"inbox_append",
	"inbox_ack",
	"session_upsert",
	"session_forget",
	"blob_fetch",
	"blob_fetch_reply",
	"blob_begin",
	"blob_chunk",
	"gateway_relay",
	"gateway_relay_reply",
	"cross_domain_handshake",
	"cross_domain_handshake_reply",
	"cross_domain_handshake_reveal",
	"cross_domain_handshake_reveal_reply",
	"list_gateways",
]);

export class GatewayBridge implements ToolProvider {
	private readonly frameHandlers = new Map<string, GatewayFrameHandler>();
	private readonly sessionForgottenListeners: Array<(reg: GatewayRegistration, sessionId: string) => void> = [];
	private peerRowGate: PeerRowGate | null = null;
	/** Whether a gateway is migration-fenced. */
	private migrationFenced: ((domainId: string, gatewayId: string) => boolean) | null = null;
	private migrationReady: ((domainId: string) => boolean) | null = null;
	private migrationLease: ((domainId: string, gatewayId: string) => void) | null = null;
	private readonly registeredListeners: Array<(reg: GatewayRegistration) => void> = [];
	private readonly droppedListeners: Array<(reg: GatewayRegistration) => void> = [];
	private transport: GatewayTransport | null = null;
	private gatewayConnections = new Map<string, Map<string, ConnectionId>>();
	// Null incarnation means no inbox claim.
	private connGateways = new Map<
		ConnectionId,
		{
			domainId: string;
			gatewayId: string;
			signPub: string | null;
			incarnation: number | null;
			protocolVersion?: number;
		}
	>();
	private readonly inbox: InboxService | null;
	private readonly blobCache: RouterBlobCache | null;
	private readonly referenceHeld: ReferenceHeldStore | null;
	private readonly blobFetch: BlobFetchRoute | null;
	private pendingValues = new Map<
		string,
		{ resolve: (result: unknown) => void; timer: ReturnType<typeof setTimeout>; connId: ConnectionId }[]
	>();
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
	private readonly port: number;
	private readonly authToken: string;
	private readonly getDomain: (domainId: string) => DomainSnapshot | null;
	private readonly getDomainMeta: (domainId: string) => DomainMeta | null;
	private readonly hasLinkEdge: (srcDomainId: string, dstDomainId: string) => boolean;
	private readonly adminDomainIdGetter: () => string | null;
	private readonly reachGetter: GatewayBridgeParams["reach"];
	private readonly seenRegisterNonces = new Map<string, number>();
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
		for (const pending of this.pendingValues.values()) {
			for (const waiter of pending) {
				clearTimeout(waiter.timer);
				waiter.resolve({ outcome: "timeout" });
			}
		}
		this.pendingValues.clear();
		this.handshakeAttempts.clear();
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
		if (this.frameHandlers.has(name) || BUILT_IN_FRAMES.has(name))
			throw new Error(`gateway frame "${name}" already registered`);
		this.frameHandlers.set(name, handler);
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
		for (const [relayId, pending] of this.pendingRelays) {
			if (pending.dstDomainId !== domainId) continue;
			clearTimeout(pending.timer);
			this.pendingRelays.delete(relayId);
			pending.resolve({ relayId, ok: false, error: reason });
		}
	}

	public async handleCall(connId: ConnectionId, name: string, params: Record<string, unknown>): Promise<unknown> {
		if (name === "gateway_register") return this.handleGatewayRegister(connId, params);
		if (
			[
				"inbox_append",
				"inbox_ack",
				"session_upsert",
				"session_forget",
				"blob_fetch",
				"blob_fetch_reply",
				"blob_begin",
				"blob_chunk",
				"value_result",
			].includes(name)
		) {
			const reg = this.connGateways.get(connId);
			const incarnation = typeof params.incarnation === "number" ? params.incarnation : null;
			if (!reg?.signPub || reg.incarnation === null) return { ok: false, error: "inbox_unavailable" };
			if (incarnation !== reg.incarnation) {
				console.warn(`[BridgeServer] stale gateway incarnation for ${name}`);
				return { ok: false, error: "stale_incarnation" };
			}
			if (name === "inbox_append") return this.handleInboxAppend(connId, params);
			if (name === "inbox_ack") return this.handleInboxAck(connId, params);
			if (name === "session_upsert") return this.handleSessionUpsert(connId, params);
			if (name === "session_forget") return this.handleSessionForget(connId, params);
			if (name === "blob_fetch") return this.handleBlobFetch(connId, params);
			if (name === "blob_begin" || name === "blob_chunk") return this.handleBlobUpload(connId, name, params);
			if (name === "value_result") return this.handleValueResult(connId, params);
			return this.handleBlobFetchReply(connId, params);
		}
		const frameHandler = this.frameHandlers.get(name);
		if (frameHandler) {
			const reg = this.connGateways.get(connId);
			if (!reg?.signPub || reg.incarnation === null) return { ok: false, error: "inbox_unavailable" };
			if (params.incarnation !== reg.incarnation) {
				console.warn(`[BridgeServer] stale gateway incarnation for ${name}`);
				return { ok: false, error: "stale_incarnation" };
			}
			if (
				readRouterMigrationWindow().fenced &&
				name === "board_op" &&
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
		for (const [key, pending] of this.pendingValues) {
			const remaining = pending.filter((waiter) => waiter.connId !== connId);
			if (remaining.length === pending.length) continue;
			for (const waiter of pending) {
				if (waiter.connId !== connId) continue;
				clearTimeout(waiter.timer);
				waiter.resolve({ outcome: "unreachable" });
			}
			if (remaining.length) this.pendingValues.set(key, remaining);
			else this.pendingValues.delete(key);
		}
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
		if (reg && wasCurrent) {
			if (reg.signPub && reg.incarnation !== null) {
				const dropped = {
					domainId: reg.domainId,
					gatewayId: reg.gatewayId,
					signPub: reg.signPub,
					incarnation: reg.incarnation,
				};
				for (const listener of this.droppedListeners) listener(dropped);
			}
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

	private handleGatewayRegister(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = GatewayRegisterParamsSchema.safeParse(params);
		if (!parsed.success)
			return { ok: false, error: `invalid gateway_register: ${parsed.error.issues[0]?.message}` };
		const { gatewayId, protocolVersion } = parsed.data;
		const domainId = sanitizeDomainId(parsed.data.domainId);
		if (protocolVersion < FEDERATION_PROTOCOL_FLOOR) {
			return { ok: false, error: "version_too_old", floor: FEDERATION_PROTOCOL_FLOOR };
		}
		const meta = this.getDomainMeta(domainId);
		if (meta?.status === "pending") {
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
				const denied = verifyRegistrationClaim(
					parsed.data,
					{ ownerSignPub: domain.ownerSignPub, revocations: domain.revocations },
					this.now(),
				);
				if (denied) {
					console.warn(`[BridgeServer] rejected registration for "${domainId}/${gatewayId}": ${denied}`);
					return { ok: false, error: `registration_denied: ${denied}` };
				}
				if (!this.rememberRegisterNonce(parsed.data.proofNonce)) {
					console.warn(`[BridgeServer] rejected replayed registration proof for "${domainId}/${gatewayId}"`);
					return { ok: false, error: `registration_denied: registration proof replayed` };
				}
			} else if (domainId !== this.adminDomain()) {
				// Do not disclose unadmitted Domain state.
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
		this.migrationLease?.(domainId, gatewayId);
		// Only admitted identities receive inbox incarnations.
		const admitted = !!parsed.data.signPub;
		const incarnation = !admitted ? null : this.inbox ? this.inbox.registerGateway(domainId, gatewayId) : 1;
		if (admitted && incarnation === null)
			console.warn(`[BridgeServer] inbox unavailable for ${domainId}/${gatewayId}; registered without it`);
		this.connGateways.set(connId, {
			domainId,
			gatewayId,
			signPub: parsed.data.signPub ?? null,
			incarnation,
			protocolVersion,
		});
		console.log(`[BridgeServer] Gateway registered: ${domainId}/${gatewayId} (v${protocolVersion})`);
		const peers = [...this.domainMap(domainId).keys()].filter((h) => h !== gatewayId);
		const reply: Record<string, unknown> = {
			ok: true,
			protocolFloor: FEDERATION_PROTOCOL_FLOOR,
			protocolVersion: FEDERATION_PROTOCOL_VERSION,
			opLedgerProtocol: OP_LEDGER_PROTOCOL,
			domainId,
			gateways: peers,
			...(incarnation !== null ? { incarnation } : {}),
		};
		if (domain) reply.domain = domain;
		if (this.migrationFenced?.(domainId, gatewayId)) reply.migrationFenced = true;
		if (meta) {
			reply.domainStatus = meta.status;
			if (meta.displayName != null) reply.displayName = meta.displayName;
		}
		reply.isAdminDomain = domainId === this.adminDomain();
		// Preserve cached reach when available.
		const reach = this.reachGetter?.();
		if (reach && (reach.publicHost || reach.lanAddresses?.length)) reply.reach = reach;
		if (incarnation !== null) {
			this.pushRegisteredRows(domainId, gatewayId, incarnation);
			const registered = { domainId, gatewayId, signPub: parsed.data.signPub as string, incarnation };
			for (const listener of this.registeredListeners) listener(registered);
		}
		return reply;
	}

	private handleInboxAppend(connId: ConnectionId, params: Record<string, unknown>): unknown {
		if (!this.inbox) return { ok: false, error: "inbox unavailable" };
		const parsed = InboxAppendParamsSchema.safeParse(params);
		const reg = this.connGateways.get(connId);
		const address = parsed.success ? parseInboxAddress(parsed.data.address) : null;
		const row = parsed.success ? InboxRowInputSchema.safeParse(parsed.data.row) : null;
		if (!reg || !parsed.success || !address || !row?.success) return { ok: false, error: "invalid inbox_append" };
		// Migration-fenced gateways must reconcile before writing.
		if (this.migrationFenced?.(reg.domainId, reg.gatewayId)) return { ok: false, error: "migrating" };
		const origin = row.data.envelope.origin;
		// Linked peers reach registered sessions only.
		const allowedDomain =
			address.domainId === reg.domainId ||
			(origin.kind === "gateway" &&
				row.data.envelope.epoch === "peer" &&
				address.kind === "session" &&
				this.hasLinkEdge(reg.domainId, address.domainId) &&
				this.inbox.hasSession(address.domainId, address.gatewayId, address.sessionId));
		const addressOwned =
			address.kind === "owner" || address.domainId !== reg.domainId || address.gatewayId === reg.gatewayId;
		const originAllowed =
			origin.domainId === reg.domainId &&
			origin.gatewayId === reg.gatewayId &&
			(origin.kind === "gateway" ||
				(origin.kind === "session" &&
					!!origin.sessionId &&
					this.inbox.hasSession(reg.domainId, reg.gatewayId, origin.sessionId)));
		if (!allowedDomain || !addressOwned || !originAllowed || !reg.signPub) return { ok: false, error: "refused" };
		// Share state authorizes friend rows and supplies generation.
		let shareGeneration: number | undefined;
		if (address.domainId !== reg.domainId && this.peerRowGate) {
			const target = sessionTargetOf(address);
			const generation = target ? this.peerRowGate(address.domainId, target, reg.domainId) : null;
			if (generation === null) return { ok: false, error: "refused" };
			shareGeneration = generation;
		}
		// Hash only the row's operation key.
		const hash = ProducerOpHashSchema.safeParse((parsed.data.opKey as { hash?: unknown })?.hash);
		const result = this.inbox.appendRow({
			address,
			row: row.data,
			producerSignPub: reg.signPub,
			shareGeneration,
			...(hash.success ? { opKey: { ...row.data.envelope.opKey, hash: hash.data } } : {}),
		});
		if (result.row && !this.pushRow(address, result.row)) this.inbox.markWaking(address.domainId, result.opKey);
		return result;
	}

	public setPeerRowGate(gate: PeerRowGate): void {
		this.peerRowGate = gate;
	}

	private ownerRowPush: ((domainId: string, row: InboxRow) => void) | null = null;

	/** Owner rows a gateway appends reach the bound console sockets through this. */
	public setOwnerRowPush(push: (domainId: string, row: InboxRow) => void): void {
		this.ownerRowPush = push;
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

	private handleInboxAck(connId: ConnectionId, params: Record<string, unknown>): unknown {
		if (!this.inbox) return { ok: false, error: "inbox unavailable" };
		const parsed = InboxAckParamsSchema.safeParse(params);
		const reg = this.connGateways.get(connId);
		const address = parsed.success ? parseInboxAddress(parsed.data.address) : null;
		if (!reg || reg.incarnation === null || !parsed.success || !address)
			return { ok: false, error: "invalid inbox_ack" };
		return this.inbox.ack({
			address,
			seq: parsed.data.seq,
			deliveryEpoch: parsed.data.deliveryEpoch,
			outcome: parsed.data.outcome,
			reason: parsed.data.reason,
			by: { domainId: reg.domainId, gatewayId: reg.gatewayId, incarnation: reg.incarnation },
		});
	}

	private handleSessionUpsert(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = SessionUpsertParamsSchema.safeParse(params);
		const reg = this.connGateways.get(connId);
		if (!reg || !parsed.success) return { ok: false, error: "invalid session_upsert" };
		this.inbox?.upsertSession(reg.domainId, reg.gatewayId, parsed.data.sessionId, parsed.data);
		return { ok: true };
	}

	private handleSessionForget(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = SessionForgetParamsSchema.safeParse(params);
		const reg = this.connGateways.get(connId);
		if (!reg || !parsed.success) return { ok: false, error: "invalid session_forget" };
		this.inbox?.forgetSession(reg.domainId, reg.gatewayId, parsed.data.sessionId);
		if (reg.signPub && reg.incarnation !== null) {
			const identity = {
				domainId: reg.domainId,
				gatewayId: reg.gatewayId,
				signPub: reg.signPub,
				incarnation: reg.incarnation,
			};
			for (const listener of this.sessionForgottenListeners) listener(identity, parsed.data.sessionId);
		}
		return { ok: true };
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
		const admitted = this.getDomain(domainId)?.admissions.some(
			(entry) => entry.admission.kind === "gateway" && entry.admission.gatewayId === params.gatewayId,
		);
		if (!admitted) return Promise.resolve({ outcome: "unreachable" });
		const connId = this.gatewayConnections.get(domainId)?.get(params.gatewayId);
		const reg = connId ? this.connGateways.get(connId) : undefined;
		const ws = connId ? this.transport?.getConnection(connId) : null;
		if (reg && (reg.protocolVersion ?? 0) < FEDERATION_VALUE_PROTOCOL_VERSION) {
			// Remove-by: every registered gateway reports protocol 2.
			return Promise.resolve({ outcome: "unsupported" });
		}
		if (!connId || !reg || reg.incarnation === null || !ws) return Promise.resolve({ outcome: "unreachable" });
		const key = `${domainId}/${params.gatewayId}/${params.conversationId}/${params.opId}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const waiters = this.pendingValues.get(key) ?? [];
				const remaining = waiters.filter((waiter) => waiter.resolve !== resolve);
				if (remaining.length) this.pendingValues.set(key, remaining);
				else this.pendingValues.delete(key);
				resolve({ outcome: "timeout" });
			}, GATEWAY_RELAY_TIMEOUT_MS);
			this.pendingValues.set(key, [...(this.pendingValues.get(key) ?? []), { resolve, timer, connId }]);
			try {
				ws.send(JSON.stringify({ type: "value_op", ...params, incarnation: reg.incarnation }));
			} catch {
				clearTimeout(timer);
				const waiters = this.pendingValues.get(key) ?? [];
				const remaining = waiters.filter((waiter) => waiter.resolve !== resolve);
				if (remaining.length) this.pendingValues.set(key, remaining);
				else this.pendingValues.delete(key);
				resolve({ outcome: "unreachable" });
			}
		});
	}

	private handleValueResult(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = ValueResultParamsSchema.safeParse(params);
		const reg = this.connGateways.get(connId);
		if (!parsed.success) return { settled: false, reason: "malformed" };
		if (!reg || reg.incarnation !== parsed.data.incarnation) return { settled: false, reason: "stale_incarnation" };
		const key = `${reg.domainId}/${reg.gatewayId}/${parsed.data.conversationId}/${parsed.data.opId}`;
		const pending = this.pendingValues.get(key);
		if (!pending || pending.every((waiter) => waiter.connId !== connId))
			return { settled: false, reason: "no_waiter" };
		for (const waiter of pending) clearTimeout(waiter.timer);
		this.pendingValues.delete(key);
		for (const waiter of pending) waiter.resolve(parsed.data.result);
		return { settled: true };
	}

	private async handleBlobFetch(connId: ConnectionId, params: Record<string, unknown>): Promise<unknown> {
		const parsed = BlobFetchParamsSchema.safeParse(params);
		const reg = this.connGateways.get(connId);
		if (!reg || !parsed.success || !this.blobFetch) return { ok: false, error: "invalid blob_fetch" };
		const origin = parsed.data.origin;
		if (origin && origin.domainId !== reg.domainId && !this.hasLinkEdge(reg.domainId, origin.domainId))
			return { outcome: "unreachable" };
		return this.blobFetch.fetch(reg.domainId, parsed.data);
	}

	private handleBlobUpload(connId: ConnectionId, name: string, params: Record<string, unknown>): unknown {
		const reg = this.connGateways.get(connId);
		if (!reg) return { ok: false, error: "invalid blob upload" };
		if (name === "blob_begin") {
			const parsed = BlobBeginParamsSchema.safeParse(params);
			if (!parsed.success) return { ok: false, error: "invalid blob_begin" };
			const value = parsed.data;
			if (value.store === "cache") {
				if (!this.blobCache) return { ok: false, error: "blob cache unavailable" };
				return this.blobCache.begin(
					reg.domainId,
					value.blobId,
					{ domainId: reg.domainId, gatewayId: reg.gatewayId },
					value.size,
					value.ciphertextSize,
					value.ciphertextDigest,
					value.epoch,
				);
			}
			if (!this.referenceHeld || !value.ref) return { ok: false, error: "held blob requires a reference" };
			const ref = parseBlobReference(value.ref.id);
			if (!ref || ref.kind !== value.ref.kind) return { ok: false, error: "reference missing" };
			let referenceExists = false;
			try {
				referenceExists = this.referenceHeld.hasReference(reg.domainId, ref);
			} catch (error) {
				if (error instanceof OwnerQuarantined)
					return { ok: false, error: "refused", reason: "durability_uncertain" };
				throw error;
			}
			if (!referenceExists) return { ok: false, error: "reference missing" };
			const begun = this.referenceHeld.begin(
				reg.domainId,
				value.blobId,
				value.size,
				value.ciphertextSize,
				value.ciphertextDigest,
				value.epoch,
			);
			if (begun.kind !== "quota") this.referenceHeld.applyRefs(reg.domainId, [{ ref, blobIds: [value.blobId] }]);
			return begun;
		}
		const parsed = BlobChunkParamsSchema.safeParse(params);
		if (!parsed.success) return { ok: false, error: "invalid blob_chunk" };
		const value = parsed.data;
		const bytes = Buffer.from(value.bytes, "base64");
		const renewed =
			value.store === "cache" ? this.blobCache?.renew(reg.domainId, value.blobId, value.lease.id) : null;
		if (value.store === "cache" && (!renewed || renewed.kind === "lease_expired"))
			return { ok: false, error: "lease_expired" };
		return value.store === "cache"
			? (this.blobCache?.commitChunk(
					reg.domainId,
					value.blobId,
					value.lease,
					value.offset,
					bytes,
					value.final,
				) ?? { ok: false, error: "blob cache unavailable" })
			: (this.referenceHeld?.commitChunk(
					reg.domainId,
					value.blobId,
					value.lease,
					value.offset,
					bytes,
					value.final,
				) ?? { ok: false, error: "held blob store unavailable" });
	}

	private handleBlobFetchReply(connId: ConnectionId, params: Record<string, unknown>): unknown {
		const parsed = BlobFetchReplyParamsSchema.safeParse(params);
		return parsed.success && this.blobFetch?.settle(connId, parsed.data) ? { ok: true } : { ok: false };
	}

	private pushRow(address: InboxAddress, row: InboxRow): boolean {
		if (address.kind === "owner") {
			// Bound console sockets get the row now; the cursor covers the rest.
			this.ownerRowPush?.(address.domainId, row);
			return true;
		}
		const connId = this.gatewayConnections.get(address.domainId)?.get(address.gatewayId);
		const reg = connId ? this.connGateways.get(connId) : undefined;
		if (!reg || reg.incarnation === null) return false;
		return this.pushToGatewayInDomain(address.domainId, address.gatewayId, {
			type: "inbox_deliver",
			address: formatInboxAddress(address),
			rows: [row],
			incarnation: reg.incarnation,
			deliveryEpoch: this.inbox?.deliveryEpoch(address) ?? 1,
		});
	}

	/** Redeliver held rows under current incarnation. */
	private pushRegisteredRows(domainId: string, gatewayId: string, incarnation: number): void {
		const inbox = this.inbox;
		if (!inbox) return;
		setTimeout(() => {
			const connId = this.gatewayConnections.get(domainId)?.get(gatewayId);
			if (!connId || this.connGateways.get(connId)?.incarnation !== incarnation) return;
			let pending: ReturnType<InboxService["pendingFor"]>;
			try {
				pending = inbox.pendingFor(domainId, gatewayId);
			} catch (err) {
				console.warn(
					`[BridgeServer] re-delivery skipped for ${domainId}/${gatewayId}: ${(err as Error).message}`,
				);
				return;
			}
			for (const entry of pending) {
				const address = parseInboxAddress(entry.address);
				if (!address) continue;
				this.pushToGatewayInDomain(domainId, gatewayId, {
					type: "inbox_deliver",
					address: entry.address,
					rows: entry.rows,
					incarnation,
					deliveryEpoch: inbox.deliveryEpoch(address),
				});
			}
		}, 0);
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
		const now = this.now();
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
			const foreign = this.resolveForeignGateway(senderDomainId, dstGateway);
			if (foreign === "ambiguous") {
				return Promise.resolve({
					relayId,
					ok: false,
					error: `gateway "${dstGateway}" is ambiguous across Domains`,
				});
			}
			// Link edges authorize cross-Domain relays.
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
		const now = this.now();
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
