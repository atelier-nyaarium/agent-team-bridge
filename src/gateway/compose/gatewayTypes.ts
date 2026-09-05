// The gateway graph's public surface: what the adapter passes in, what it gets back, and the
// fault port the harness and the boot smoke drive it through.

import type { Ambient } from "../../shared/ambient.js";
import type { SealedEnvelope } from "../../shared/crypto.js";
import type { RowEnvelope } from "../../shared/schemasInbox.js";
import type { SessionRecord } from "../../shared/session-store.js";
import type { RouterToolCallResult } from "../router/routerClient.js";
import type { createWebSocketHandlers } from "../websocket.js";

/** Resolved once by the adapter. */
export interface GatewayConfig {
	dataDir: string;
	federationDir: string;
	logDir: string;
	gatewayId: string;
	maxBlobStoreBytes: number;
	wakeTimeoutMs: number;
	enrollTlsPort: number;
	enrollLanHost: string;
	enrollNonce?: string;
	hostWsToken?: string;
	/** Null dials the transport's Router. */
	routerBootstrapUrl: string | null;
}

export interface EnrollTlsListener {
	stop(force?: boolean): void;
}

export type OpenEnrollTls = (opts: {
	port: number;
	certPem: string;
	keyPem: string;
	fetch: (req: Request) => Promise<Response>;
}) => EnrollTlsListener;

export interface GatewayDeps {
	config: GatewayConfig;
	/** The clock, the entropy, the ids, and the timers this graph runs on. */
	ambient: Ambient;
	/** Absent means no LAN delivery. */
	openEnrollTls?: OpenEnrollTls;
	/** Only test processes hold the committed fixture keys. */
	allowFixtureIdentity?: boolean;
}

export interface PeerAddress {
	domainId: string;
	gatewayId: string;
}

/** The only way in for a test that must break or inspect the running gateway. */
export interface GatewayFaultPort {
	/** Cuts the Router link, leaving the rest of the graph running. */
	dropRouterLink(): void;
	routerRegistered(): boolean;
	routerIncarnation(): number | null;
	/** The content-key epochs this gateway holds. */
	heldEpochs(): number[];
	sessionRecord(team: string): SessionRecord | undefined;
	/** Appends a row sealed to `target` and signed by this Gateway, as a rogue peer would. */
	forgePeerRow(target: PeerAddress, address: string, envelope: RowEnvelope, op: unknown): Promise<unknown>;
	/** Seals an op to `target`, for a frame the caller composes itself. */
	sealForPeer(target: PeerAddress, op: unknown): SealedEnvelope;
	/** Sends one wire frame as this Gateway. */
	routerCall(name: string, params: Record<string, unknown>): Promise<RouterToolCallResult>;
	/** Same, with the live incarnation stamped. */
	routerInboxCall(name: string, params: Record<string, unknown>): Promise<RouterToolCallResult>;
}

export interface GatewayGraph {
	router: (req: Request) => Promise<Response>;
	wsHandlers: ReturnType<typeof createWebSocketHandlers>;
	/** Flushes, then stops everything owned. */
	close: () => Promise<void>;
	faults: GatewayFaultPort;
}
