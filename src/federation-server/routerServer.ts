import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import path from "node:path";
import { WebSocketServer } from "ws";
import { fingerprint } from "../shared/crypto.js";
import type { EnrollOp } from "../shared/federation-lifecycle.js";
import {
	ROSTER_MAX_SKEW_MS,
	type RosterRequest,
	type RosterResult,
	TRANSPORT_MAX_SKEW_MS,
	TRUST_PENDING_MAX_SKEW_MS,
	type TransportRequest,
	type TransportResult,
	type TrustPendingRequest,
	type TrustPendingResult,
	verifyRosterRequest,
	verifyTransportRequest,
	verifyTrustPendingRequest,
} from "../shared/federation-proofs.js";
import { ConsoleSurface, type RouterReachAnswer } from "./consoleSurface.js";
import { DeviceApprovalCoordinator } from "./deviceApprovalCoordinator.js";
import { EnrollHandshakeCoordinator } from "./enrollHandshakeCoordinator.js";
import { dispatchEnrollOp, EnrollmentCoordinator, resolveEnrollRoute } from "./enrollmentCoordinator.js";
import type { FileSecretStore } from "./fileSecretStore.js";
import { GatewayBridge } from "./gatewayBridge.js";
import { WS_MAX_PAYLOAD_BYTES } from "./gatewayTransport.js";
import { PublicApproval } from "./publicApproval.js";
import { buildRoster, type RosterDomain } from "./roster.js";
import { loadRouterTls, type RouterTls } from "./routerTls.js";
import { TenantAdmin } from "./tenantAdmin.js";
import { TrustRendezvousCoordinator } from "./trustRendezvousCoordinator.js";

////////////////////////////////
//  Interfaces & Types

export interface RouterServerParams {
	port: number;
	dataDir: string;
	consoleToken: string;
	federationToken: string;
	store: FileSecretStore;
	tls?: RouterTls;
	/** How a console reaches this Router from either side of a NAT that does not hairpin. Served
	 * by the app-token-gated `reach` op, never by the public /health. */
	reach?: RouterReachAnswer;
}

////////////////////////////////
//  Class

export class RouterServer {
	private server: https.Server | null = null;
	private readonly sockets = new Set<import("ws").WebSocket>();
	private readonly wsServer = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
	private readonly bridge: GatewayBridge;
	private readonly console: ConsoleSurface;
	private readonly approval: PublicApproval;
	private readonly deviceApproval: DeviceApprovalCoordinator;
	private readonly enrollHandshake: EnrollHandshakeCoordinator;
	private readonly trustRendezvous: TrustRendezvousCoordinator;
	private readonly tenantAdmin: TenantAdmin;
	private readonly coordinators = new Map<string, EnrollmentCoordinator>();
	private readonly rosterNonces = new Map<string, number>();
	private readonly transportNonces = new Map<string, number>();
	private readonly trustPendingNonces = new Map<string, number>();
	private readonly tls: RouterTls;

