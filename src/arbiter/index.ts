import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { debugLog } from "../shared/debug-log.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { getMutex, type Mutex } from "../shared/mutex.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { PhoneRelayFrame } from "../shared/phone-protocol.js";
import { ChannelFilesSchema } from "../shared/schemas.js";
import type { ChannelFile, ChannelPushPayload, ResponsePayload } from "../shared/types.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { type DmForwardPayload, startEvieClient } from "./evie/evieClient.js";
import { startPortForward } from "./evie/portForward.js";
import { createPhoneHandler } from "./phone/phoneHandler.js";
import { createPhoneRelayPump } from "./phone/relayPump.js";
import { createRoutes } from "./routes.js";
import { WakeCoordinator } from "./wake.js";
import {
	createWebSocketHandlers,
	formatHolderConnectedMessage,
	getAllActiveRealWs,
	getAllActiveWs,
	type WsData,
} from "./websocket.js";

// Mirrors evie-bot's MessageHandler.BRIDGE_BYTES_HARD_BACKSTOP. Caps total raw
// bytes (post-decode) per inbound DM so a compromised or buggy bridge cannot
// flood the host MCP plugin into materializing arbitrary amounts of data.
const FILES_BYTES_HARD_BACKSTOP = 500 * 1024 * 1024;

/**
 * Validate the inbound files array from a `dm_forward` frame and apply the
 * consumer-side hard backstop. Malformed entries are dropped silently with a
 * console warning. Entries that would push the total decoded byte count past
 * the backstop are demoted to metadata-only (`base64` stripped) so the agent
 * can still see them via `evie_fetch_message_files`.
 */
function sanitizeInboundFiles(raw: unknown): ChannelFile[] | undefined {
	if (raw === undefined) return undefined;
	const parsed = ChannelFilesSchema.safeParse(raw);
	if (!parsed.success) {
		console.error(`[evie] dropping malformed files payload: ${parsed.error.message}`);
		return undefined;
	}
	let bytesQueued = 0;
	return parsed.data.map((file) => {
		if (!file.base64) return file;
		// file.size is Discord-reported and validated by ChannelFileSchema. Trust it
		// for the backstop check rather than re-deriving from base64 length, which
		// would overcount by padding bytes.
		if (file.size > FILES_BYTES_HARD_BACKSTOP || bytesQueued + file.size > FILES_BYTES_HARD_BACKSTOP) {
			console.error(`[evie] file "${file.filename}" exceeds backstop; demoting to metadata-only`);
			return { ...file, base64: undefined };
		}
		bytesQueued += file.size;
		return file;
	});
}

////////////////////////////////
//  Interfaces & Types

interface MutexAccessor {
	(team: string): Mutex;
	peek: (team: string) => Mutex | undefined;
}

////////////////////////////////
//  Functions & Helpers

