import type { BoardReply } from "../shared/board-structure.js";
import type { HostSpawnState } from "../shared/host-spawn.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import type { GatewayConfig, ResponsePayload, RidingAwareness, TeamInfo } from "../shared/types.js";
import type { ChannelDeliveryCoordinator } from "./channelDelivery.js";
import type { DurableOpStore } from "./console/durableOpStore.js";
import { createAddressing } from "./routes/addressing.js";
import { createCallerGuards } from "./routes/callerGuards.js";
import { createRelay } from "./routes/relay.js";
import { createBlobRoutes } from "./routes/routesBlob.js";
import { createBoardRoutes } from "./routes/routesBoard.js";
import { createCapabilityRoutes } from "./routes/routesCapabilities.js";
import { createFederationPresenceRoutes } from "./routes/routesFederationPresence.js";
import { createHumanNotifyRoutes } from "./routes/routesHumanNotify.js";
import { createPresenceRoutes } from "./routes/routesPresence.js";
import { createRespondRoutes } from "./routes/routesRespond.js";
import { createSendRoutes } from "./routes/routesSend.js";
import { createStatusRoutes } from "./routes/routesStatus.js";
import type { Presented, SessionAuthority } from "./sessionAuthority.js";
import type { WakeResult } from "./wake.js";
import type { ConversationRegistry, HandshakeRepushOutcome, TeamRegistry } from "./websocket.js";

