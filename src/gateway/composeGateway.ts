// The whole gateway graph, one stage at a time. Each stage takes what it reads and hands back what
// the later ones need; the cycles between them stay closures over this file's own bindings.

import type { ChannelDeliveryCoordinator } from "./channelDelivery.js";
import { composeAgents } from "./compose/composeAgents.js";
import { composeAwareness } from "./compose/composeAwareness.js";
import { composeBootstrap } from "./compose/composeBootstrap.js";
import { composeEnrollment } from "./compose/composeEnrollment.js";
import { composeFaults } from "./compose/composeFaults.js";
import { composeFederation, type FederationStage } from "./compose/composeFederation.js";
import { composeHost } from "./compose/composeHost.js";
import { composeListener } from "./compose/composeListener.js";
import { composePersistence } from "./compose/composePersistence.js";
import { composeRouterFrames, type RouterFramesBuild, type RouterFramesStage } from "./compose/composeRouterFrames.js";
import {
	composeRouterPresence,
	type RouterPresenceBuild,
	type RouterPresenceStage,
} from "./compose/composeRouterPresence.js";
import { composeRoutes, type GatewayRoutes, type RoutesStage } from "./compose/composeRoutes.js";
import { composeSessions } from "./compose/composeSessions.js";
import { composeStores } from "./compose/composeStores.js";
import { composeWebSockets, type WebSocketsStage } from "./compose/composeWebSockets.js";
import { FederationContext } from "./compose/federationContext.js";
import type { GatewayDeps, GatewayGraph } from "./compose/gatewayTypes.js";

export { createProjectPredicates } from "./compose/composeSessions.js";
export type {
	EnrollTlsListener,
	GatewayConfig,
	GatewayDeps,
	GatewayFaultPort,
	GatewayGraph,
	OpenEnrollTls,
} from "./compose/gatewayTypes.js";

/** The whole gateway graph. */
export function composeGateway(deps: GatewayDeps): GatewayGraph {
	const { config } = deps;
	const bootstrap = composeBootstrap(deps);

	// Stages the earlier ones reach forward into. Every read is a call, never a captured value.
	let federation: FederationStage | undefined;
	let websockets: WebSocketsStage | undefined;
	let routes: RoutesStage | undefined;
	let routerPresence: RouterPresenceStage | undefined;
	let routerFrames: RouterFramesStage | undefined;
	let frames: RouterFramesBuild | undefined;
	let presenceHandlers: RouterPresenceBuild | undefined;

	const requireRoutes = (): GatewayRoutes => {
		if (!routes) throw new Error("the routes stage is not composed yet");
		return routes.current();
	};
	const requireDeliveries = (): ChannelDeliveryCoordinator => {
		if (!websockets) throw new Error("the websockets stage is not composed yet");
		return websockets.channelDeliveries;
	};

	const context = new FederationContext({
		contentKeys: bootstrap.contentKeyStore,
		initialDomainId: bootstrap.initialDomainId,
		buildSlice: (boot) => {
			if (!federation) throw new Error("the federation stage is not composed yet");
			return federation.buildSlice(boot);
		},
		onActivate: (slice) => {
			if (!routes || !routerPresence || !routerFrames || !federation) {
				throw new Error("federation activated before the graph was composed");
			}
			routes.rebuild();
			presenceHandlers = routerPresence.build(slice);
			frames = routerFrames.build(slice, presenceHandlers);
			slice.handlers = { frames, presence: presenceHandlers };
			federation.startShareSweep(slice);
		},
	});

	const stores = composeStores({
		dataDir: bootstrap.dataDir,
		maxBlobStoreBytes: config.maxBlobStoreBytes,
		onJobChange: () => federation?.attest(),
	});
	const sessions = composeSessions({ localGatewayId: bootstrap.localGatewayId, stores, context });
	const persistence = composePersistence({ now: bootstrap.now, stores, sessions, context });
	const host = composeHost({
		sessions,
		wakeTimeoutMs: config.wakeTimeoutMs,
		randomBytes: bootstrap.randomBytes,
	});
	const agents = composeAgents({ sessions, host });
	const awareness = composeAwareness({ sessions, host });

	federation = composeFederation({
		dataDir: bootstrap.dataDir,
		federationDir: bootstrap.federationDir,
		localGatewayId: bootstrap.localGatewayId,
		routerBootstrapUrl: config.routerBootstrapUrl,
		now: bootstrap.now,
		randomBytes: bootstrap.randomBytes,
		context,
		stores,
		sessions,
		host,
		awareness,
		routes: requireRoutes,
		channelDeliveries: requireDeliveries,
		consoleDispatch: () => frames?.consoleDelivery ?? null,
		peerHandleOp: () => frames?.peerHandleOp ?? null,
		unlinkDomain: () => presenceHandlers?.unlinkDomain ?? null,
	});

	const enrollment = composeEnrollment({
		federationDir: bootstrap.federationDir,
		localGatewayId: bootstrap.localGatewayId,
		enrollTlsPort: config.enrollTlsPort,
		enrollLanHost: config.enrollLanHost,
		openEnrollTls: deps.openEnrollTls,
		identity: bootstrap.identity,
		contentKeyStore: bootstrap.contentKeyStore,
		resolveBoot: bootstrap.resolveBoot,
		context,
	});

	websockets = composeWebSockets({
		hostWsToken: config.hostWsToken,
		stores,
		sessions,
		host,
		agents,
		federation,
	});
	routes = composeRoutes({
		dataDir: bootstrap.dataDir,
		localGatewayId: bootstrap.localGatewayId,
		now: bootstrap.now,
		identity: bootstrap.identity,
		context,
		stores,
		sessions,
		host,
		awareness,
		websockets,
	});
	routerPresence = composeRouterPresence({ context, stores, sessions, federation, routes: requireRoutes });
	routerFrames = composeRouterFrames({
		localGatewayId: bootstrap.localGatewayId,
		wakeTimeoutMs: config.wakeTimeoutMs,
		context,
		stores,
		sessions,
		host,
		routes: requireRoutes,
	});

	if (bootstrap.gatewayBoot.kind === "arming") enrollment.enterArming(bootstrap.gatewayBoot.nonce);
	if (bootstrap.gatewayBoot.kind === "active") context.activate(bootstrap.gatewayBoot.boot);

	const listener = composeListener({
		dataDir: bootstrap.dataDir,
		enrollNonce: config.enrollNonce,
		context,
		stores,
		sessions,
		persistence,
		host,
		agents,
		awareness,
		federation,
		enrollment,
		websockets,
		routes,
		routerPresence,
	});

	return {
		router: listener.router,
		wsHandlers: websockets.wsHandlers,
		close: listener.close,
		faults: composeFaults({ context, sessions }),
	};
}
