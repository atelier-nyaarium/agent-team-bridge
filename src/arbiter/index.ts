import fs from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { DomainSnapshotSchema, signRegister } from "../shared/admission.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { resolveLocalHostId } from "../shared/host-id.js";
import { getMutex, type Mutex } from "../shared/mutex.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { startEvieClient } from "./evie/evieClient.js";
import { startPortForward } from "./evie/portForward.js";
import { Allowlist } from "./federation/allowlist.js";
import { logAdmitHostQr } from "./federation/enrollQr.js";
import { createHostRelayHandler, createHostRelayPump } from "./federation/hostRelay.js";
import { loadOrCreateIdentity } from "./federation/identity.js";
import { createSealer, type Sealer } from "./federation/sealer.js";
import { createPhoneHandler } from "./phone/phoneHandler.js";
import { createPhoneRelayPump } from "./phone/relayPump.js";
import { createRoutes } from "./routes.js";
import { WakeCoordinator } from "./wake.js";
import { createWebSocketHandlers, type WsData } from "./websocket.js";

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
	const localHostId = resolveLocalHostId();
	console.log(`[arbiter] Host id: ${localHostId}`);
	const HEARTBEAT_INTERVAL_MS = 30000;
	const MISSED_PINGS_LIMIT = 2;

	const registry = new Map<string, Map<string, ServerWebSocket<WsData>>>();
	const conversationRegistry = new Map<string, ServerWebSocket<WsData>>();
	const store = new PendingJobStore<ResponsePayload>();
	const targetLocks = new Map<string, Mutex>();
	const knownTeamPaths = new Map<string, string>();
	const offlineCatalog = new Map<string, string>();
	const wakeCoordinator = new WakeCoordinator();

	// Phone bridge: per-install mailboxes drained by the phone's poll op. The
	// handler is constructed after routes exist; relay frames arriving before
	// that are dropped (the phone re-polls).
	const mailboxStore = new DeviceMailboxStore();
	// Takes unknown: the relay pump owns the full frame validation.
	let handlePhoneRelay: ((frame: unknown) => void) | null = null;
	// Cross-Host frames the Router switched to this Host; the host-relay pump owns
	// full validation.
	let handleHostRelay: ((frame: unknown) => void) | null = null;
	let evictPhonePeer: ((conversationId: string) => void) | null = null;

	store.startCleanup();
	mailboxStore.startCleanup();

	const getMutexForTeam: MutexAccessor = Object.assign((team: string) => getMutex(targetLocks, team), {
		peek: (team: string) => targetLocks.get(team),
	});

	// Concurrent sends to the same sleeping team must share ONE wake: two
	// parallel `devcontainer up` runs for the same project race each other and
	// both error out, failing sends whose container actually comes up.
	const inflightWakes = new Map<string, Promise<boolean>>();

	function tryWakeTeam(team: string): Promise<boolean> {
		const existing = inflightWakes.get(team);
		if (existing) {
			console.log(`[wake] ${team} wake already in flight; joining it`);
			return existing;
		}
		const wake = doWakeTeam(team);
		inflightWakes.set(team, wake);
		void wake.finally(() => inflightWakes.delete(team));
		return wake;
	}

	async function doWakeTeam(team: string): Promise<boolean> {
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
	let sealer: Sealer | null = null;

	if (evieAuthToken) {
		// Load this Host's federation identity + mirrored allowlist from its volume,
		// and build the E2E sealer (cross-Host frames are sealed peer-to-peer).
		const federationDir = process.env.FEDERATION_DIR || path.join(path.dirname(LOG_PATH), "federation");
		// Pin the owner root out-of-band so a malicious/token-holding evie cannot root
		// this Host at an attacker key via the mirror (the snapshot is relayed through
		// untrusted evie). Unset = trust-on-first-use.
		const allowlist = new Allowlist(federationDir, process.env.FEDERATION_OWNER_SIGN_PUB);
		const identity = loadOrCreateIdentity(federationDir);
		sealer = createSealer(identity, allowlist);
		console.log(`[federation] ${allowlist.ownerSignPub ? "enrolled" : "not yet enrolled (no Domain owner)"}`);
		// Not admitted yet: print the admit-host QR so the owner can scan this Host
		// into the Domain. Once admitted (mirrored from evie), this falls silent.
		if (!allowlist.selfAdmission(identity.sign.pub)) logAdmitHostQr(identity, localHostId);

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
			hostId: localHostId,
			onPhoneRelay: (frame) => {
				handlePhoneRelay?.(frame);
			},
			onHostRelay: (frame) => {
				handleHostRelay?.(frame);
			},
			onDomainSync: (domain) => {
				// evie mirrors the owner root + allowlist on each register reply; apply
				// the owner-verified snapshot so this Host enforces revocations locally.
				const parsed = DomainSnapshotSchema.safeParse(domain);
				if (!parsed.success) {
					console.warn(`[federation] dropped malformed domain sync: ${parsed.error.issues[0]?.message}`);
					return;
				}
				allowlist.applySnapshot(parsed.data);
				console.log(`[federation] domain sync applied (${parsed.data.admissions.length} admissions)`);
			},
			buildRegisterAuth: () => {
				// Present this Host's owner-signed admission + a fresh possession proof,
				// so evie can gate registration once a Domain owner exists. Null (token
				// only) until enrollment writes the self-admission into the allowlist.
				const self = allowlist.selfAdmission(identity.sign.pub);
				if (!self) return null;
				const proofAt = Date.now();
				return {
					signPub: identity.sign.pub,
					boxPub: identity.box.pub,
					admission: JSON.stringify(self),
					proof: signRegister(localHostId, proofAt, identity.sign.priv),
					proofAt,
				};
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
		onVirtualPeerEvicted: (conversationId) => {
			evictPhonePeer?.(conversationId);
		},
	});

	const routes = createRoutes({
		registry,
		conversationRegistry,
		store,
		getMutex: getMutexForTeam,
		config: { LOG_PATH, RESPONSE_TIMEOUT_MS, localHostId },
		tryWakeTeam,
		offlineCatalog,
		knownTeamPaths,
		mailboxStore,
		evieClient,
		sealer,
		resolveHandshake: wsHandlers.resolveHandshake,
	});

	if (evieClient) {
		const phoneHandler = createPhoneHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			routes,
			localHostId,
			isProjectName: (name) => offlineCatalog.has(name) || knownTeamPaths.has(name),
		});
		handlePhoneRelay = createPhoneRelayPump({
			handleFrame: phoneHandler.handleFrame,
			sendReply: (reply) =>
				evieClient!.callTool("phone_relay_reply", reply as unknown as Record<string, unknown>),
		});
		evictPhonePeer = (conversationId) => phoneHandler.removePeer(conversationId);

		// Federation: a peer Host's frames land here, run against the local routes,
		// and the reply routes home through the Router.
		const hostRelayHandler = createHostRelayHandler({ routes, tryWakeTeam });
		handleHostRelay = createHostRelayPump({
			sealer: sealer!,
			handleOp: hostRelayHandler.handleOp,
			sendReply: (reply) => evieClient!.callTool("host_relay_reply", reply as unknown as Record<string, unknown>),
		});
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
		if (method === "GET" && url.pathname === "/discover") return routes.discover();
		if (method === "POST" && url.pathname === "/send") return routes.send(req, body);
		if (method === "POST" && url.pathname === "/respond") return routes.respond(req, body);
		if (method === "POST" && url.pathname === "/poll") return routes.poll(req, body);
		if (method === "GET" && url.pathname === "/health") return routes.health();
		if (method === "POST" && url.pathname === "/evie/tool-call") return routes.evieToolCall(req, body);
		if (method === "POST" && url.pathname === "/human/notify") return routes.humanNotify(body);

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