	public constructor(private readonly params: RouterServerParams) {
		this.tls = params.tls ?? loadRouterTls(params.dataDir);
		this.wsServer.on("error", () => {});
		this.deviceApproval = new DeviceApprovalCoordinator();
		this.enrollHandshake = new EnrollHandshakeCoordinator();
		this.trustRendezvous = new TrustRendezvousCoordinator();
		this.tenantAdmin = new TenantAdmin(params.store, () => {
			const id = params.store.adminDomainId();
			return id ? (params.store.loadDomain(id)?.ownerSignPub ?? null) : null;
		});
		this.bridge = new GatewayBridge({
			port: params.port,
			authToken: params.federationToken,
			adminDomainId: () => params.store.adminDomainId(),
			getDomain: (domainId) => this.coordinatorFor(domainId)?.getDomainSnapshot() ?? null,
			getDomainMeta: (domainId) => {
				const coordinator = this.coordinatorFor(domainId);
				return coordinator
					? { status: coordinator.getDomainStatus(), displayName: coordinator.displayName }
					: null;
			},
			hasLinkEdge: (srcDomainId, dstDomainId) =>
				this.coordinatorFor(srcDomainId)?.hasLinkEdge(srcDomainId, dstDomainId) ?? false,
			reach: () => params.reach ?? { publicHost: null, lanAddresses: [] },
		});
		this.console = new ConsoleSurface({
			port: params.port,
			authToken: params.consoleToken,
			ingestFile: path.join(params.dataDir, "console-ingest.jsonl"),
			getBridge: () => this.bridge,
			onFirstRoot: async (op) => {
				const result = await this.tenantAdmin.firstRoot(op);
				if (result.ok) {
					const domainId = op.firstRoot.domainId;
					this.coordinatorFor(domainId);
					this.bridge.broadcastDomainUpdate(domainId);
				}
				return result;
			},
			onEnrollOp: (op) => this.handleEnrollOp(op),
			onEnrollHandshake: (op) => this.enrollHandshake.handle(op),
			onConsoleApproval: (op) => this.deviceApproval.handle(op),
			onTrustHandshake: (op) => this.trustRendezvous.handle(op),
			onTrustPending: (op) => this.handleTrustPending(op),
			onRoster: (req) => this.handleRoster(req),
			onTransport: (req) => this.handleTransport(req),
			onReach: () => params.reach ?? { publicHost: null, lanAddresses: [] },
			onGateways: () => {
				const adminDomainId = params.store.adminDomainId();
				if (!adminDomainId) return { gateways: [] };
				return {
					gateways: this.bridge.registeredGateways(adminDomainId).map((g) => ({
						gatewayId: g.gatewayId,
						signFp: g.signPub ? fingerprint(g.signPub) : null,
					})),
				};
			},
		});
		this.bridge.setConsoleRelaySettler((opId, reply) => this.console.settleConsoleRelay(opId, reply));
		this.approval = new PublicApproval({ port: params.port, onApproval: (op) => this.deviceApproval.handle(op) });
	}

