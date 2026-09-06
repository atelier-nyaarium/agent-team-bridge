import type { DomainSnapshot } from "../../shared/admission.js";
import type { Ambient } from "../../shared/ambient.js";
import type { BlobStore } from "../../shared/blob-store.js";
import type { BoardDisposition } from "../../shared/board-authority.js";
import type {
	CrossDomainConfirmResult,
	CrossDomainListenResult,
	CrossDomainListenStateResult,
	CrossDomainListPeersResult,
	CrossDomainListSharesResult,
	CrossDomainRequestResult,
	CrossDomainShareTarget,
	CrossDomainUnlinkResult,
	DiscoverCoverage,
} from "../../shared/console-protocol.js";
import type { SignedXDomainLink } from "../../shared/federation-protocol.js";
import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { MAX_POLL_HOLD_MS } from "../../shared/schemas.js";
import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import type { Runbook } from "../../shared/schemasRunbook.js";
import type { VaultDecision, VaultGrant } from "../../shared/schemasVault.js";
import type { SessionStore } from "../../shared/session-store.js";
import type { GatewaySpawnPoints, TeamInfo } from "../../shared/types.js";
import type { DeliverToOwner } from "../consolePushOps.js";
import type { ShareMirrorOutcome } from "../federation/crossDomainShareState.js";
import type { WakeResult } from "../wake.js";
import type { ConversationRegistry, TeamRegistry } from "../wsTypes.js";
import type { DurableOpStore } from "./durableOpStore.js";

export interface ConsoleRoutes {
	send: (req: Request, body: Record<string, unknown>, opts?: { consoleSender?: boolean }) => Promise<Response>;
	respond: (
		req: Request,
		body: Record<string, unknown>,
		opts?: { consoleSender?: boolean; onFederatedSettled?: (ok: boolean) => void },
	) => Response;
	teams: () => Response;
	discover: (url?: URL) => Promise<Response>;
	// Discovery spans every same-Domain Gateway.
	discoverFull: () => Promise<{
		teams: TeamInfo[];
		coverage: DiscoverCoverage;
		/** Absent means unadvertised, not empty. */
		spawnPoints?: GatewaySpawnPoints[];
	}>;
	// The sole mailbox writer converges delivery across same-Domain Gateways.
	deliverToOwner: DeliverToOwner;
}

export type TrustedCatalogProject = (name: string) => boolean;

export interface SendRouteJson {
	session_id?: string;
	status?: string;
	error?: string;
}

export interface ConsoleHandlerDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	routes: ConsoleRoutes;
	// Session ids use the composite Gateway and name key.
	localGatewayId: string;
	localDomainId: string;
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	sendBoundMs?: number;
	createSessionBoundMs?: number;
	// Catalog projects cannot be claimed by device sessions.
	isTrustedCatalogProject?: TrustedCatalogProject;
	dropSessionResume?: (team: string, boardDisposition: BoardDisposition) => void;
	sessionStore?: Pick<
		SessionStore,
		| "getByTeam"
		| "teamOf"
		| "adoptById"
		| "adoptOrReattach"
		| "mintOrReattach"
		| "hostWorkdirHint"
		| "forget"
		| "rename"
		| "ensureBindToken"
	>;
	// Keyring snapshots send only when the version changes.
	domain?: () => { version: string; snapshot: DomainSnapshot } | null;
	blobStore?: BlobStore;
	fetchBlobFromGateway?: (blobId: string, fromGateway: string) => Promise<import("../blobOps.js").BlobFetchOutcome>;
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
	// Devcontainer creation wakes before host relay.
	tryWakeTeam?: (team: string) => Promise<WakeResult>;
	// Closing a team during wake must refuse.
	isWakeInFlight?: (team: string) => boolean;
	// Host creation remains verifying until MCP registration.
	markCreateInFlight?: (team: string) => () => void;
	awaitRegister?: (team: string) => Promise<WakeResult>;
	crossDomain?: CrossDomainConsoleHandlers;
	crossDomainShare?: CrossDomainShareHandlers;
	unlinkDomain?: (domainId: string) => CrossDomainUnlinkResult;
	untrustOwner?: (ownerSignPub: string) => CrossDomainUnlinkResult;
	durableOpStore?: DurableOpStore;
	vault?: VaultConsoleHandlers;
	runbooks?: RunbookConsoleHandlers;
	onSessionEnded?: (team: string) => void;
}

export interface RunbookConsoleHandlers {
	list: () => { runbooks: Runbook[] };
	put: (runbook: Runbook) => { stored: boolean; revision: number; reason?: string };
	remove: (runbookId: string) => { deleted: boolean };
}

export interface VaultConsoleHandlers {
	answer: (
		requestId: string,
		decision: VaultDecision,
		value?: ContentEnvelope,
		note?: string,
	) => { ok: boolean; reason?: string };
	grants: () => { grants: VaultGrant[] };
	revoke: (grantId: string) => { revoked: boolean };
}

export interface CrossDomainConsoleHandlers {
	listen: () => CrossDomainListenResult;
	request: (args: {
		listeningToken: string;
		pin: string;
		requesterOwnerSignPub: string;
		requesterDomainId: string;
		requesterGatewayId: string;
	}) => Promise<CrossDomainRequestResult>;
	confirm: (args: { pin: string; mySignedLink: SignedXDomainLink }) => CrossDomainConfirmResult;
	cancel: (args: { listeningToken?: string; pin?: string }) => boolean;
	listenState: (listeningToken: string) => CrossDomainListenStateResult;
	listPeers: () => CrossDomainListPeersResult;
}

export interface CrossDomainShareHandlers {
	postRecord: (
		action: "cross_domain_share" | "cross_domain_unshare",
		sessionTarget: string,
		target: CrossDomainShareTarget,
	) => Promise<void>;
	share: (sessionTarget: string, target: CrossDomainShareTarget) => boolean;
	unshare: (sessionTarget: string, target: CrossDomainShareTarget) => ShareMirrorOutcome;
	listShares: () => CrossDomainListSharesResult["shares"];
	// Withdrawals settle jobs so replies stop at the destination.
	expireSessionJobsForTarget: (sessionTarget: string, target: CrossDomainShareTarget) => void;
	// Shares target linked Domains only.
	isLinkedDomain: (domainId: string) => boolean;
}

export function friendlyPeekError(error?: string, kind?: HostOpResult["errorKind"]): string {
	// Absent sessions are transient, but preserve the host cause.
	const raw = error ?? "peek failed";
	if (kind === "absent") return `No session running - it may be starting or has stopped: ${raw}`;
	return raw;
}

// Ambiguous host failures must not roll back a possibly running launch.
export class CreateSessionAmbiguousError extends Error {}

export const FAKE_REQ = new Request("http://gateway/console");

// The Android read timeout must exceed this bound.
export const SEND_BOUND_MS = 25_000;

// The Android retry window must exceed this bound.
export const CREATE_SESSION_BOUND_MS = 25_000;

export const HOLD_CAP_MS = MAX_POLL_HOLD_MS;
