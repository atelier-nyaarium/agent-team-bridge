// Stage 10: the session sockets and the held-delivery handover that rides them.

import type { Ambient } from "../../shared/ambient.js";
import { ChannelDeliveryCoordinator } from "../channelDelivery.js";
import { createWebSocketHandlers } from "../websocket.js";
import type { AgentsStage } from "./composeAgents.js";
import type { FederationStage } from "./composeFederation.js";
import type { HostStage } from "./composeHost.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";

const HEARTBEAT_INTERVAL_MS = 30000;
const MISSED_PINGS_LIMIT = 2;

export interface WebSocketsStageDeps {
	hostWsToken?: string;
	ambient: Ambient;
	stores: StoresStage;
	sessions: SessionsStage;
	host: Pick<HostStage, "wakeCoordinator" | "hostOpCoordinator" | "pushPresenceWatch">;
	agents: Pick<AgentsStage, "codexRelay" | "copilotRelay">;
	federation: Pick<FederationStage, "channelDeliveryAck">;
}

export interface WebSocketsStage {
	channelDeliveries: ChannelDeliveryCoordinator;
	wsHandlers: ReturnType<typeof createWebSocketHandlers>;
}

export function composeWebSockets(deps: WebSocketsStageDeps): WebSocketsStage {
	const { sessions, stores, host, agents, federation, ambient } = deps;
	const channelDeliveries = new ChannelDeliveryCoordinator({
		store: stores.pendingDeliveries,
		registry: sessions.registry,
		repushHandshake: (team, subId) => wsHandlers.repushHandshake(team, subId),
	});

	const wsHandlers = createWebSocketHandlers({
		ambient,
		registry: sessions.registry,
		conversationRegistry: sessions.conversationRegistry,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT, hostWsToken: deps.hostWsToken },
		knownTeamPaths: sessions.knownTeamPaths,
		offlineCatalog: sessions.offlineCatalog,
		hostSpawnPoints: sessions.hostSpawnPoints,
		wakeCoordinator: host.wakeCoordinator,
		hostOpCoordinator: host.hostOpCoordinator,
		onTeamConnect: (team) => {
			if (team === "host") host.pushPresenceWatch(true);
			const handed = channelDeliveries.drain(team);
			if (handed === "migrating") return;
			if (handed > 0) console.log(`[delivery] handed ${handed} held message(s) to ${team}`);
		},
		onDeliveryAck: (team, deliveryId) => {
			federation.channelDeliveryAck(team, deliveryId);
			if (channelDeliveries.acknowledge(deliveryId) === true) {
				console.log(`[delivery] ${team} confirmed ${deliveryId.slice(0, 8)}`);
			}
		},
		onTeamDisconnect: (team) => {
			if (team === "host") {
				sessions.presence.clearAllWorking();
				sessions.presence.markDirty();
			}
		},
		onCatalogChange: () => sessions.presence.markDirty(),
		onDaemonCapabilities: (capabilities) => stores.daemonCapabilityStore.declare(capabilities),
		onCodexHostMessage: (msg) => agents.codexRelay.handleHostMessage(msg),
		onCopilotHostMessage: (msg) => agents.copilotRelay.handleHostMessage(msg),
		onPresenceDerive: (team, derived) => {
			if (!derived) sessions.presence.clearWorkingFor(team);
			else sessions.presence.setWorking(team, derived);
		},
		sessionStore: sessions.sessionStore,
		auth: sessions.sessionAuthority,
		presenceWriter: {
			establishOnConfirm: (team, args) => sessions.presence.establishOnConfirm(team, args),
			clearLive: (team, subId) => sessions.presence.clearLive(team, subId),
		},
		announcePresenceDirty: () => sessions.presence.markDirty(),
	});

	return { channelDeliveries, wsHandlers };
}
