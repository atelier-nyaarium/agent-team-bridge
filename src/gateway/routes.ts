import type { Ambient } from "../shared/ambient.js";
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
import type { ConversationRegistry, HandshakeRepushOutcome, TeamRegistry } from "./wsTypes.js";

export interface RoutesDeps {
	dataDir: string;
	ambient: Ambient;
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: PendingJobStore<ResponsePayload>;
	tryWakeTeam: (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => Promise<WakeResult>;
	// Resolves a live incarnation.
	sessionStore?: import("../shared/session-store.js").SessionStore;
	capabilityStore?: Pick<import("./console/capabilityStore.js").CapabilityStore, "snapshot">;
	daemonCapabilityStore?: Pick<import("./daemonCapabilities.js").DaemonCapabilityStore, "snapshot">;
	// Backs teams().
	presence?: { snapshot(): TeamInfo[] };
	// `known` separates no reply from an empty catalog.
	hostSpawnPoints?: HostSpawnState;
	config: GatewayConfig;
	producerSignPriv?: string;
	routerClient?: import("./router/routerClient.js").RouterClient | null;
	/** The Router leaf fingerprint this Gateway pins; health reports it for the verify gate. */
	routerCertFp?: string;
	// E2E seal/open for cross-Gateway frames; absent when federation crypto is off.
	sealer?: import("./federation/sealer.js").Sealer | null;
	/** Absent turns a cross-Gateway blob fetch into a refusal. */
	blobStore?: import("../shared/blob-store.js").BlobStore;
	blobUploader?: ReturnType<typeof import("./router/blobUploader.js").createBlobUploader>;
	contentKeyStore?: Pick<import("./federation/contentKeyStore.js").ContentKeyStore, "keyFor" | "seal">;
	ownerSignPub?: (() => string | null) | null;
	// The disjoint cross-Domain peer set. A cross-Domain send resolves its target's Domain.
	crossDomainPeers?: import("./federation/crossDomainPeers.js").CrossDomainPeers | null;
	// Whether a gateway id is a LOCAL (single-owner allowlist) peer.
	resolvesLocalGateway?: ((gatewayId: string) => boolean) | null;
	// Refreshes a live local session's share lastSeenAt.
	touchShares?: ((sessionTarget: string) => void) | null;
	// Whether a local session is still shared to a friend Domain.
	isSharedToForReply?: ((sessionTarget: string, domainId: string) => boolean) | null;
	// The session targets shared to a friend Domain.
	sharesFor?: ((domainId: string) => string[]) | null;
	// Where landed cross-Domain presence goes.
	crossDomainPresenceConsumer?:
		| import("./federation/crossDomainPresenceConsumer.js").CrossDomainPresenceConsumer
		| null;
	resolveHandshake?: (
		sessionId: string,
		replyAsJson?: Record<string, unknown>,
		response?: string,
		responderToken?: Presented,
	) => boolean;
	// The pending hs-* id owed by a (team, subId), if any.
	findPendingHandshake?: (team: string, subId: string) => string | undefined;
	// Re-sends a still-pending handshake.
	repushHandshake?: (team: string, subId: string) => HandshakeRepushOutcome;
	// This Domain's owner id, a hash of the owner's signing key.
	ownerId?: (() => string | null) | null;
	// The sole resolver of what a caller must prove to act as X.
	auth?: SessionAuthority;
	// Router-held owner board. Unavailable before enrollment.
	boardClient?: ReturnType<typeof import("./router/boardClient.js").createBoardClient>;
	// Restart-proof replay for the board's ABSOLUTE writes.
	boardReplays?: DurableOpStore<BoardReply>;
	// State that must survive a rebuild.
	carryOver?: RoutesCarryOver;
	awareness?: { takeFor(sessionKey: string): RidingAwareness | null };
	// Holds a channel message a session could not take.
	deliveries?: ChannelDeliveryCoordinator;
}

/** The state a rebuild must not restart from empty. Only entries whose loss changes behaviour. */
export interface RoutesCarryOver {
	/** Losing this turns a retried absolute write into a second write. */
	boardOperationReplies: Map<string, Record<string, unknown>>;
	/** Losing this un-coalesces running fetches, so the same bytes are pulled twice. */
	blobFetches: Map<string, Promise<import("./blobOps.js").BlobFetchOutcome>>;
}

export function createRoutesCarryOver(): RoutesCarryOver {
	return { boardOperationReplies: new Map(), blobFetches: new Map() };
}

export function createRoutes(deps: RoutesDeps) {
	const { config, store, auth, carryOver = createRoutesCarryOver(), ambient } = deps;

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
		ambient,
	});

	// Before send and respond: both push through its mirrorPeer and deliverToOwner.
	const consolePush = createHumanNotifyRoutes({
		dataDir: deps.dataDir,
		config,
		ambient,
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
		ambient,
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
		ambient,
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
		ambient,
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
		ambient,
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
