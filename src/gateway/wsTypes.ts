import type { ServerWebSocket } from "bun";
import type { Ambient } from "../shared/ambient.js";
import type { Capability } from "../shared/capabilities.js";
import type { HostSpawnState } from "../shared/host-spawn.js";
import type { SessionStore } from "../shared/session-store.js";
import type { ConnectionMode, WebSocketConfig } from "../shared/types.js";
import type { SessionAuthority } from "./sessionAuthority.js";
import type { WakeCoordinator } from "./wake.js";

export type TeamRegistry = Map<string, Map<string, ServerWebSocket<WsData>>>;
export type ConversationRegistry = Map<string, ServerWebSocket<WsData>>;

export interface WebSocketDeps {
	ambient: Pick<Ambient, "now" | "newId" | "setInterval">;
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	knownTeamPaths: Map<string, string>;
	offlineCatalog: Map<string, string>;
	hostSpawnPoints?: HostSpawnState;
	wakeCoordinator: WakeCoordinator;
	hostOpCoordinator?: {
		settle: (
			reqId: string,
			result: { ok: boolean; result?: unknown; error?: string; errorKind?: "absent" | "failure" },
		) => void;
		failAll: (error: string) => void;
	};
	config: WebSocketConfig;
	onTeamConnect?: (team: string, ws: ServerWebSocket<WsData>) => void;
	onTeamDisconnect?: (team: string) => void;
	onDeliveryAck?: (team: string, deliveryId: string) => void;
	onCatalogChange?: () => void;
	onPresenceDerive?: (
		team: string,
		derived: { working?: boolean; needsLogin?: boolean; limitBlocked?: boolean; limitDetail?: string } | undefined,
	) => void;
	onVirtualPeerEvicted?: (conversationId: string) => void;
	onDaemonCapabilities?: (capabilities: Capability[]) => void;
	onCodexHostMessage?: (msg: Record<string, unknown>) => void;
	onCopilotHostMessage?: (msg: Record<string, unknown>) => void;
	sessionStore?: SessionStore;
	auth?: SessionAuthority;
	presenceWriter?: {
		establishOnConfirm: SessionStore["establishOnConfirm"];
		clearLive: SessionStore["clearLive"];
	};
	announcePresenceDirty?: () => void;
}

export interface WsData {
	teamName: string | null;
	subId: string;
	conversationId: string | null;
	mode: ConnectionMode;
	version?: string;
	claudeSessionId?: string;
	cwdName?: string;
	boundToken?: string;
	missedPings: number;
	isStale: boolean;
	handshakeConfirmed: boolean;
	proxyProject?: string;
	proxyAuth?: string;
	virtual?: boolean;
	// Protocol 1 requires delivery acknowledgements.
	deliveryProtocol?: number;
}

export const RESERVED_TEAM_NAMES = new Set(["host"]);

// Bounds waiting for post-wake registration.
export const REGISTER_WINDOW_MS = 60_000;

// Covers post-wake registration and duplicate delivery.
export const HANDSHAKE_REPUSH_DEDUPE_MS = 30_000;

// Caps prompts because conversationId is spoofable.
export const HANDSHAKE_REPUSH_MAX_ATTEMPTS = 5;

// Lets late answers confirm while expiring reply blocking.
export const HANDSHAKE_PENDING_TTL_MS = 600_000;

export type HandshakeRepushOutcome = "pushed" | "throttled" | "capped" | "no-pending" | "socket-gone";

export function getAllActiveWs(subs: Map<string, ServerWebSocket<WsData>>): ServerWebSocket<WsData>[] {
	const result: ServerWebSocket<WsData>[] = [];
	for (const [, ws] of subs) {
		if (ws.readyState === 1) result.push(ws);
	}
	return result;
}

export function getAllActiveRealWs(subs: Map<string, ServerWebSocket<WsData>>): ServerWebSocket<WsData>[] {
	return getAllActiveWs(subs).filter((ws) => !ws.data.virtual);
}

export function resolveLiveIncarnation(
	registry: TeamRegistry,
	sessionStore: SessionStore | undefined,
	team: string,
): ServerWebSocket<WsData> | undefined {
	const canonical = getAllActiveRealWs(registry.get(team) ?? new Map());
	const confirmedCanonical = canonical.find((s) => s.data.handshakeConfirmed);
	if (confirmedCanonical) return confirmedCanonical;
	const alias = sessionStore?.resolveLive(team);
	if (alias) {
		const s = registry.get(alias.team)?.get(alias.subId);
		// Require the stamped incarnation to remain confirmed.
		if (s && s.readyState === 1 && !s.data.virtual && s.data.handshakeConfirmed) return s;
	}
	return canonical[0];
}
