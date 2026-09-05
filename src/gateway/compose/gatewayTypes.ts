import type { Ambient } from "../../shared/ambient.js";
import type { SealedEnvelope } from "../../shared/crypto.js";
import type { RowEnvelope } from "../../shared/schemasInbox.js";
import type { SessionRecord } from "../../shared/session-store.js";
import type { RouterToolCallResult } from "../router/routerClient.js";
import type { createWebSocketHandlers } from "../websocket.js";

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
	ambient: Ambient;
	openEnrollTls?: OpenEnrollTls;
	allowFixtureIdentity?: boolean;
}

export interface PeerAddress {
	domainId: string;
	gatewayId: string;
}

export interface GatewayFaultPort {
	// Faults expose controlled test-only disruption hooks.
	dropRouterLink(): void;
	routerRegistered(): boolean;
	routerIncarnation(): number | null;
	heldEpochs(): number[];
	sessionRecord(team: string): SessionRecord | undefined;
	forgePeerRow(target: PeerAddress, address: string, envelope: RowEnvelope, op: unknown): Promise<unknown>;
	sealForPeer(target: PeerAddress, op: unknown): SealedEnvelope;
	routerCall(name: string, params: Record<string, unknown>): Promise<RouterToolCallResult>;
	routerInboxCall(name: string, params: Record<string, unknown>): Promise<RouterToolCallResult>;
}

export interface GatewayGraph {
	router: (req: Request) => Promise<Response>;
	wsHandlers: ReturnType<typeof createWebSocketHandlers>;
	close: () => Promise<void>;
	faults: GatewayFaultPort;
}