export interface RoutesDeps {
	dataDir: string;
	now?: () => number;
	newId?: () => string;
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: PendingJobStore<ResponsePayload>;
	tryWakeTeam: (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => Promise<WakeResult>;
	// Session records support live-incarnation resolution. Optional in test harnesses.
	sessionStore?: import("../shared/session-store.js").SessionStore;
	capabilityStore?: Pick<import("./console/capabilityStore.js").CapabilityStore, "snapshot">;
	daemonCapabilityStore?: Pick<import("./daemonCapabilities.js").DaemonCapabilityStore, "snapshot">;
	// teams() delegates to this snapshot. Optional in test harnesses.
	presence?: { snapshot(): TeamInfo[] };
	// Live daemon catalog state. `known` distinguishes no reply from an empty catalog.
	hostSpawnPoints?: HostSpawnState;
	config: GatewayConfig;
	producerSignPriv?: string;
	routerClient?: import("./router/routerClient.js").RouterClient | null;
	/** The Router leaf fingerprint this Gateway pins; health reports it for the verify gate. */
	routerCertFp?: string;
	// E2E seal/open for cross-Gateway frames; absent when federation crypto is off.
	sealer?: import("./federation/sealer.js").Sealer | null;
	/** This Gateway's byte store, for pulling in a blob a peer Gateway holds. Absent in tests that
	 * never move bytes, which makes a cross-Gateway fetch a clean refusal rather than a crash. */
	blobStore?: import("../shared/blob-store.js").BlobStore;
	blobUploader?: ReturnType<typeof import("./router/blobUploader.js").createBlobUploader>;
	contentKeyStore?: Pick<import("./federation/contentKeyStore.js").ContentKeyStore, "keyFor" | "seal">;
	ownerSignPub?: (() => string | null) | null;
	// The disjoint cross-Domain peer set. A cross-Domain send resolves its target's Domain.
	crossDomainPeers?: import("./federation/crossDomainPeers.js").CrossDomainPeers | null;
	// Whether a gateway id resolves to a LOCAL (single-owner allowlist) peer. Mirrors the.
	resolvesLocalGateway?: ((gatewayId: string) => boolean) | null;
	// Refresh the share lastSeenAt for a live local session (its canonical domain.gateway.spawn.session),.
	touchShares?: ((sessionTarget: string) => void) | null;
	// Whether a local session (canonical domain.gateway.spawn.session) is still shared to a friend Domain,.
	isSharedToForReply?: ((sessionTarget: string, domainId: string) => boolean) | null;
	// The session targets currently shared to a friend Domain (the same slimmed discovery filter.
	sharesFor?: ((domainId: string) => string[]) | null;
	// The cross-Domain-presence landing store (gateway/federation/crossDomainPresence.ts) -.
	crossDomainPresenceConsumer?:
		| import("./federation/crossDomainPresenceConsumer.js").CrossDomainPresenceConsumer
		| null;
	resolveHandshake?: (
		sessionId: string,
		replyAsJson?: Record<string, unknown>,
		response?: string,
		responderToken?: Presented,
	) => boolean;
	// The pending hs-* id owed by a (team, subId), if any - lets respond() name the exact handshake.
	findPendingHandshake?: (team: string, subId: string) => string | undefined;
	// Re-sends a (team, subId)'s still-pending handshake so a caller that lost the original.
	repushHandshake?: (team: string, subId: string) => HandshakeRepushOutcome;
	// This Gateway's own Domain owner id (a hash of the owner's signing key), used to key the.
	ownerId?: (() => string | null) | null;
	// The sole resolver of "what must a caller prove to act as X". Absent in test harnesses that do.
	auth?: SessionAuthority;
	// Router-held owner board. Unavailable before enrollment.
	boardClient?: ReturnType<typeof import("./router/boardClient.js").createBoardClient>;
	// Restart-proof replay for the board's ABSOLUTE writes. Absent only in tests, which then fall.
	boardReplays?: DurableOpStore<BoardReply>;
	// State that must survive a rebuild (see RoutesCarryOver). Absent in test harnesses, which build.
	carryOver?: RoutesCarryOver;
	awareness?: { takeFor(sessionKey: string): RidingAwareness | null };
	// Holds a channel message for a session that could not take it, and hands it over when the.
	deliveries?: ChannelDeliveryCoordinator;
}

/**
 * The state a routes rebuild must NOT restart from empty.
 *
 * `createRoutes` runs again when federation activates mid-session, so anything it allocates per call
 * is discarded at that moment. Owned by the caller and passed back in, which is what makes the
 * survival a property of the wiring rather than of nobody having rebuilt yet.
 *
 * Only entries whose loss changes BEHAVIOUR belong here. A burst cache does not: rebuilding it costs
 * one recomputation and can report nothing stale.
 */
export interface RoutesCarryOver {
	/** Settled replies for the board route's mutating operations. Losing this turns a retried
	 * absolute write into a second write rather than a replay. */
	boardOperationReplies: Map<string, Record<string, unknown>>;
	/** In-flight cross-Gateway blob fetches. Losing this un-coalesces the fetches already running,
	 * so the same bytes are pulled twice. */
	blobFetches: Map<string, Promise<import("./blobOps.js").BlobFetchOutcome>>;
}

export function createRoutesCarryOver(): RoutesCarryOver {
	return { boardOperationReplies: new Map(), blobFetches: new Map() };
}

export function createRoutes(deps: RoutesDeps) {
	const { config, store, auth, carryOver = createRoutesCarryOver(), now = () => Date.now() } = deps;

	const { localDomain, localAddress, consoleSelfAddress, tryLocalAddress, resolveLocalTarget } = createAddressing({
		config,
	});
	const { provedLocalSession, refuseImpersonation, refuseForeignReply, refuseForeignPoll } = createCallerGuards({
		auth,
		store,
	});
	const { targetDomainId, relayToGateway, relayWithRetry } = createRelay({
		config,
		localDomain,
		producerSignPriv: deps.producerSignPriv,
		routerClient: deps.routerClient,
		sealer: deps.sealer,
		blobUploader: deps.blobUploader,
		crossDomainPeers: deps.crossDomainPeers,
		resolvesLocalGateway: deps.resolvesLocalGateway,
	});

	// Before send and respond: both push through its mirrorPeer and deliverToOwner.
	const consolePush = createHumanNotifyRoutes({
		dataDir: deps.dataDir,
		config,
		now,
		newId: deps.newId,
		ownerId: deps.ownerId,
		ownerSignPub: deps.ownerSignPub,
		producerSignPriv: deps.producerSignPriv,
		routerClient: deps.routerClient,
		contentKeyStore: deps.contentKeyStore,
		blobUploader: deps.blobUploader,
		localAddress,
		refuseImpersonation,
	});
	const { mirrorPeer, humanNotify, pluginAction, deliverToOwner } = consolePush;

	const { fetchBlobFromGateway } = createBlobRoutes({
		config,
		blobStore: deps.blobStore,
		crossDomainPeers: deps.crossDomainPeers,
		contentKeyStore: deps.contentKeyStore,
		ownerSignPub: deps.ownerSignPub,
		routerClient: deps.routerClient,
		relayToGateway,
		inFlight: carryOver.blobFetches,
	});
	const {
		presenceForDomain,
		pushPresenceToDomain,
		pullPresenceFromDomain,
		landCrossDomainPresence,
		invalidatePresenceSnapshotCache,
	} = createFederationPresenceRoutes({
		presence: deps.presence,
		sharesFor: deps.sharesFor,
		crossDomainPeers: deps.crossDomainPeers,
		crossDomainPresenceConsumer: deps.crossDomainPresenceConsumer,
		tryLocalAddress,
		relayToGateway,
	});

	const { pending, teams, health } = createStatusRoutes({
		config,
		registry: deps.registry,
		store,
		routerClient: deps.routerClient,
		routerCertFp: deps.routerCertFp,
		presence: deps.presence,
		sessionStore: deps.sessionStore,
		touchShares: deps.touchShares,
		tryLocalAddress,
		provedLocalSession,
	});
	const { capabilities } = createCapabilityRoutes({
		capabilityStore: deps.capabilityStore,
		daemonCapabilityStore: deps.daemonCapabilityStore,
		routerClient: deps.routerClient,
	});
	const { localSpawnPoints, discoverFull, discover } = createPresenceRoutes({
		config,
		localDomain,
		hostSpawnPoints: deps.hostSpawnPoints,
		routerClient: deps.routerClient,
		teams,
	});
	const { send } = createSendRoutes({
		config,
		localDomain,
		now,
		registry: deps.registry,
		conversationRegistry: deps.conversationRegistry,
		store,
		tryWakeTeam: deps.tryWakeTeam,
		sessionStore: deps.sessionStore,
		routerClient: deps.routerClient,
		repushHandshake: deps.repushHandshake,
		auth,
		awareness: deps.awareness,
		deliveries: deps.deliveries,
		localAddress,
		consoleSelfAddress,
		tryLocalAddress,
		resolveLocalTarget,
		targetDomainId,
		relayToGateway,
		mirrorPeer,
		refuseImpersonation,
		provedLocalSession,
	});
	const { respond, poll } = createRespondRoutes({
		config,
		localDomain,
		registry: deps.registry,
		conversationRegistry: deps.conversationRegistry,
		store,
		resolveHandshake: deps.resolveHandshake,
		findPendingHandshake: deps.findPendingHandshake,
		repushHandshake: deps.repushHandshake,
		isSharedToForReply: deps.isSharedToForReply,
		ownerId: deps.ownerId,
		tryLocalAddress,
		relayWithRetry,
		mirrorPeer,
		deliverToOwner,
		refuseForeignReply,
		refuseForeignPoll,
		provedLocalSession,
	});
	const { taskBoard } = createBoardRoutes({
		auth,
		boardClient: deps.boardClient,
		boardReplays: deps.boardReplays,
		boardOperationReplies: carryOver.boardOperationReplies,
		refuseImpersonation,
	});

	return {
		pending,
		capabilities,
		teams,
		discover,
		discoverFull,
		localSpawnPoints,
		send,
		respond,
		poll,
		fetchBlobFromGateway,
		health,
		humanNotify,
		deliverToOwner,
		pluginAction,
		taskBoard,
		presenceForDomain,
		landCrossDomainPresence,
		pushPresenceToDomain,
		pullPresenceFromDomain,
		invalidatePresenceSnapshotCache,
		stop: consolePush.stop,
	};
}