	public async start(): Promise<void> {
		this.bridge.attach();
		const transport = this.bridge.transportAdapter;
		if (!transport) throw new Error("gateway transport unavailable");
		this.server = https.createServer({ cert: this.tls.certPem, key: this.tls.keyPem }, (request, response) => {
			void this.serve(request, response);
		});
		this.server.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "localhost"}`);
			if (url.pathname !== "/" && url.pathname !== "/gateway") {
				socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			if (!transport.authorizeUpgrade(request.headers.authorization)) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			this.wsServer.handleUpgrade(request, socket, head, (ws) => {
				this.sockets.add(ws);
				ws.on("error", () => {});
				transport.handleOpen(ws);
				ws.on("message", (data) => transport.handleMessage(ws, data));
				ws.on("close", () => {
					this.sockets.delete(ws);
					transport.handleClose(ws);
				});
			});
		});
		// Permanent listener: a one-shot is spent by the bind and leaves later errors uncaught.
		this.server.on("error", (err) => console.error(`[federation-router] server error: ${err.message}`));
		// A client whose pin does not match aborts DURING the handshake, so it reaches no route and
		// no status code. Without this, a mismatched console is indistinguishable from one that
		// never dialed, which is the same thing twice over on a self-signed leaf.
		this.server.on("tlsClientError", (err, socket) => {
			const peer = (socket as { remoteAddress?: string }).remoteAddress ?? "?";
			console.log(`[federation-router] TLS handshake failed from ${peer}: ${err.message}`);
		});
		this.server.on("clientError", (err, socket) => {
			const peer = (socket as { remoteAddress?: string }).remoteAddress ?? "?";
			console.log(`[federation-router] client error from ${peer}: ${err.message}`);
			socket.destroy();
		});
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(this.params.port, () => {
				const address = this.server?.address();
				const port = typeof address === "object" && address ? address.port : this.params.port;
				console.log(`[federation-router] listening on ${port}`);
				console.log(`[federation-router] TLS fingerprint ${this.tls.certFp}`);
				resolve();
			});
		});
	}

	public get listeningPort(): number | null {
		const address = this.server?.address();
		return typeof address === "object" && address ? address.port : null;
	}

	public async stop(): Promise<void> {
		this.console.stop();
		this.approval.stop();
		this.bridge.stop();
		for (const socket of this.sockets) socket.terminate();
		this.sockets.clear();
		await new Promise<void>((resolve) => this.wsServer.close(() => resolve()));
		const server = this.server;
		this.server = null;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	public get gatewayBridge(): GatewayBridge {
		return this.bridge;
	}

	public get consoleSurface(): ConsoleSurface {
		return this.console;
	}

	// The ONE seam every request passes through. Nothing else may touch ServerResponse, so a
	// handler cannot launch unobserved work: it returns a Response or throws into this catch.
	private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			await this.writeResponse(response, await this.route(request));
		} catch (err) {
			console.error(`[federation-router] request failed: ${(err as Error).message}`);
			try {
				if (!response.headersSent) response.writeHead(500);
				response.end();
			} catch {}
		}
	}

	private async route(request: IncomingMessage): Promise<Response> {
		const answer = await this.resolve(request);
		// Every request, with what it resolved to. The console surface only ever logged its own
		// refusals, so a request turned away by the gate BELOW - or one that never matched a route
		// at all - looked exactly like a console that never dialed.
		const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "localhost"}`);
		if (url.pathname !== "/health") {
			const peer = request.socket.remoteAddress ?? "?";
			console.log(`[federation-router] ${request.method} ${url.pathname} from ${peer} -> ${answer.status}`);
		}
		return answer;
	}

	private async resolve(request: IncomingMessage): Promise<Response> {
		const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "localhost"}`);
		if (url.pathname === "/health" && request.method === "GET") {
			// The fingerprint rides the health answer so clients can confirm the pin they hold
			// without root access to the cert file or a boot line that log rotation discards.
			// `gateways` is the Router's OWN count, which is what makes it worth having: a Gateway
			// reports `router_connected` from its own socket state and reads true across a half-open
			// one, so only the far side can contradict it.
			// The Router's reach (public host, LAN addresses) is deliberately NOT here: this answer is
			// public by necessity, and a LAN address on it tells any scanner this port-forward ends on a
			// home network at a specific private address. It rides the app-token-gated `reach` op on
			// /console instead. No chicken-and-egg: this answer works from whichever address a console
			// can reach, and the token it already holds is what lets it ask for the other one.
			return new Response(
				JSON.stringify({
					ok: true,
					certFingerprint: this.tls.certFp,
					gateways: this.bridge.registeredGatewayCount,
				}),
			);
		}
		const maxBody =
			url.pathname === "/device-approval" || url.pathname.startsWith("/device-approval/")
				? 8 * 1024
				: url.pathname === "/ingest"
					? 512 * 1024
					: ["/relay", "/console"].includes(url.pathname)
						? 67_108_864
						: 0;
		if (["/relay", "/console", "/ingest"].includes(url.pathname) && request.method === "POST") {
			const provided = request.headers["x-console-bridge-token"];
			const token = Array.isArray(provided) ? provided[0] : provided;
			const left = Buffer.from(token ?? "");
			const right = Buffer.from(`Bearer ${this.params.consoleToken}`);
			if (left.length !== right.length || !timingSafeEqual(left, right)) {
				return new Response("Unauthorized", { status: 401 });
			}
		}
		const body = await readBody(request, maxBody);
		if (body.outcome === "too-large") return new Response("Payload Too Large", { status: 413 });
		// An abandoned request has no client left to answer; anything written is discarded.
		if (body.outcome === "aborted") return new Response(null, { status: 499 });
		const headers = new Headers();
		for (const [key, value] of Object.entries(request.headers)) {
			if (typeof value === "string") headers.set(key, value);
		}
		const webRequest = new Request(url, {
			method: request.method,
			headers,
			body: body.bytes.length ? new Uint8Array(body.bytes) : undefined,
		});
		if (url.pathname === "/device-approval" || url.pathname.startsWith("/device-approval/")) {
			return this.approval.handleRequest(webRequest);
		}
		if (["/relay", "/console", "/ingest"].includes(url.pathname)) {
			return this.console.handleRequest(webRequest);
		}
		return new Response("Not Found", { status: 404 });
	}

	private async writeResponse(response: ServerResponse, result: Response): Promise<void> {
		const body = Buffer.from(await result.arrayBuffer());
		response.statusCode = result.status;
		result.headers.forEach((value, key) => {
			response.setHeader(key, value);
		});
		response.end(body);
	}

	private coordinatorFor(domainId: string): EnrollmentCoordinator | null {
		if (!this.params.store.loadDomain(domainId)) return null;
		let coordinator = this.coordinators.get(domainId);
		if (!coordinator) {
			coordinator = new EnrollmentCoordinator(
				this.params.store.persistedIdentity,
				this.params.store.domainStore(domainId),
				domainId,
			);
			this.coordinators.set(domainId, coordinator);
		}
		coordinator.refresh();
		return coordinator;
	}

	private async handleEnrollOp(op: EnrollOp): Promise<{ ok: boolean; error?: string }> {
		const route = resolveEnrollRoute(op, {
			adminDomainId: this.params.store.adminDomainId(),
			rootedDomainFor: (ownerSignPub) =>
				this.params.store.listDomains().find(({ state }) => state.ownerSignPub === ownerSignPub)?.domainId ??
				null,
		});
		if (route.kind === "refused") return { ok: false, error: route.error };
		const domainId = route.kind === "domain" ? route.domainId : this.params.store.adminDomainId();
		if (!domainId) return { ok: false, error: "admin Domain not rooted" };
		const coordinator = this.coordinatorFor(domainId);
		if (!coordinator) return { ok: false, error: "admin Domain unavailable" };
		const result = await dispatchEnrollOp(coordinator, op, this.tenantAdmin);
		if (!result.ok) return result;
		if (op.kind === "submit_admission" || op.kind === "submit_revocation") {
			const failed = await this.flushOrError(domainId);
			if (failed) return failed;
			this.bridge.broadcastDomainUpdate(domainId);
		} else if (op.kind === "submit_xdomain_link" || op.kind === "revoke_xdomain_link") {
			// Link edges gate cross-Domain relay; never ACK before the write lands.
			const failed = await this.flushOrError(domainId);
			if (failed) return failed;
		} else if (op.kind === "set_display_name") {
			this.coordinatorFor(op.rename.rename.domainId);
			this.bridge.broadcastDomainUpdate(op.rename.rename.domainId);
		} else if (op.kind === "remove_tenant" || op.kind === "delete_domain") {
			const removed = op.kind === "remove_tenant" ? op.removal.removal.domainId : op.deletion.deletion.domainId;
			this.coordinators.delete(removed);
			this.bridge.evictDomain(removed, "Domain removed");
		}
		return result;
	}

	private async flushOrError(domainId: string): Promise<{ ok: false; error: string } | null> {
		try {
			await this.params.store.flushDomain(domainId);
			return null;
		} catch (err) {
			return { ok: false, error: `persist failed: ${(err as Error).message}` };
		}
	}

	private handleRoster(req: RosterRequest): RosterResult {
		const opaque: RosterResult = { ok: false, error: "not a member of this network" };
		if (!verifyRosterRequest(req)) return opaque;
		const now = Date.now();
		if (Math.abs(now - req.proofAt) > ROSTER_MAX_SKEW_MS) return opaque;
		for (const [nonce, at] of this.rosterNonces) {
			if (Math.abs(now - at) > ROSTER_MAX_SKEW_MS) this.rosterNonces.delete(nonce);
		}
		if (this.rosterNonces.has(req.nonce)) return opaque;
		this.rosterNonces.set(req.nonce, req.proofAt);
		const domains: RosterDomain[] = this.params.store.listDomains().map(({ domainId, state }) => ({
			domainId,
			ownerSignPub: state.ownerSignPub,
			displayName: state.displayName ?? null,
			admissions: state.admissions,
			revocations: state.revocations,
		}));
		return buildRoster(req.signerSignPub, domains, this.bridge.onlineDomainIds());
	}

	/**
	 * Hand a Gateway what it needs to dial this Router and pin it: the address, the leaf fingerprint,
	 * and the WS bearer. Gated on an owner-signed, fresh, non-replayed proof that the signer roots a
	 * Domain here, the same posture as the roster - this reply carries the bearer, so an unverified
	 * caller getting one would be handing out the key to the gateway plane.
	 *
	 * The address is the PUBLIC host when configured, else the LAN bind. Never the docker alias: that
	 * resolves only in this machine's compose project, and a bundle carrying it strands every other
	 * machine. Whichever it is, it is only the FIRST door - the Gateway re-learns both sides from its
	 * register reply and orders them by the shared reach rule from then on.
	 */
	private handleTransport(req: TransportRequest): TransportResult {
		const opaque: TransportResult = { ok: false, error: "not a member of this network" };
		if (!verifyTransportRequest(req)) return opaque;
		const now = Date.now();
		if (Math.abs(now - req.proofAt) > TRANSPORT_MAX_SKEW_MS) return opaque;
		for (const [nonce, at] of this.transportNonces) {
			if (Math.abs(now - at) > TRANSPORT_MAX_SKEW_MS) this.transportNonces.delete(nonce);
		}
		if (this.transportNonces.has(req.nonce)) return opaque;
		// Only an owner who ROOTS a Domain on this Router may pull it, so a member of someone else's
		// network, or a revoked key, gets the same opaque answer as a bad signature.
		const roots = this.params.store
			.listDomains()
			.some(({ state }) => state.ownerSignPub && state.ownerSignPub === req.signerSignPub);
		if (!roots) return opaque;
		this.transportNonces.set(req.nonce, req.proofAt);

		const reach = this.params.reach;
		const host = reach?.publicHost || reach?.lanAddresses?.[0];
		if (!host) {
			return { ok: false, error: "the Router has no reachable address configured - run ./setup.sh on its host" };
		}
		const port = reach?.publicHost ? (reach.publicPort ?? this.params.port) : this.params.port;
		return {
			ok: true,
			routerUrl: `https://${host}:${port}`,
			routerCertFp: this.tls.certFp,
			bearer: this.params.federationToken,
		};
	}

	// An unverifiable, stale or replayed proof answers empty, never an enumeration.
	private handleTrustPending(req: TrustPendingRequest): TrustPendingResult {
		const opaque: TrustPendingResult = { ok: true, pending: [] };
		if (!verifyTrustPendingRequest(req)) return opaque;
		const now = Date.now();
		if (Math.abs(now - req.proofAt) > TRUST_PENDING_MAX_SKEW_MS) return opaque;
		for (const [nonce, at] of this.trustPendingNonces) {
			if (Math.abs(now - at) > TRUST_PENDING_MAX_SKEW_MS) this.trustPendingNonces.delete(nonce);
		}
		if (this.trustPendingNonces.has(req.nonce)) return opaque;
		this.trustPendingNonces.set(req.nonce, req.proofAt);
		return { ok: true, pending: this.trustRendezvous.pending(req.signerSignPub) };
	}
}

// Three-valued: too-large and aborted are different answers and get different replies.
type BodyResult = { outcome: "ok"; bytes: Buffer } | { outcome: "too-large" } | { outcome: "aborted" };

function readBody(request: IncomingMessage, maxBytes: number): Promise<BodyResult> {
	if (maxBytes === 0) return Promise.resolve({ outcome: "ok", bytes: Buffer.alloc(0) });
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let length = 0;
		request.on("data", (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			length += buffer.length;
			if (length > maxBytes) {
				// Pause rather than drain or destroy: backpressure stops the sender, and the
				// socket stays writable long enough to answer 413.
				resolve({ outcome: "too-large" });
				request.pause();
				return;
			}
			chunks.push(buffer);
		});
		request.on("end", () => resolve({ outcome: "ok", bytes: Buffer.concat(chunks) }));
		request.on("aborted", () => resolve({ outcome: "aborted" }));
		request.on("error", () => resolve({ outcome: "aborted" }));
	});
}
