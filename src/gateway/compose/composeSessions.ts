// Stage 3: the registries, the session records, and every plane read off them.

import type { ServerWebSocket } from "bun";
import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import { restoreDurable } from "../../shared/durable-store.js";
import { isReservedHostSession } from "../../shared/host-op.js";
import type { HostSpawnState } from "../../shared/host-spawn.js";
import { PlaneRegistry } from "../../shared/plane-registry.js";
import { type CodexCatalogWriter, type CopilotCatalogWriter, SessionStore } from "../../shared/session-store.js";
import type { TrustedCatalogProject } from "../console/consoleTypes.js";
import { CrossDomainPresenceConsumer } from "../federation/crossDomainPresenceConsumer.js";
import { IntentTracker } from "../intent.js";
import { PresenceFacade } from "../presence.js";
import { ReadAnchors } from "../readAnchors.js";
import { createSessionRegistryReporter } from "../router/sessionRegistryReporter.js";
import { createSessionAuthority, type SessionAuthority } from "../sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "../websocket.js";
import type { StoresStage } from "./composeStores.js";
import type { FederationContext } from "./federationContext.js";

export interface SessionsStageDeps {
	localGatewayId: string;
	ambient: Ambient;
	stores: StoresStage;
	context: FederationContext;
}

export interface SessionsStage {
	registry: TeamRegistry;
	conversationRegistry: Map<string, ServerWebSocket<WsData>>;
	knownTeamPaths: Map<string, string>;
	offlineCatalog: Map<string, string>;
	hostSpawnPoints: HostSpawnState;
	isTrustedCatalogProject: TrustedCatalogProject;
	isAvailableProject: (name: string) => boolean;
	sessionStore: SessionStore;
	codexCatalogWriter: CodexCatalogWriter;
	copilotCatalogWriter: CopilotCatalogWriter;
	sessionReporter: ReturnType<typeof createSessionRegistryReporter>;
	planeRegistry: PlaneRegistry;
	presence: PresenceFacade;
	sessionAuthority: SessionAuthority;
	intentTracker: IntentTracker;
	readAnchors: ReadAnchors;
	crossDomainPresenceConsumer: CrossDomainPresenceConsumer;
	tripwireTimer: IntervalHandle;
	sessionResumeSnapshot: (cleanShutdown: boolean) => Record<string, unknown>;
}

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

export function composeSessions({ localGatewayId, ambient, stores, context }: SessionsStageDeps): SessionsStage {
	const registry: TeamRegistry = new Map<string, Map<string, ServerWebSocket<WsData>>>();
	const conversationRegistry = new Map<string, ServerWebSocket<WsData>>();
	const knownTeamPaths = new Map<string, string>();
	const offlineCatalog = new Map<string, string>();
	const hostSpawnPoints: HostSpawnState = { known: false, ids: [] };
	const { isTrustedCatalogProject, isAvailableProject } = createProjectPredicates(offlineCatalog, knownTeamPaths);

	let persistAgentCatalogChecked: (() => void) | undefined;
	let codexCatalogWriter: CodexCatalogWriter | undefined;
	let copilotCatalogWriter: CopilotCatalogWriter | undefined;
	const persistChecked = () => {
		if (!persistAgentCatalogChecked) throw new Error("Agent persistence is not initialized");
		persistAgentCatalogChecked();
	};
	const sessionStore = new SessionStore({
		ambient,
		clash: (id) => isTrustedCatalogProject(id) || isReservedHostSession(id),
		codexCatalogPersistence: {
			persistChecked,
			receiveWriter: (writer) => {
				codexCatalogWriter = writer;
			},
		},
		copilotCatalogPersistence: {
			persistChecked,
			receiveWriter: (writer) => {
				copilotCatalogWriter = writer;
			},
		},
	});

	const sessionReporter = createSessionRegistryReporter({
		sessionStore,
		send: (action, params) => context.slice()?.routerClient.callInboxTool(action, params) ?? Promise.resolve(),
		incarnation: () => context.slice()?.routerClient.incarnation() ?? null,
		localGatewayId,
	});
	sessionReporter.attach();

	restoreDurable("session-resume", () => sessionStore.restore(stores.restored.sessions));
	console.log(
		`[durability] restored jobs=${stores.jobs.size} resume=${sessionStore.size} ops=${stores.durableOpStore.size}`,
	);

	const planeRegistry = new PlaneRegistry(ambient);
	const presence = new PresenceFacade({
		sessionStore,
		registry,
		offlineCatalog,
		localGatewayId,
		localDomainId: () => context.domainId(),
		displayName: () => context.slice()?.domainMeta?.displayName ?? null,
		isAdminDomain: () => context.slice()?.domainMeta?.isAdminDomain ?? null,
	});
	const sessionAuthority = createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => context.domainId() ?? "",
		localGatewayId,
	});

	presence.attach(planeRegistry);
	presence.registerPlane(stores.restored.planes?.presence);
	planeRegistry.reconcileOnBoot();
	const tripwireTimer = ambient.setInterval(() => planeRegistry.tripwireTick(), 60_000);

	const intentTracker = new IntentTracker({ ambient });
	const readAnchors = new ReadAnchors(planeRegistry, stores.restored.planes);
	readAnchors.restore(stores.restored.readAnchors);
	const crossDomainPresenceConsumer = new CrossDomainPresenceConsumer(planeRegistry, stores.restored.planes, ambient);
	crossDomainPresenceConsumer.restore(stores.restored.crossDomainPresence);

	const sessionResumeSnapshot = (cleanShutdown: boolean) => ({
		sessions: sessionStore.snapshot(),
		planes: planeRegistry.persistedState(cleanShutdown),
		readAnchors: readAnchors.snapshot(),
		crossDomainPresence: crossDomainPresenceConsumer.snapshot(),
	});
	persistAgentCatalogChecked = () => stores.sessionResumeDurable.saveChecked(sessionResumeSnapshot(false));
	if (!codexCatalogWriter || !copilotCatalogWriter) throw new Error("Agent catalog writers were not initialized");

	return {
		registry,
		conversationRegistry,
		knownTeamPaths,
		offlineCatalog,
		hostSpawnPoints,
		isTrustedCatalogProject,
		isAvailableProject,
		sessionStore,
		codexCatalogWriter,
		copilotCatalogWriter,
		sessionReporter,
		planeRegistry,
		presence,
		sessionAuthority,
		intentTracker,
		readAnchors,
		crossDomainPresenceConsumer,
		tripwireTimer,
		sessionResumeSnapshot,
	};
}
