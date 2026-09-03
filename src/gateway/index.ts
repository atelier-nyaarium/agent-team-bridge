import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { DomainSnapshotSchema, signRegister } from "../shared/admission.js";
import { agentHttpPath } from "../shared/agent-backend.js";
import { sweepAtomicTemps } from "../shared/atomic-write.js";
import type { AwarenessObservation } from "../shared/awareness-types.js";
import { BlobStore } from "../shared/blob-store.js";
import { BoardAttachmentStore } from "../shared/board-attachment-store.js";
import { type BoardReply, isBoardReply } from "../shared/board-structure.js";
import type { BoardEntry } from "../shared/console-protocol.js";
import type { Identity } from "../shared/crypto.js";
import { resolveLocalDomainId } from "../shared/domain-id.js";
import { createPersistRunner, DurableStore, openDurable, restoreDurable } from "../shared/durable-store.js";
import { resolveLocalGatewayId } from "../shared/gateway-id.js";
import { type HostOp, type HostOpResult, isReservedHostSession } from "../shared/host-op.js";
import type { HostSpawnState } from "../shared/host-spawn.js";
import { fenced, MIGRATION_SETTLE_MS, useMigrationEpochFile } from "../shared/migration-fence.js";
import { ownerKeyId } from "../shared/owner-id.js";
import { PendingDeliveryStore } from "../shared/pending-delivery-store.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import { type PlanePersistedState, PlaneRegistry, stableHash } from "../shared/plane-registry.js";
import { MAX_BLOB_BYTES } from "../shared/router-protocol.js";
import { BlobGetOpSchema, BlobPutOpSchema, BlobStatOpSchema, GatewayBootstrapFrameSchema } from "../shared/schemas.js";
import { type CodexCatalogWriter, type CopilotCatalogWriter, SessionStore } from "../shared/session-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { type AwarenessBank, createAwarenessBank } from "./awarenessBank.js";
import { answerBlobOp, BlobTooLarge, readBlobRange } from "./blobOps.js";
import { boardAwarenessSubscriber } from "./boardAwareness.js";
import { type BoardDisposition, BoardStore } from "./boardStore.js";
import {
	armingOf,
	type BootState,
	decideBootPhase,
	type FederationSlice,
	federationOf,
	type RouterHandlers,
} from "./boot.js";
import { ChannelDeliveryCoordinator } from "./channelDelivery.js";
import { CodexAgentService } from "./codexAgentService.js";
import { CodexRelay } from "./codexRelay.js";
import { CodexRoute } from "./codexRoute.js";
import { CopilotAgentService } from "./copilotAgentService.js";
import { CopilotRelay } from "./copilotRelay.js";
import { CopilotRoute } from "./copilotRoute.js";

const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const BLOB_ROUTE_SCHEMAS = {
	"/blob/stat": BlobStatOpSchema,
	"/blob/put": BlobPutOpSchema,
	"/blob/get": BlobGetOpSchema,
} as const;

import { opPayloadAadKind, valueResultAadKind } from "../shared/content-envelope.js";
import { ValueOpFrameSchema } from "../shared/router-protocol.js";
import { ConsoleOpSchema } from "../shared/schemasConsoleOp.js";
import { ContentEnvelopeSchema } from "../shared/schemasContentKey.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { CapabilityStore } from "./console/capabilityStore.js";
import { createConsoleDispatcher } from "./console/consoleHandler.js";
import type { TrustedCatalogProject } from "./console/consoleTypes.js";
import { DurableOpStore } from "./console/durableOpStore.js";
import { DaemonCapabilityStore } from "./daemonCapabilities.js";
import { Allowlist } from "./federation/allowlist.js";
import { activateStaged, openBootstrapBundle, recoverStaging, stageBootstrap } from "./federation/bootstrapInstall.js";
import { ContentKeyStore } from "./federation/contentKeyStore.js";
import {
	CrossDomainHandshakeCoordinator,
	createCrossDomainHandshakePump,
	parseCommitReply,
	parseRevealReply,
} from "./federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "./federation/crossDomainPeers.js";
import {
	CrossDomainPresenceConsumer,
	createCoalescedPresencePusher,
	createCrossDomainPresenceReconciler,
	createCrossDomainPresenceSource,
} from "./federation/crossDomainPresence.js";
import { CrossDomainShareState } from "./federation/crossDomainShareState.js";
import { admitGatewayPayload, type EnrollDelivery, logAdmitGatewayQr } from "./federation/enrollQr.js";
import { generateEnrollCert } from "./federation/enrollTls.js";
import { createGatewayRelayHandler, createGatewayRelayPump } from "./federation/gatewayRelay.js";
import { loadOrCreateIdentity } from "./federation/identity.js";
import { ReplayGuard } from "./federation/replayGuard.js";
import { createSealer } from "./federation/sealer.js";
import { HostOpCoordinator } from "./hostOpCoordinator.js";
import { IntentTracker } from "./intent.js";
import { PresenceFacade } from "./presence.js";
import { ReadAnchors } from "./readAnchors.js";
import { createBlobUploader } from "./router/blobUploader.js";
import { createBoardClient } from "./router/boardClient.js";
import { createInboxClaims } from "./router/inboxClaims.js";
import { createInboxDeliveryPump } from "./router/inboxDeliveryPump.js";
import { createKeyRequester } from "./router/keyRequester.js";
import { createPresenceReporter } from "./router/presenceReporter.js";
import { startRouterClient } from "./router/routerClient.js";
import { createSessionRegistryReporter } from "./router/sessionRegistryReporter.js";
import { createShareAttestor } from "./router/shareAttestor.js";
import {
	loadRouterReach,
	loadRouterTransport,
	type RouterTransport,
	routerBootstrapOverride,
	routerWsConnection,
	saveRouterReach,
} from "./router/transport.js";
import { createRoutes, createRoutesCarryOver } from "./routes.js";
import { createSessionAuthority, presentedByRequest } from "./sessionAuthority.js";
import { WakeCoordinator } from "./wake.js";
import { WakeService } from "./wakeService.js";
import { createWebSocketHandlers, resolveLiveIncarnation, type WsData } from "./websocket.js";

export function createProjectPredicates(
	offlineCatalog: ReadonlyMap<string, string>,
	knownTeamPaths: ReadonlyMap<string, string>,
) {
	const isTrustedCatalogProject: TrustedCatalogProject = (name) => offlineCatalog.has(name);
	return {
		isTrustedCatalogProject,
		isAvailableProject: (name: string) => isTrustedCatalogProject(name) || knownTeamPaths.has(name),
	};
}