export async function startArbiter(): Promise<void> {
	const PORT = parseInt(process.env.PORT || "20000", 10);
	const LOG_PATH = path.join("/app", "log", "debug.log");

	// Clear debug log on startup so it only contains entries from this run
	try {
		const dir = path.dirname(LOG_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(LOG_PATH, "");
	} catch {}

	const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || "600000", 10);
	const WAKE_TIMEOUT_MS = parseInt(process.env.WAKE_TIMEOUT_MS || "600000", 10);
	const HEARTBEAT_INTERVAL_MS = 30000;
	const MISSED_PINGS_LIMIT = 2;

	const registry = new Map<string, Map<string, ServerWebSocket<WsData>>>();
	const conversationRegistry = new Map<string, ServerWebSocket<WsData>>();
	const store = new PendingJobStore<ResponsePayload>();
	const targetLocks = new Map<string, Mutex>();
	const knownTeamPaths = new Map<string, string>();
	const offlineCatalog = new Map<string, string>();
	const wakeCoordinator = new WakeCoordinator();

	// Human-channel routing state. Pin is the team holding a given Discord channel;
	// null/missing means no holder, and the next inbound DM or outbound respond_to_human
	// call will assign one. sessionToChannel maps every DM/handoff session_id to the
	// channel it originated from so respond_to_human and transfer_human_to can route.
	const pinnedHolders = new Map<string, string | null>();
	const sessionToChannel = new Map<string, string>();

	// Phone bridge: per-install mailboxes drained by the phone's poll op. The
	// handler is constructed after routes exist; relay frames arriving before
	// that are dropped (the phone re-polls).
	const mailboxStore = new DeviceMailboxStore();
	let handlePhoneRelay: ((frame: PhoneRelayFrame) => void) | null = null;
	let evictPhonePeer: ((conversationId: string) => void) | null = null;

	store.startCleanup();
	mailboxStore.startCleanup();

	const getMutexForTeam: MutexAccessor = Object.assign((team: string) => getMutex(targetLocks, team), {
		peek: (team: string) => targetLocks.get(team),
	});

	async function tryWakeTeam(team: string): Promise<boolean> {
		const hostSubs = registry.get("host");
		const hostWs = hostSubs ? [...hostSubs.values()].find((ws) => ws.readyState === 1) : undefined;

		// #region Hypothesis I: check host WebSocket state when wake fires
		const hostSubCount = hostSubs?.size ?? 0;
		const hostWsStates = hostSubs ? [...hostSubs.values()].map((ws) => ws.readyState) : [];
		console.log(
			`[wake] host state: subs=${hostSubCount}, readyStates=[${hostWsStates.join(",")}], foundAlive=${!!hostWs}`,
		);
		// #endregion

		if (!hostWs) {
			console.log(`[wake] cannot wake ${team} - host is not connected`);
			return false;
		}

		const projectPath = knownTeamPaths.get(team);
		hostWs.send(
			JSON.stringify({
				type: "wake",
				team,
				...(projectPath ? { projectPath } : {}),
			}),
		);

		console.log(`[wake] requesting ${team} startup${projectPath ? ` (${projectPath})` : " (convention)"}`);

		const success = await wakeCoordinator.waitFor(team, WAKE_TIMEOUT_MS);
		console.log(`[wake] ${team} ${success ? "is now online" : "failed to come online"}`);
		return success;
	}

	// Start evie-bot bridge if config is present
	const evieAuthToken = process.env.BRIDGE_TOKEN;
	const evieKubeconfig = process.env.EVIE_KUBECONFIG || "/app/kubeconfig.yaml";
	const evieNamespace = process.env.EVIE_NAMESPACE || "evie-bot";
	const evieDeploymentLabel = process.env.EVIE_DEPLOYMENT_LABEL || "app=evie-bot-app";
	const eviePort = parseInt(process.env.EVIE_BRIDGE_PORT || "20001", 10);
	const evieLocalPort = parseInt(process.env.EVIE_LOCAL_PORT || "20001", 10);

	let evieClient: ReturnType<typeof startEvieClient> | null = null;

	async function postSystemMessageToChannel(channelId: string, text: string): Promise<void> {
		if (!evieClient || !evieClient.isConnected()) {
			console.error(`[human] cannot post to channel ${channelId} - evie offline`);
			return;
		}
		try {
			await evieClient.callTool("post_response", { parts: [text], channelId });
		} catch (err) {
			console.error(`[human] post to channel ${channelId} failed: ${(err as Error).message}`);
		}
	}

	function pickFirstOnlineTeam(): string | null {
		// Prefer the host's channel-mode responder ("arbiter") over the cli-mode
		// wake-listener daemon ("host"). Both run in the same host Claude process,
		// but "arbiter" is the identity that respond_to_human sends from, so pinning
		// it directly keeps the holder check consistent.
		const arbiterSubs = registry.get("arbiter");
		if (arbiterSubs && getAllActiveWs(arbiterSubs).length > 0) return "arbiter";
		const hostSubs = registry.get("host");
		if (hostSubs && getAllActiveWs(hostSubs).length > 0) return "host";
		for (const [name, subs] of registry) {
			if (name === "host" || name === "arbiter") continue;
			// Virtual phone peers are always "online" but have no respond_to_human
			// path; they must never become Discord-channel holders.
			if (getAllActiveRealWs(subs).length > 0) return name;
		}
		return null;
	}

	function clearPinsForTeam(team: string): void {
		for (const [channelId, holder] of pinnedHolders) {
			if (holder === team) {
				pinnedHolders.set(channelId, null);
				console.log(`[human] pin on channel ${channelId} cleared (${team} disconnected)`);
			}
		}
	}

	async function tryDeliverDm(dm: DmForwardPayload): Promise<boolean> {
		const channelId = dm.channelId;
		const files = sanitizeInboundFiles(dm.files);
		let holder = pinnedHolders.get(channelId) ?? null;

		// If the pinned team is no longer online, null the pin so auto-assign runs.
		// Real sockets only: a virtual phone peer is always "online" but cannot
		// hold the human channel.
		if (holder) {
			const subs = registry.get(holder);
			if (!subs || getAllActiveRealWs(subs).length === 0) {
				pinnedHolders.set(channelId, null);
				console.log(`[human] pin on channel ${channelId} cleared (${holder} offline)`);
				holder = null;
			}
		}

		// No pin: pick first-online (host first), commit, and announce.
		if (!holder) {
			holder = pickFirstOnlineTeam();
			if (!holder) {
				debugLog(
					"N",
					"src/arbiter/index.ts:tryDeliverDm",
					"no team online",
					{ userId: dm.userId, channelId, allTeams: [...registry.keys()] },
					"arbiter",
				);
				return false;
			}
			pinnedHolders.set(channelId, holder);
			await postSystemMessageToChannel(channelId, formatHolderConnectedMessage(holder));
		}

		const subs = registry.get(holder);
		const activeWs = subs ? getAllActiveRealWs(subs) : [];
		if (activeWs.length === 0) {
			// Raced with disconnect between auto-assign and send.
			pinnedHolders.set(channelId, null);
			return false;
		}

		const sessionId = crypto.randomUUID();
		sessionToChannel.set(sessionId, channelId);

		const payload: ChannelPushPayload = {
			type: "channel_push",
			from: "discord",
			request_type: "question",
			body: dm.content,
			effort: "standard",
			session_id: sessionId,
			is_follow_up: false,
			discord_message_id: dm.messageId,
			files,
		};

		const serialized = JSON.stringify(payload);
		for (const ws of activeWs) {
			ws.send(serialized);
		}

		debugLog(
			"N",
			"src/arbiter/index.ts:tryDeliverDm",
			"delivered",
			{
				holder,
				channelId,
				sessionId: sessionId.slice(0, 8),
				activeWsCount: activeWs.length,
			},
			"arbiter",
		);

		console.log(`[evie] DM forwarded to ${holder} [${sessionId.slice(0, 8)}...]`);
		return true;
	}

	if (evieAuthToken) {
		const portForward = startPortForward({
			kubeconfig: evieKubeconfig,
			namespace: evieNamespace,
			deploymentLabel: evieDeploymentLabel,
			remotePort: eviePort,
			localPort: evieLocalPort,
		});

		// Port-forward needs a moment before the tunnel is ready
		await new Promise((r) => setTimeout(r, 3_000));

		evieClient = startEvieClient({
			url: `ws://localhost:${evieLocalPort}`,
			authToken: evieAuthToken,
			onToolRegistry: (tools) => {
				console.log(`[evie] received ${tools.length} tools`);
				// Push tool schemas to orchestrator so it can register them dynamically
				const orchestratorSubs = registry.get("arbiter");
				if (orchestratorSubs) {
					const payload = JSON.stringify({ type: "evie_tools", tools });
					for (const ws of getAllActiveWs(orchestratorSubs)) {
						ws.send(payload);
					}
					console.log(`[evie] pushed tool schemas to arbiter`);
				}
			},
			onDmForward: (dm) => {
				void (async () => {
					const delivered = await tryDeliverDm(dm);
					if (delivered) return;
					await postSystemMessageToChannel(
						dm.channelId,
						`No team is currently online to handle this message. Please try again shortly.`,
					);
					console.log(`[evie] DM bounced - no team online [channel ${dm.channelId}]`);
				})();
			},
			onPhoneRelay: (frame) => {
				handlePhoneRelay?.(frame);
			},
			onDisconnect: () => {
				console.error(`[evie] disconnected from evie-bot`);
			},
		});

		process.on("SIGTERM", () => {
			evieClient?.stop();
			portForward.stop();
		});
	}

	const wsHandlers = createWebSocketHandlers({
		registry,
		conversationRegistry,
		store,
		targetLocks,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT },
		knownTeamPaths,
		offlineCatalog,
		wakeCoordinator,
		onTeamConnect: (team, ws) => {
			// When orchestrator connects, push cached evie tools if available
			if (team === "arbiter" && evieClient?.isConnected()) {
				const tools = evieClient.getToolSchemas();
				if (tools.length > 0) {
					ws.send(JSON.stringify({ type: "evie_tools", tools }));
					console.log(`[evie] pushed ${tools.length} cached tool schemas to new arbiter`);
				}
			}
		},
		onTeamDisconnect: (team) => {
			clearPinsForTeam(team);
		},
		onVirtualPeerEvicted: (conversationId) => {
			evictPhonePeer?.(conversationId);
		},
	});

	const routes = createRoutes({
		registry,
		conversationRegistry,
		store,
		getMutex: getMutexForTeam,
		config: { LOG_PATH, RESPONSE_TIMEOUT_MS },
		tryWakeTeam,
		offlineCatalog,
		knownTeamPaths,
		evieClient,
		resolveHandshake: wsHandlers.resolveHandshake,
		pinnedHolders,
		sessionToChannel,
		postSystemMessageToChannel,
	});

	if (evieClient) {
		const phoneHandler = createPhoneHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			routes,
			isProjectName: (name) => offlineCatalog.has(name) || knownTeamPaths.has(name),
		});
		handlePhoneRelay = createPhoneRelayPump({
			handleFrame: phoneHandler.handleFrame,
			sendReply: (reply) =>
				evieClient!.callTool("phone_relay_reply", reply as unknown as Record<string, unknown>),
		});
		evictPhonePeer = (conversationId) => phoneHandler.removePeer(conversationId);
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

		if (method === "POST" && url.pathname === "/ingest") return routes.ingest(req, body);
		if (method === "GET" && url.pathname === "/pending") return routes.pending();
		if (method === "GET" && url.pathname === "/teams") return routes.teams();
		if (method === "POST" && url.pathname === "/send") return routes.send(req, body);
		if (method === "POST" && url.pathname === "/respond") return routes.respond(req, body);
		if (method === "POST" && url.pathname === "/poll") return routes.poll(req, body);
		if (method === "GET" && url.pathname === "/health") return routes.health();
		if (method === "GET" && url.pathname === "/evie/tools") return routes.evieTools();
		if (method === "POST" && url.pathname === "/evie/tool-call") return routes.evieToolCall(req, body);
		if (method === "POST" && url.pathname === "/human/respond") return routes.humanRespond(body);
		if (method === "POST" && url.pathname === "/human/transfer") return routes.humanTransfer(body);

		return new Response("Not Found", { status: 404 });
	}

	Bun.serve<WsData>({
		port: PORT,
		fetch(req, server) {
			const url = new URL(req.url);

			// Connector proxy: /connector/{project}/ws
			const proxyMatch = url.pathname.match(/^\/connector\/([^/]+)\/ws$/);
			if (proxyMatch) {
				const project = proxyMatch[1];
				const authHeader = req.headers.get("Authorization") || "";
				if (
					server.upgrade(req, {
						data: {
							teamName: null,
							subId: "",
							conversationId: null,
							mode: "cli" as const,
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

			// Team/host registration: /bridge
			if (url.pathname === "/bridge") {
				if (
					server.upgrade(req, {
						data: {
							teamName: null,
							subId: "",
							conversationId: null,
							mode: "cli" as const,
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
				ws.data.missedPings = 0;
			},
		},
	});

	console.log(`[router] listening on :${PORT} (HTTP + WebSocket)`);
}