export async function startGateway(): Promise<void> {
	const PORT = parseInt(process.env.PORT || "20000", 10);
	const ENROLL_TLS_PORT = parseInt(process.env.ENROLL_TLS_PORT || "20003", 10);
	const LOG_DIR = path.join("/app", "log");

	const DATA_DIR = process.env.DATA_DIR || "/app/data";
	// Install the migration fence before constructing durable writers.
	useMigrationEpochFile(DATA_DIR);
	const blobStore = new BlobStore(`${DATA_DIR}/blobs`);
	const boardAttachments = new BoardAttachmentStore(`${DATA_DIR}/board-attachments`);
	const MAX_BLOB_STORE_BYTES = parseInt(process.env.MAX_BLOB_STORE_BYTES || String(MAX_BLOB_BYTES * 16), 10);
	fs.mkdirSync(DATA_DIR, { recursive: true });

	const WAKE_TIMEOUT_MS = parseInt(process.env.WAKE_TIMEOUT_MS || "600000", 10);
	const localGatewayId = resolveLocalGatewayId();
	console.log(`[gateway] Gateway id: ${localGatewayId}`);
	const federationDir = process.env.FEDERATION_DIR || path.join(DATA_DIR, "federation");
	recoverStaging(federationDir);
	for (const name of sweepAtomicTemps(federationDir)) console.log(`[gateway] removed atomic temp ${name}`);
	let cachedIdentity: Identity | null = null;
	const identity = () => (cachedIdentity ??= loadOrCreateIdentity(federationDir));
	const contentKeyStore = new ContentKeyStore(federationDir, () => identity().box.priv);
	let localDomainId = resolveLocalDomainId(federationDir);
	console.log(`[gateway] Domain id: ${localDomainId ?? "(none - not yet enrolled)"}`);

	let boot: BootState = { phase: "standalone" };
	const fed = (): FederationSlice | null => federationOf(boot);

	const SCHEMA_VERSION = "2";
	try {
		const sentinelPath = path.join(DATA_DIR, "schema-version");
		const current = fs.existsSync(sentinelPath) ? fs.readFileSync(sentinelPath, "utf8").trim() : "";
		if (current !== SCHEMA_VERSION) {
			const legacyDir = LOG_DIR;
			for (const f of ["pending-jobs.json", "mailboxes.json"]) {
				fs.rmSync(path.join(DATA_DIR, f), { force: true });
				fs.rmSync(path.join(legacyDir, f), { force: true });
			}
			fs.rmSync(path.join(federationDir, "cross-domain-share-state.json"), { force: true });
			fs.writeFileSync(sentinelPath, SCHEMA_VERSION);
			console.log(`[schema-wipe] cleared old-grammar delivery state (schema ${SCHEMA_VERSION})`);
		}
	} catch (err) {
		console.error("[schema-wipe] failed:", err);
	}

	const HEARTBEAT_INTERVAL_MS = 30000;
	const MISSED_PINGS_LIMIT = 2;

	const registry = new Map<string, Map<string, ServerWebSocket<WsData>>>();
	const conversationRegistry = new Map<string, ServerWebSocket<WsData>>();
	const store = new PendingJobStore<ResponsePayload>(600_000, () => shareAttestor?.attest());
	const knownTeamPaths = new Map<string, string>();
	const offlineCatalog = new Map<string, string>();
	const hostSpawnPoints: HostSpawnState = { known: false, ids: [] };
	const { isTrustedCatalogProject, isAvailableProject } = createProjectPredicates(offlineCatalog, knownTeamPaths);
	const wakeCoordinator = new WakeCoordinator();
	const hostOpCoordinator = new HostOpCoordinator();

	store.startCleanup();

	const jobsDurable = new DurableStore(DATA_DIR, "pending-jobs");
	const durableOpStore = openDurable(DATA_DIR, "op-idempotency", (d) => new DurableOpStore(d));
	const pendingDeliveries = openDurable(DATA_DIR, "pending-deliveries", (d) => new PendingDeliveryStore(d));
	const inboxClaims = createInboxClaims(DATA_DIR);
	const boardReplays = openDurable(DATA_DIR, "board-idempotency", (d) =>
		DurableOpStore.withValidator<BoardReply>(d, isBoardReply),
	);
	const SESSION_RESUME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
	const MAX_SESSION_RESUME_ENTRIES = 2_000;
	const sessionResumeDurable = new DurableStore(DATA_DIR, "session-resume");
	let persistAgentCatalogChecked: (() => void) | undefined;
	let codexCatalogWriter: CodexCatalogWriter | undefined;
	let copilotCatalogWriter: CopilotCatalogWriter | undefined;
	const sessionStore = new SessionStore({
		clash: (id) => isTrustedCatalogProject(id) || isReservedHostSession(id),
		codexCatalogPersistence: {
			persistChecked: () => {
				if (!persistAgentCatalogChecked) throw new Error("Agent persistence is not initialized");
				persistAgentCatalogChecked();
			},
			receiveWriter: (writer) => {
				codexCatalogWriter = writer;
			},
		},
		copilotCatalogPersistence: {
			persistChecked: () => {
				if (!persistAgentCatalogChecked) throw new Error("Agent persistence is not initialized");
				persistAgentCatalogChecked();
			},
			receiveWriter: (writer) => {
				copilotCatalogWriter = writer;
			},
		},
	});
	let inboxPump: ReturnType<typeof createInboxDeliveryPump> | null = null;
	let consoleDeliveryHandler:
		| ((
				op: import("../shared/console-protocol.js").ConsoleOp,
				device: string,
				conversationId: string,
				opId: string,
				ownerSignPub: string,
		  ) => Promise<unknown>)
		| null = null;
	let inboxPeerHandleOp: ReturnType<typeof createGatewayRelayHandler>["handleOp"] | null = null;
	let presenceReporter: ReturnType<typeof createPresenceReporter> | null = null;
	let shareAttestor: ReturnType<typeof createShareAttestor> | null = null;
	let unlinkDomainHandler: ((domainId: string) => unknown) | null = null;
	const sessionReporter = createSessionRegistryReporter({
		sessionStore,
		send: (action, params) => fed()?.routerClient.callInboxTool(action, params) ?? Promise.resolve(),
		incarnation: () => fed()?.routerClient.incarnation() ?? null,
		localGatewayId,
	});
	sessionReporter.attach();
	const capabilityStore = openDurable(DATA_DIR, "console-capabilities", (d) => new CapabilityStore(d));
	const daemonCapabilityStore = openDurable(DATA_DIR, "daemon-capabilities", (d) => new DaemonCapabilityStore(d));

	const loadedResumeRaw = sessionResumeDurable.load();
	const isWrapped = loadedResumeRaw !== null && typeof loadedResumeRaw === "object" && "sessions" in loadedResumeRaw;
	const restoredSessions: unknown = isWrapped
		? (loadedResumeRaw as { sessions?: unknown }).sessions
		: loadedResumeRaw;
	const restoredPlanes: Record<string, PlanePersistedState> | undefined = isWrapped
		? (loadedResumeRaw as { planes?: Record<string, PlanePersistedState> }).planes
		: undefined;
	const restoredReadAnchors: unknown = isWrapped
		? (loadedResumeRaw as { readAnchors?: unknown }).readAnchors
		: undefined;
	const restoredCrossDomainPresence: unknown = isWrapped
		? (loadedResumeRaw as { crossDomainPresence?: unknown }).crossDomainPresence
		: undefined;
	restoreDurable("pending-jobs", () => {
		const jobs = jobsDurable.load();
		if (Array.isArray(jobs)) store.restore(jobs as Parameters<typeof store.restore>[0]);
	});
	restoreDurable("session-resume", () => sessionStore.restore(restoredSessions));
	console.log(`[durability] restored jobs=${store.size} resume=${sessionStore.size} ops=${durableOpStore.size}`);

	const planeRegistry = new PlaneRegistry();
	const presence = new PresenceFacade({
		sessionStore,
		registry,
		offlineCatalog,
		localGatewayId,
		localDomainId: () => localDomainId,
		displayName: () => fed()?.domainMeta?.displayName ?? null,
		isAdminDomain: () => fed()?.domainMeta?.isAdminDomain ?? null,
	});
	const sessionAuthority = createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => localDomainId ?? "",
		localGatewayId,
	});

	presence.attach(planeRegistry);
	presence.registerPlane(restoredPlanes?.presence);
	planeRegistry.reconcileOnBoot();
	const tripwireTimer = setInterval(() => planeRegistry.tripwireTick(), 60_000);
	tripwireTimer.unref?.();

	const intentTracker = new IntentTracker();

	const readAnchors = new ReadAnchors(planeRegistry, restoredPlanes);
	readAnchors.restore(restoredReadAnchors);

	const crossDomainPresenceConsumer = new CrossDomainPresenceConsumer(planeRegistry, restoredPlanes);
	crossDomainPresenceConsumer.restore(restoredCrossDomainPresence);

	let awareness: AwarenessBank | null = null;
	let boardObserve: ((observations: readonly AwarenessObservation<BoardEntry>[]) => void) | undefined;
	const boardStore = openDurable(
		DATA_DIR,
		"task-board",
		(d) =>
			new BoardStore(d, planeRegistry, restoredPlanes, (observations) => boardObserve?.(observations), {
				released: (ownerId, entryId, blobIds) => {
					for (const blobId of blobIds) boardAttachments.remove(ownerId, entryId, blobId);
				},
				releasedAll: (ownerId, entryId) => boardAttachments.removeEntry(ownerId, entryId),
			}),
	);
	const boardSessionEnded = (team: string, disposition: BoardDisposition): number => {
		try {
			const count = boardStore.sessionEnded(team, disposition);
			awareness?.dropFor(team);
			return count;
		} catch (err) {
			console.error(`[task-board] session-ended hook failed for ${team}:`, err);
			return 0;
		}
	};
	const sessionResumeSnapshot = (cleanShutdown: boolean) => ({
		sessions: sessionStore.snapshot(),
		planes: planeRegistry.persistedState(cleanShutdown),
		readAnchors: readAnchors.snapshot(),
		crossDomainPresence: crossDomainPresenceConsumer.snapshot(),
	});
	persistAgentCatalogChecked = () => sessionResumeDurable.saveChecked(sessionResumeSnapshot(false));
	if (!codexCatalogWriter || !copilotCatalogWriter) throw new Error("Agent catalog writers were not initialized");
	const codexAgentService = new CodexAgentService({
		auth: sessionAuthority,
		sessionStore,
		offlineCatalog,
		catalogWriter: codexCatalogWriter,
	});
	const copilotAgentService = new CopilotAgentService({
		auth: sessionAuthority,
		sessionStore,
		offlineCatalog,
		catalogWriter: copilotCatalogWriter,
	});

	const runPersistSteps = createPersistRunner();
	const persistDelivery = (cleanShutdown: boolean) =>
		runPersistSteps([
			{
				name: "pending-jobs",
				run: () =>
					cleanShutdown ? jobsDurable.saveChecked(store.snapshot()) : jobsDurable.save(store.snapshot()),
			},
			{
				name: "session-sweep",
				run: () => {
					const sweptTeams = sessionStore.sweep(SESSION_RESUME_TTL_MS, {
						maxEntries: MAX_SESSION_RESUME_ENTRIES,
						isLive: (team) => resolveLiveIncarnation(registry, sessionStore, team) !== undefined,
					});
					if (sweptTeams.length === 0) return;
					presence.markDirty();
					for (const team of sweptTeams) boardSessionEnded(team, "release");
				},
			},
			{ name: "board-trash-sweep", run: () => boardStore.sweepTrash() },
			{ name: "op-idempotency-sweep", run: () => durableOpStore.sweep() },
			{ name: "board-idempotency-sweep", run: () => boardReplays.sweep() },
			{ name: "console-capabilities-sweep", run: () => capabilityStore.sweep() },
			{
				name: "blob-sweep",
				run: () => {
					const freed = blobStore.sweep({ maxBytes: MAX_BLOB_STORE_BYTES });
					if (freed > 0) console.error(`[blobs] swept ${freed} bytes`);
				},
			},
			{
				name: "session-resume",
				run: () =>
					cleanShutdown
						? sessionResumeDurable.saveChecked(sessionResumeSnapshot(cleanShutdown))
						: sessionResumeDurable.save(sessionResumeSnapshot(cleanShutdown)),
			},
			{ name: "replay-guard", run: () => fed()?.replayPersist() },
		]);
	// Shutdown flush persists under the fence. Shut down before cutting.
	let fencedSince: number | null = null;
	let settled = false;
	const persistTimer = setInterval(() => {
		if (!fenced()) {
			fencedSince = null;
			settled = false;
			persistDelivery(false);
			return;
		}
		fencedSince ??= Date.now();
		if (settled || Date.now() - fencedSince < MIGRATION_SETTLE_MS) return;
		settled = true;
		const dropped = durableOpStore.failInFlight(true);
		console.log(`[migration] settled: ${dropped} in-flight op(s) dropped for the client to re-run`);
	}, 3_000);
	persistTimer.unref?.();
	const shutdown = () => {
		try {
			jobsDurable.saveChecked(store.snapshot());
			sessionResumeDurable.saveChecked(sessionResumeSnapshot(true));
			persistDelivery(true);
		} catch (err) {
			console.error(`[gateway] shutdown persist failed: ${err instanceof Error ? err.message : String(err)}`);
			process.exitCode = 1;
			return;
		}
		fed()?.routerClient.stop();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	process.on("uncaughtException", (err) => {
		console.error("[gateway] uncaughtException:", err);
		// Crash exits without flushing inconsistent state.
		process.exit(1);
	});

	function liveHostSocket() {
		const hostSubs = registry.get("host");
		return hostSubs ? [...hostSubs.values()].find((ws) => ws.readyState === 1) : undefined;
	}

	const wakeService = new WakeService({
		registry,
		sessionStore,
		presence,
		wakeCoordinator,
		isAvailableProject,
		knownTeamPaths,
		offlineCatalog,
		liveHostSocket,
		wakeTimeoutMs: WAKE_TIMEOUT_MS,
	});

	const HOST_OP_TIMEOUT_MS = 20_000;

	const codexRelay = new CodexRelay({
		service: codexAgentService,
		sessionStore,
		sendToHost: (message) => {
			const hostWs = liveHostSocket();
			if (!hostWs) return false;
			hostWs.send(JSON.stringify(message));
			return true;
		},
	});

	const codexRoute = new CodexRoute({ service: codexAgentService, relay: codexRelay });
	const copilotRelay = new CopilotRelay({
		service: copilotAgentService,
		sessionStore,
		sendToHost: (message) => {
			const hostWs = liveHostSocket();
			if (!hostWs) return false;
			hostWs.send(JSON.stringify(message));
			return true;
		},
	});
	const copilotRoute = new CopilotRoute({ service: copilotAgentService, relay: copilotRelay });
	const agentRoutes = new Map<string, (req: Request, body: unknown) => Promise<Response>>([
		[agentHttpPath("codex"), (req, body) => codexRoute.handle(req, body)],
		[agentHttpPath("copilot"), (req, body) => copilotRoute.handle(req, body)],
	]);

	async function relayToHost(op: HostOp): Promise<HostOpResult> {
		const hostWs = liveHostSocket();
		if (!hostWs) return { ok: false, error: "host daemon offline - terminal unavailable" };
		const reqId = randomBytes(8).toString("hex");
		hostWs.send(JSON.stringify({ type: "host_op", reqId, op }));
		return hostOpCoordinator.wait(reqId, HOST_OP_TIMEOUT_MS);
	}

	let lastPushedWatch = "";
	function pushPresenceWatch(force = false): void {
		const hostWs = liveHostSocket();
		if (!hostWs) return;
		const liveTeams = presence
			.snapshot()
			.filter((row) => row.status === "online" || row.status === "verifying")
			.map((row) => row.team);
		const watch = intentTracker.watchList(liveTeams);
		const serialized = JSON.stringify(watch);
		if (!force && serialized === lastPushedWatch) return;
		lastPushedWatch = serialized;
		hostWs.send(JSON.stringify({ type: "presence_watch", watch }));
	}
	const presenceWatchTimer = setInterval(() => pushPresenceWatch(), 2_000);
	presenceWatchTimer.unref?.();

	awareness = createAwarenessBank({
		liveness: (sessionKey) => {
			const live = resolveLiveIncarnation(registry, sessionStore, sessionKey);
			if (live?.data.handshakeConfirmed) return "live";
			if (live || wakeService.isWakeInFlight(sessionKey)) return "waking";
			return "gone";
		},
		deliver: (sessionKey, payload) => {
			const live = resolveLiveIncarnation(registry, sessionStore, sessionKey);
			if (!live?.data.handshakeConfirmed) return false;
			live.send(JSON.stringify(payload));
			return true;
		},
	});
	boardObserve = awareness.register(boardAwarenessSubscriber);
	const awarenessTimer = setInterval(() => {
		try {
			awareness?.tick();
		} catch (err) {
			console.error("[awareness] tick failed:", err);
		}
	}, 1_000);
	awarenessTimer.unref?.();

	const isLinkedDomain = (domainId: string): boolean =>
		fed()
			?.crossDomainPeers.all()
			.some((p) => p.friendDomainId === domainId) ?? false;

	const routerTransport = loadRouterTransport(federationDir);
	const enrollNonce = process.env.ENROLL_NONCE;
	const bootDecision = decideBootPhase({
		hasTransport: routerTransport !== null,
		hasDomainId: localDomainId !== null,
		hasEnrollNonce: !!enrollNonce,
	});

	function buildFederationSlice(transport: RouterTransport, domainId: string): FederationSlice {
		let slice: FederationSlice;
		const allowlist = new Allowlist(federationDir);
		const crossDomainPeers = new CrossDomainPeers(federationDir, () => {
			planeRegistry.markDirty("linked-peers");
			slice.handlers?.presenceSource.recomputeAll();
		});
		planeRegistry.registerPlane(
			{
				name: "linked-peers",
				snapshot: () =>
					crossDomainPeers
						.all()
						.map((p) => ({
							domainId: p.friendDomainId,
							gatewayId: p.friendGatewayId,
							ownerSignPub: p.friendOwnerSignPub,
						}))
						.sort((a, b) => `${a.domainId}.${a.gatewayId}`.localeCompare(`${b.domainId}.${b.gatewayId}`)),
				identityOf: (snapshot) => stableHash(snapshot),
			},
			restoredPlanes?.["linked-peers"],
		);
		const shareState = new CrossDomainShareState(federationDir, (reason) => {
			if (reason.kind === "domain") slice.handlers?.presenceSource.recomputeDomain(reason.domainId);
			else slice.handlers?.presenceSource.recomputeAll();
			shareAttestor?.attest();
		});
		const federationIdentity = identity();
		const replayDurable = new DurableStore(DATA_DIR, "replay-guard");
		const replayGuard = new ReplayGuard();
		restoreDurable("replay-guard", () => {
			const persisted = replayDurable.load();
			if (Array.isArray(persisted)) replayGuard.restore(persisted as Array<[string, number]>);
		});
		const sealer = createSealer(
			federationIdentity,
			allowlist,
			localGatewayId,
			crossDomainPeers,
			domainId,
			replayGuard,
		);
		const routeHandshake = async (
			action: string,
			receiverGatewayId: string,
			payload: unknown,
		): Promise<unknown> => {
			const res = await slice.routerClient.callTool(action, {
				handshakeId: randomBytes(18).toString("base64url"),
				srcDomain: domainId,
				srcGateway: localGatewayId,
				dstGateway: receiverGatewayId,
				payload,
			});
			if (res.error) throw new Error(res.error);
			const r = res.result as { ok?: boolean; error?: string; result?: unknown } | undefined;
			if (!r?.ok) throw new Error(r?.error ?? "the friend's Gateway did not complete the handshake");
			return r.result;
		};
		const coordinator = new CrossDomainHandshakeCoordinator({
			self: {
				ownerSignPub: () => allowlist.ownerSignPub,
				gatewaySignPub: federationIdentity.sign.pub,
				gatewayBoxPub: federationIdentity.box.pub,
				domainId,
				gatewayId: localGatewayId,
			},
			peers: crossDomainPeers,
			route: {
				sendCommit: async (receiverGatewayId, req) => {
					const r = await routeHandshake("cross_domain_handshake", receiverGatewayId, req);
					return parseCommitReply(r);
				},
				sendReveal: async (receiverGatewayId, req) => {
					const r = await routeHandshake("cross_domain_handshake_reveal", receiverGatewayId, req);
					return parseRevealReply(r);
				},
			},
		});
		console.log(`[federation] ${allowlist.ownerSignPub ? "enrolled" : "not yet enrolled (no Domain owner)"}`);
		if (!allowlist.selfAdmission(federationIdentity.sign.pub))
			logAdmitGatewayQr(federationIdentity, localGatewayId);

		const connection = routerWsConnection(transport);
		const bootstrap = routerBootstrapOverride() ?? connection.url;
		console.log(`[router] direct transport -> ${bootstrap}`);

		const routerClient = startRouterClient({
			url: bootstrap,
			headers: connection.headers,
			tls: connection.tls,
			gatewayId: localGatewayId,
			domainId,
			reach: loadRouterReach(federationDir),
			onReach: (learned) => saveRouterReach(federationDir, learned),
			onGatewayRelay: (frame) => {
				slice.handlers?.gatewayRelay(frame);
			},
			onValueOp: (frame) => {
				slice.handlers?.valueOp(frame);
			},
			onCrossDomainHandshake: (frame) => {
				slice.handlers?.crossDomainHandshake(frame);
			},
			onDomainSync: (domain) => {
				const parsed = DomainSnapshotSchema.safeParse(domain);
				if (!parsed.success) {
					console.warn(`[federation] dropped malformed domain sync: ${parsed.error.issues[0]?.message}`);
					return;
				}
				if (allowlist.applySnapshot(parsed.data)) {
					console.log(`[federation] domain sync applied (${parsed.data.admissions.length} admissions)`);
				}
			},
			onDomainMeta: (meta) => {
				slice.domainMeta = meta;
				presence.markDirty();
			},
			onDomainUpdate: (meta) => {
				slice.domainMeta = { ...(slice.domainMeta ?? {}), displayName: meta.displayName };
				presence.markDirty();
			},
			buildRegisterAuth: () => {
				const self = allowlist.selfAdmission(federationIdentity.sign.pub);
				if (!self) return null;
				const proofAt = Date.now();
				const proofNonce = randomBytes(18).toString("base64");
				return {
					signPub: federationIdentity.sign.pub,
					boxPub: federationIdentity.box.pub,
					admission: JSON.stringify(self),
					proof: signRegister(localGatewayId, proofAt, proofNonce, federationIdentity.sign.priv),
					proofAt,
					proofNonce,
				};
			},
			onDisconnect: () => {
				console.error(`[router] disconnected from the Router`);
			},
			onRegistered: () => {
				sessionReporter.reconcile();
				presenceReporter?.baseline();
				shareAttestor?.attest();
				void inboxPump?.resendReceipts();
			},
			onPresenceResync: () => presenceReporter?.resync(),
			onUnlink: (frame) => {
				const domainId = (frame as { domainId?: unknown }).domainId;
				if (typeof domainId === "string") unlinkDomainHandler?.(domainId);
			},
			onInboxDeliver: (frame) =>
				void inboxPump?.onFrame(
					frame as { address: string; rows: unknown; incarnation?: number; deliveryEpoch: number },
				),
			onBlobFetch: (frame) => {
				const request = frame as { opId: string; blobId: string; range?: { offset: number; length: number } };
				try {
					const read = readBlobRange(
						blobStore,
						boardAttachments,
						request.blobId,
						request.range?.offset ?? 0,
						request.range?.length ?? MAX_BLOB_BYTES,
					);
					void routerClient.callInboxTool("blob_fetch_reply", {
						opId: request.opId,
						outcome: "fetched",
						bytes: read.bytes.toString("base64"),
						eof: read.eof,
						sealed: false,
					});
				} catch {
					void routerClient.callInboxTool("blob_fetch_reply", {
						opId: request.opId,
						outcome: "absent",
						sealed: false,
					});
				}
			},
		});
		presenceReporter = createPresenceReporter({
			rows: () => presence.snapshot(),
			spawnPoints: () => ({
				gatewayId: localGatewayId,
				domainId,
				hostSpawns: hostSpawnPoints.known ? hostSpawnPoints.ids : [],
			}),
			send: (action, params) => routerClient.callInboxTool(action, params),
			incarnation: () => routerClient.incarnation(),
		});
		shareAttestor = createShareAttestor({
			shares: () => [...new Set(shareState.all().map((share) => share.sessionTarget))],
			liveJobIds: (sessionTarget) =>
				store.liveCrossDomainJobIds(
					sessionTarget,
					(gatewayId) => crossDomainPeers.all().some((peer) => peer.friendGatewayId === gatewayId),
					SHARE_TTL_MS,
				),
			send: (action, params) => routerClient.callInboxTool(action, params),
			incarnation: () => routerClient.incarnation(),
		});
		shareAttestor.start();
		const blobUploader = createBlobUploader({
			call: (action, params) => routerClient.callInboxTool(action, params),
			blobs: blobStore,
			incarnation: () => routerClient.incarnation(),
			domainId,
			ownerSignPub: () => allowlist.ownerSignPub,
			keys: contentKeyStore,
		});
		const boardClient = createBoardClient({
			call: (action, params) => routerClient.callInboxTool(action, params),
			domainId,
			gatewayId: localGatewayId,
			ownerSignPub: () => allowlist.ownerSignPub,
			keys: contentKeyStore,
		});
		inboxPump = createInboxDeliveryPump({
			claims: inboxClaims,
			routerClient,
			boardObservation: (sessionKey, row) =>
				boardObserve?.([
					{
						sessionKey,
						identity: row.identity,
						pre: row.pre ? boardClient.openEntry(row.pre) : undefined,
						post: row.post ? boardClient.openEntry(row.post) : undefined,
					},
				]),
			incarnation: () => routerClient.incarnation(),
			domainId,
			gatewayId: localGatewayId,
			gatewaySignPub: federationIdentity.sign.pub,
			ownerSignPub: () => allowlist.ownerSignPub,
			contentKeyStore,
			consoleDispatch: (op, device, conversationId, opId, ownerSignPub) =>
				consoleDeliveryHandler
					? consoleDeliveryHandler(op, device, conversationId, opId, ownerSignPub)
					: Promise.reject(new Error("console handler unavailable")),
			producerSignPriv: federationIdentity.sign.priv,
			allowlistSnapshot: () => allowlist.getSnapshot(),
			keyRequester: createKeyRequester({
				domainId,
				gatewayId: localGatewayId,
				gatewaySignPub: federationIdentity.sign.pub,
				gatewaySignPriv: federationIdentity.sign.priv,
				send: (action, params) => routerClient.callInboxTool(action, params),
				onError: (message) => {
					routes.deliverToOwner({
						entry: {
							kind: "notice",
							session_id: `gateway.${localGatewayId}.key-request`,
							title: "Content key unavailable",
							summary: message,
							body: message,
						},
						dedupeKey: `key-request:${domainId}:${localGatewayId}`,
						label: "key-request",
					});
				},
			}),
			sealer,
			coordinator: channelDeliveries,
			tryWakeTeam: (team) => wakeService.tryWakeTeam(team),
			isSessionLive: (sessionId) => !!resolveLiveIncarnation(registry, sessionStore, sessionId),
			peerHandler: (op, srcGateway, srcDomainId) => {
				if (!inboxPeerHandleOp) throw new Error("peer handler not ready");
				return inboxPeerHandleOp(op, srcGateway, srcDomainId);
			},
		});

		slice = {
			allowlist,
			crossDomainPeers,
			shareState,
			coordinator,
			sealer,
			routerClient,
			contentKeyStore,
			boardClient,
			blobUploader,
			replayPersist: () => replayDurable.save(replayGuard.snapshot()),
			domainMeta: null,
			handlers: null,
		};
		return slice;
	}

	function enterArming(nonce: string): void {
		const enrollIdentity = identity();
		const enrollLanHost = process.env.ENROLL_LAN_HOST || "0.0.0.0";
		const enrollCert = generateEnrollCert(enrollLanHost);
		let enrollTlsServer: ReturnType<typeof Bun.serve> | null = null;
		const delivery: EnrollDelivery = {
			nonce,
			...(enrollCert ? { lan: { host: enrollLanHost, port: ENROLL_TLS_PORT, certFp: enrollCert.certFp } } : {}),
		};
		if (enrollCert) {
			enrollTlsServer = Bun.serve({
				port: ENROLL_TLS_PORT,
				tls: { cert: enrollCert.certPem, key: enrollCert.keyPem },
				fetch: async (req) => {
					const url = new URL(req.url);
					if (req.method === "POST" && url.pathname === "/enroll") {
						let body: Record<string, unknown> = {};
						try {
							body = (await req.json()) as Record<string, unknown>;
						} catch {
							return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
								status: 400,
								headers: { "Content-Type": "application/json" },
							});
						}
						return handleEnrollPost(body);
					}
					return new Response(JSON.stringify({ ok: false, error: "not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				},
			});
			console.log(
				`[enroll] pinned-TLS delivery on ${enrollLanHost}:${ENROLL_TLS_PORT} (cert ${enrollCert.certFp.slice(0, 16)}...)`,
			);
		}
		logAdmitGatewayQr(enrollIdentity, localGatewayId, delivery);
		let enrollTimer: ReturnType<typeof setTimeout> | null = null;
		const install = (frame: unknown): string => {
			const bundle = openBootstrapBundle(frame, enrollIdentity, nonce, localGatewayId);
			const heldKeyCount = contentKeyStore.epochs().length;
			const outerSignerSignPub = GatewayBootstrapFrameSchema.parse(frame).signerSignPub;
			stageBootstrap(federationDir, bundle, enrollIdentity, contentKeyStore, outerSignerSignPub);
			try {
				activateStaged(federationDir);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				console.error(
					`[enroll] bundle staged; a gateway restart completes it or a re-arm discards it: ${reason}`,
				);
				throw new Error("bundle is staged; a gateway restart completes it or a re-arm discards it");
			}
			contentKeyStore.reload();
			console.log(
				`[federation] content keys: held ${heldKeyCount}, delivered ${bundle.contentKeys?.length ?? 0}`,
			);
			boot = { phase: "standalone" };
			enrollTlsServer?.stop();
			enrollTlsServer = null;
			if (enrollTimer) clearTimeout(enrollTimer);
			const installedTransport = loadRouterTransport(federationDir);
			const installedDomainId = resolveLocalDomainId(federationDir);
			if (installedTransport && installedDomainId) {
				try {
					enterFederationActive(installedTransport, installedDomainId);
					console.log(
						`[enroll] installed credentials for Gateway "${localGatewayId}"; connecting to the Router.`,
					);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(
						`[enroll] credentials installed but Router activation failed: ${msg}. Re-run setup.sh (Setup Gateway).`,
					);
				}
			} else {
				console.log(
					`[enroll] credentials installed but no Domain id resolved; re-run setup.sh (Setup Gateway).`,
				);
			}
			return localGatewayId;
		};
		enrollTimer = setTimeout(() => {
			if (armingOf(boot)) {
				boot = { phase: "standalone" };
				enrollTlsServer?.stop(true);
				enrollTlsServer = null;
				console.log("[enroll] enrollment window expired (~10 min); re-run setup.sh (Enroll gateway)");
			}
		}, 600_000);
		enrollTimer.unref?.();
		boot = {
			phase: "arming",
			arming: { install, admitPayload: admitGatewayPayload(enrollIdentity, localGatewayId, delivery) },
		};
	}
	if (bootDecision === "arm" && enrollNonce) enterArming(enrollNonce);

	function handleEnrollPost(body: Record<string, unknown>): Response {
		const install = armingOf(boot)?.install;
		if (!install) {
			return new Response(JSON.stringify({ ok: false, error: "not in enrollment mode" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		try {
			const gatewayId = install(body);
			return new Response(JSON.stringify({ ok: true, gatewayId }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (e) {
			return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}
	}

	const channelDeliveries = new ChannelDeliveryCoordinator({
		store: pendingDeliveries,
		registry,
		repushHandshake: (team, subId) => wsHandlers.repushHandshake(team, subId),
	});

	const wsHandlers = createWebSocketHandlers({
		registry,
		conversationRegistry,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT, hostWsToken: process.env.HOST_WS_TOKEN },
		knownTeamPaths,
		offlineCatalog,
		hostSpawnPoints,
		wakeCoordinator,
		hostOpCoordinator,
		onTeamConnect: (team) => {
			if (team === "host") pushPresenceWatch(true);
			const handed = channelDeliveries.drain(team);
			if (handed === "migrating") return;
			if (handed > 0) console.log(`[delivery] handed ${handed} held message(s) to ${team}`);
		},
		onDeliveryAck: (team, deliveryId) => {
			void inboxPump?.onChannelDeliveryAck(team, deliveryId);
			if (channelDeliveries.acknowledge(deliveryId) === true) {
				console.log(`[delivery] ${team} confirmed ${deliveryId.slice(0, 8)}`);
			}
		},
		onTeamDisconnect: (team) => {
			if (team === "host") {
				presence.clearAllWorking();
				presence.markDirty();
			}
		},
		onCatalogChange: () => presence.markDirty(),
		onDaemonCapabilities: (capabilities) => daemonCapabilityStore.declare(capabilities),
		onCodexHostMessage: (msg) => codexRelay.handleHostMessage(msg),
		onCopilotHostMessage: (msg) => copilotRelay.handleHostMessage(msg),
		onPresenceDerive: (team, derived) => {
			if (!derived) presence.clearWorkingFor(team);
			else presence.setWorking(team, derived);
		},
		sessionStore,
		auth: sessionAuthority,
		presenceWriter: {
			establishOnConfirm: (team, args) => presence.establishOnConfirm(team, args),
			clearLive: (team, subId) => presence.clearLive(team, subId),
		},
		announcePresenceDirty: () => presence.markDirty(),
	});

	const routesCarryOver = createRoutesCarryOver();

	function buildRoutes() {
		const f = fed();
		return createRoutes({
			carryOver: routesCarryOver,
			registry,
			conversationRegistry,
			store,
			capabilityStore,
			daemonCapabilityStore,
			blobStore,
			blobUploader: f?.blobUploader,
			contentKeyStore: f?.contentKeyStore,
			ownerSignPub: f ? () => f.allowlist.ownerSignPub : null,
			auth: sessionAuthority,
			config: { localGatewayId, localDomainId },
			producerSignPriv: f ? identity().sign.priv : undefined,
			tryWakeTeam: (team, createOpts) => wakeService.tryWakeTeam(team, createOpts),
			sessionStore,
			presence,
			hostSpawnPoints,
			routerClient: f?.routerClient ?? null,
			sealer: f?.sealer ?? null,
			crossDomainPeers: f?.crossDomainPeers ?? null,
			resolvesLocalGateway: f ? (gatewayId) => f.allowlist.resolveGateway(gatewayId) !== null : null,
			touchShares: f ? (sessionTarget) => f.shareState.touch(sessionTarget) : null,
			isSharedToForReply: f
				? (sessionTarget, domainId) => f.shareState.isSharedTo(sessionTarget, domainId, isLinkedDomain)
				: null,
			sharesFor: f ? (domainId) => f.shareState.sharesFor(domainId, isLinkedDomain) : null,
			crossDomainPresenceConsumer,
			resolveHandshake: wsHandlers.resolveHandshake,
			findPendingHandshake: wsHandlers.findPendingHandshakeId,
			repushHandshake: wsHandlers.repushHandshake,
			deliveries: channelDeliveries,
			ownerId: f ? () => (f.allowlist.ownerSignPub ? ownerKeyId(f.allowlist.ownerSignPub) : null) : null,
			boardClient: f?.boardClient,
			boardReplays,
			awareness: awareness ?? undefined,
		});
	}

	let routes = buildRoutes();

	function buildRouterHandlers(federation: FederationSlice): RouterHandlers {
		const presencePusher = createCoalescedPresencePusher((domainId, sessions) =>
			routes.pushPresenceToDomain(domainId, sessions),
		);
		const presenceSource = createCrossDomainPresenceSource({
			planeRegistry,
			restoredPlanes,
			presenceForDomain: (domainId) => routes.presenceForDomain(domainId),
			invalidatePresenceCache: () => routes.invalidatePresenceSnapshotCache(),
			linkedAndSharedDomainIds: () => {
				const domainIds = [...new Set(federation.crossDomainPeers.all().map((p) => p.friendDomainId))];
				return domainIds.filter((id) => federation.shareState.sharesFor(id, isLinkedDomain).length > 0);
			},
			push: presencePusher.push,
			cancelPush: presencePusher.cancel,
		});
		presence.onMarkDirty(() => {
			presenceSource.recomputeAll();
			presenceReporter?.markDirty();
		});
		presenceSource.recomputeAll();

		const reconciler = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => [...new Set(federation.crossDomainPeers.all().map((p) => p.friendDomainId))],
			pull: (domainId) => routes.pullPresenceFromDomain(domainId),
			land: (domainId, sessions) => crossDomainPresenceConsumer.land(domainId, sessions),
		});
		setInterval(() => reconciler.tick(), 10_000);
		const unlinkDomain = (domainId: string) => {
			const result = {
				peersRemoved: federation.crossDomainPeers.removeByDomain(domainId),
				sharesDropped: federation.shareState.dropDomain(domainId),
				jobsExpired: store.expireByDomain(domainId),
			};
			presenceSource.teardown(domainId);
			crossDomainPresenceConsumer.teardown(domainId);
			reconciler.cancel(domainId);
			return result;
		};
		unlinkDomainHandler = unlinkDomain;

		const consoleHandler = createConsoleDispatcher({
			blobStore,
			boardAttachments,
			fetchBlobFromGateway: routes.fetchBlobFromGateway,
			registry,
			conversationRegistry,
			routes,
			localGatewayId,
			localDomainId: localDomainId ?? "",
			isTrustedCatalogProject,
			dropSessionResume: (team, disposition) => {
				presence.forget(team);
				boardSessionEnded(team, disposition);
			},
			sessionStore: presence,
			capabilityStore,
			domain: () => {
				const snapshot = federation.allowlist.getSnapshot() ?? null;
				return snapshot ? { version: federation.allowlist.version() ?? "", snapshot } : null;
			},
			domainStatus: () => federation.domainMeta?.domainStatus,
			planeRegistry,
			presence,
			intentTracker,
			readAnchors,
			boardStore,
			crossDomainPresenceConsumer,
			linkedDomainIds: () => [...new Set(federation.crossDomainPeers.all().map((p) => p.friendDomainId))],
			relayToHost,
			tryWakeTeam: (team) => wakeService.tryWakeTeam(team),
			isWakeInFlight: (team) => wakeService.isWakeInFlight(team),
			markCreateInFlight: (team) => wakeService.markCreateInFlight(team),
			awaitRegister: (team) => wakeCoordinator.waitFor(team, WAKE_TIMEOUT_MS),
			crossDomain: {
				listen: () => federation.coordinator.listen(),
				request: (args) => federation.coordinator.request(args),
				confirm: (args) => federation.coordinator.confirm(args),
				cancel: (args) => federation.coordinator.cancel(args),
				listenState: (listeningToken) => federation.coordinator.listenState(listeningToken),
				listPeers: () => ({
					peers: federation.crossDomainPeers.all().map((p) => ({
						domainId: p.friendDomainId,
						gatewayId: p.friendGatewayId,
						ownerSignPub: p.friendOwnerSignPub,
					})),
				}),
			},
			crossDomainShare: {
				share: (sessionTarget, target) => federation.shareState.share(sessionTarget, target),
				unshare: (sessionTarget, target) => federation.shareState.unshare(sessionTarget, target),
				expireSessionJobsForTarget: (sessionTarget, target) => {
					const domains =
						target.kind === "domain"
							? [target.domainId]
							: [...new Set(federation.crossDomainPeers.all().map((p) => p.friendDomainId))];
					for (const d of domains) store.expireBySession(sessionTarget, d);
				},
				listShares: () =>
					federation.shareState.all().map((s) => ({ sessionTarget: s.sessionTarget, target: s.target })),
				isLinkedDomain,
			},
			unlinkDomain,
			untrustOwner: (ownerSignPub) => {
				const { removed, domains } = federation.crossDomainPeers.removeByOwner(ownerSignPub);
				let sharesDropped = 0;
				let jobsExpired = 0;
				for (const domainId of domains) {
					sharesDropped += federation.shareState.dropDomain(domainId);
					jobsExpired += store.expireByDomain(domainId);
					presenceSource.teardown(domainId);
					crossDomainPresenceConsumer.teardown(domainId);
					reconciler.cancel(domainId);
				}
				return { peersRemoved: removed, sharesDropped, jobsExpired };
			},
			durableOpStore,
		});
		consoleDeliveryHandler = consoleHandler.handleDelivery;
		const valueOp = (raw: unknown): void => {
			void (async () => {
				const frame = ValueOpFrameSchema.safeParse(raw);
				if (!frame.success) return;
				const ownerSignPub = federation.allowlist.ownerSignPub;
				const domainId = localDomainId;
				const incarnation = federation.routerClient.incarnation();
				if (!ownerSignPub || !domainId || incarnation === null) return;
				const value = ContentEnvelopeSchema.safeParse(frame.data.value);
				if (!value.success) return;
				const opened = federation.contentKeyStore.open(value.data, {
					domainId,
					ownerSignPub,
					epoch: value.data.epoch,
					kind: opPayloadAadKind(),
				});
				let result: unknown;
				if (opened.kind !== "ok") result = { kind: "refusal", reason: "content key unavailable" };
				else {
					try {
						const op = ConsoleOpSchema.parse(JSON.parse(opened.plaintext.toString("utf8")));
						result = {
							kind: "ok",
							result: await consoleHandler.handleValue(
								op,
								frame.data.device,
								frame.data.conversationId,
								frame.data.opId,
								frame.data.signerSignPub,
							),
						};
					} catch (error) {
						result = { kind: "refusal", reason: (error as Error).message };
					}
				}
				if (result && (result as { kind?: string }).kind === "ok") {
					const sealed = federation.contentKeyStore.seal(
						Buffer.from(JSON.stringify((result as { result: unknown }).result)),
						{
							domainId,
							ownerSignPub,
							kind: valueResultAadKind(frame.data.opId),
						},
					);
					result =
						sealed.kind === "ok" ? sealed.envelope : { kind: "refusal", reason: "content key unavailable" };
				}
				await federation.routerClient.callTool("value_result", {
					opId: frame.data.opId,
					conversationId: frame.data.conversationId,
					result,
					incarnation,
				});
			})().catch(() => undefined);
		};

		const gatewayRelayHandler = createGatewayRelayHandler({
			routes,
			tryWakeTeam: (team) => wakeService.tryWakeTeam(team),
			localGatewayId,
			localDomainId: localDomainId ?? "",
			shareState: {
				isSharedTo: (sessionTarget, domainId) =>
					federation.shareState.isSharedTo(sessionTarget, domainId, isLinkedDomain),
				sharesFor: (domainId) => federation.shareState.sharesFor(domainId, isLinkedDomain),
				touch: (sessionTarget) => federation.shareState.touch(sessionTarget),
			},
			crossDomainBinding: (sessionId) => store.crossDomainBinding(sessionId),
			serveBlobRange: (blobId, offset, length) => {
				const r = readBlobRange(blobStore, boardAttachments, blobId, offset, length);
				return { ...(r.bytes.length > 0 ? { chunk: r.bytes.toString("base64") } : {}), eof: r.eof };
			},
		});
		inboxPeerHandleOp = gatewayRelayHandler.handleOp;
		const gatewayRelay = createGatewayRelayPump({
			sealer: federation.sealer,
			handleOp: gatewayRelayHandler.handleOp,
			sendReply: (reply) =>
				federation.routerClient.callTool("gateway_relay_reply", reply as unknown as Record<string, unknown>),
		});

		const crossDomainHandshake = createCrossDomainHandshakePump({
			handleIncomingCommit: (req) => federation.coordinator.handleIncomingCommit(req),
			handleIncomingReveal: (req) => federation.coordinator.handleIncomingReveal(req),
			sendCommitReply: (reply) =>
				federation.routerClient.callTool(
					"cross_domain_handshake_reply",
					reply as unknown as Record<string, unknown>,
				),
			sendRevealReply: (reply) =>
				federation.routerClient.callTool(
					"cross_domain_handshake_reveal_reply",
					reply as unknown as Record<string, unknown>,
				),
		});

		return {
			gatewayRelay,
			valueOp,
			crossDomainHandshake,
			presenceSource,
		};
	}

	function startShareSweep(federation: FederationSlice): void {
		const THIRTY_DAYS_MS = SHARE_TTL_MS;
		const isLive = (sessionTarget: string): boolean =>
			store.hasLiveCrossDomainThread(
				sessionTarget,
				(gatewayId) => federation.crossDomainPeers.all().some((p) => p.friendGatewayId === gatewayId),
				THIRTY_DAYS_MS,
			);
		const shareSweepTimer = setInterval(() => {
			const dropped = federation.shareState.sweep(Date.now(), THIRTY_DAYS_MS, isLive);
			if (dropped > 0) console.log(`[federation] auto-forgot ${dropped} stale cross-Domain share(s)`);
		}, 3_600_000);
		shareSweepTimer.unref?.();
	}

	function enterFederationActive(transport: RouterTransport, domainId: string): void {
		if (boot.phase === "federationActive") return;
		localDomainId = domainId;
		const federation = buildFederationSlice(transport, domainId);
		boot = { phase: "federationActive", federation };
		routes = buildRoutes();
		federation.handlers = buildRouterHandlers(federation);
		startShareSweep(federation);
	}
	if (bootDecision === "activate" && routerTransport && localDomainId) {
		enterFederationActive(routerTransport, localDomainId);
	}

	async function router(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const method = req.method;

		let body: Record<string, unknown> = {};
		if (method === "POST") {
			try {
				body = await req.json();
			} catch {
				return new Response(JSON.stringify({ error: `Invalid JSON` }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		if (method === "POST" && url.pathname === "/enroll") {
			return handleEnrollPost(body);
		}
		if (method === "GET" && url.pathname === "/admit-payload") {
			// Admit payloads require the armed enrollment nonce.
			const presented = Buffer.from(req.headers.get("x-enroll-nonce") ?? "");
			const expected = Buffer.from(enrollNonce ?? "");
			const authed =
				!!enrollNonce && presented.length === expected.length && timingSafeEqual(presented, expected);
			const admitPayload = armingOf(boot)?.admitPayload;
			if (!admitPayload || !authed) {
				return new Response(JSON.stringify({ ok: false, error: "not in enrollment mode" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(admitPayload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (method === "GET" && url.pathname === "/pending") return routes.pending(req);
		if (method === "GET" && url.pathname === "/teams") return routes.teams();
		if (method === "GET" && url.pathname === "/capabilities") return routes.capabilities();
		if (method === "GET" && url.pathname === "/discover") return routes.discover(url);
		if (method === "POST" && url.pathname === "/send") return routes.send(req, body);
		if (method === "POST" && url.pathname === "/respond") return routes.respond(req, body);
		if (method === "POST" && url.pathname === "/poll") return routes.poll(req, body);
		if (method === "GET" && url.pathname === "/health") return routes.health();
		if (method === "POST" && url.pathname === "/human/notify") return routes.humanNotify(req, body);
		if (method === "POST" && url.pathname === "/plugin-action") return routes.pluginAction(req, body);
		if (method === "POST" && url.pathname === "/task-board") return routes.taskBoard(req, body);
		if (method === "POST") {
			const agentRoute = agentRoutes.get(url.pathname);
			if (agentRoute) return agentRoute(req, body);
		}

		const blobRoute = BLOB_ROUTE_SCHEMAS[url.pathname as keyof typeof BLOB_ROUTE_SCHEMAS];
		if (method === "POST" && blobRoute) {
			if (!sessionAuthority.mayUseLocalPlane(presentedByRequest(req))) {
				return Response.json({ error: "blob transfer is not open to this caller" }, { status: 403 });
			}
			const parsed = blobRoute.safeParse({ ...body, kind: blobRoute.shape.kind.value });
			if (!parsed.success) {
				return Response.json(
					{ error: `Invalid blob request: ${parsed.error.issues[0]?.message}` },
					{ status: 400 },
				);
			}
			try {
				return Response.json(
					await answerBlobOp(blobStore, parsed.data, routes.fetchBlobFromGateway, boardAttachments),
				);
			} catch (err) {
				if (!(err instanceof BlobTooLarge)) throw err;
				return Response.json({ error: err.message }, { status: 413 });
			}
		}

		return new Response("Not Found", { status: 404 });
	}

	Bun.serve<WsData>({
		port: PORT,
		maxRequestBodySize: 8_000_000,
		fetch(req, server) {
			const url = new URL(req.url);

			const proxyMatch = url.pathname.match(/^\/connector\/([^/]+)\/ws$/);
			if (proxyMatch) {
				const project = proxyMatch[1];
				// Proxy only trusted catalog projects to prevent SSRF.
				if (!offlineCatalog.has(project)) {
					return new Response("Unknown connector project", { status: 404 });
				}
				const authHeader = req.headers.get("Authorization") || "";
				if (
					server.upgrade(req, {
						data: {
							teamName: null,
							subId: "",
							conversationId: null,
							mode: "channel" as const,
							missedPings: 0,
							isStale: false,
							handshakeConfirmed: false,
							proxyProject: project,
							proxyAuth: authHeader,
						},
					})
				) {
					return;
				}
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/bridge") {
				if (
					server.upgrade(req, {
						data: {
							teamName: null,
							subId: "",
							conversationId: null,
							mode: "channel" as const,
							missedPings: 0,
							isStale: false,
							handshakeConfirmed: false,
						},
					})
				) {
					return;
				}
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			return router(req);
		},
		websocket: {
			open(ws) {
				if (ws.data.proxyProject) {
					setupProxy(ws, ws.data.proxyProject, ws.data.proxyAuth || "");
					return;
				}
				wsHandlers.open(ws);
			},
			message(ws, raw) {
				if (isProxyConnection(ws)) {
					handleProxyMessage(ws, raw);
					return;
				}
				wsHandlers.message(ws, raw);
			},
			close(ws) {
				if (isProxyConnection(ws)) {
					handleProxyClose(ws);
					return;
				}
				wsHandlers.close(ws);
			},
			pong(ws) {
				wsHandlers.pong(ws);
			},
		},
	});

	console.log(`[router] listening on :${PORT} (HTTP + WebSocket)`);
}
