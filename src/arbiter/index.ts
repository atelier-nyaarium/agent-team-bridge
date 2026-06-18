import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { DomainSnapshotSchema, signRegister } from "../shared/admission.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { DurableStore } from "../shared/durable-store.js";
import { resolveLocalSwitchId } from "../shared/host-id.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { createConsoleHandler } from "./console/consoleHandler.js";
import { type ConsoleSealer, createConsoleSealer } from "./console/consoleSealer.js";
import { createConsoleRelayPump } from "./console/relayPump.js";
import { startEvieClient } from "./evie/evieClient.js";
import { startPortForward } from "./evie/portForward.js";
import { evieWsConnection, loadEvieTransport } from "./evie/transport.js";
import { Allowlist } from "./federation/allowlist.js";
import { openBootstrapBundle } from "./federation/bootstrapInstall.js";
import { logAdmitSwitchQr } from "./federation/enrollQr.js";
import { createSwitchRelayHandler, createSwitchRelayPump } from "./federation/hostRelay.js";
import { loadOrCreateIdentity } from "./federation/identity.js";
import { ReplayGuard } from "./federation/replayGuard.js";
import { createSealer, type Sealer } from "./federation/sealer.js";
import { createRoutes } from "./routes.js";
import { WakeCoordinator } from "./wake.js";
import { createWebSocketHandlers, type WsData } from "./websocket.js";

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
	const localSwitchId = resolveLocalSwitchId();
	console.log(`[arbiter] Switch id: ${localSwitchId}`);
	const HEARTBEAT_INTERVAL_MS = 30000;
	const MISSED_PINGS_LIMIT = 2;

	const registry = new Map<string, Map<string, ServerWebSocket<WsData>>>();
	const conversationRegistry = new Map<string, ServerWebSocket<WsData>>();
	const store = new PendingJobStore<ResponsePayload>();
	const knownTeamPaths = new Map<string, string>();
	const offlineCatalog = new Map<string, string>();
	const wakeCoordinator = new WakeCoordinator();

	// Console bridge: per-install mailboxes drained by the console's poll op. The
	// handler is constructed after routes exist; relay frames arriving before
	// that are dropped (the console re-polls).
	const mailboxStore = new DeviceMailboxStore();
	// Takes unknown: the relay pump owns the full frame validation.
	let handleConsoleRelay: ((frame: unknown) => void) | null = null;
	// Cross-Switch frames the Router switched to this Switch; the switch-relay pump owns
	// full validation.
	let handleSwitchRelay: ((frame: unknown) => void) | null = null;
	let evictConsolePeer: ((conversationId: string) => void) | null = null;

	store.startCleanup();
	mailboxStore.startCleanup();

	// Durability: the in-memory delivery state otherwise vanishes on a restart/deploy -
	// 404ing a reply ("no pending request") and losing queued mail. Snapshot the
	// persistent job anchors + the device mailboxes (each box keeps its epoch, so the
	// console's durable cursor still matches) to /app/log (a bind-mount that survives the
	// container rebuild); reload on boot; re-save on a timer and on shutdown.
	const jobsDurable = new DurableStore(path.dirname(LOG_PATH), "pending-jobs");
	const mailboxDurable = new DurableStore(path.dirname(LOG_PATH), "mailboxes");
	{
		const jobs = jobsDurable.load();
		if (Array.isArray(jobs)) store.restore(jobs as Parameters<typeof store.restore>[0]);
		const boxes = mailboxDurable.load();
		if (boxes && typeof boxes === "object")
			mailboxStore.restore(boxes as Parameters<typeof mailboxStore.restore>[0]);
		console.log(`[durability] restored jobs=${store.size} mailboxes=${mailboxStore.size}`);
	}
	// The federation replay-guard wires its own persistence here once built (it only
	// exists when the evie bridge is configured); null-safe until then.
	let replayPersist: (() => void) | null = null;
	const persistDelivery = () => {
		jobsDurable.save(store.snapshot());
		mailboxDurable.save(mailboxStore.snapshot());
		replayPersist?.();
	};
	const persistTimer = setInterval(persistDelivery, 3_000);
	persistTimer.unref?.();
	process.on("SIGTERM", persistDelivery);
	process.on("SIGINT", persistDelivery);

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
	let consoleSealer: ConsoleSealer | null = null;
	// Exposed to the console handler (built in a later block) so its poll reply can carry
	// the mirrored keyring + version for the Console's keyring sync.
	let allowlistForConsole: Allowlist | null = null;

	// The Switch persists its federation identity + mirrored allowlist here; an enrolled
	// Switch also drops its service-proxy transport.json here. The bridge activates on
	// either a delivered transport or the legacy BRIDGE_TOKEN.
	const federationDir = process.env.FEDERATION_DIR || path.join(path.dirname(LOG_PATH), "federation");
	const evieTransport = loadEvieTransport(federationDir);

	if (evieAuthToken || evieTransport) {
		// Load this Switch's federation identity + mirrored allowlist from its volume,
		// and build the E2E sealer (cross-Switch frames are sealed peer-to-peer).
		// Pin the owner root out-of-band so a malicious/token-holding evie cannot root
		// this Switch at an attacker key via the mirror (the snapshot is relayed through
		// untrusted evie). Unset = trust-on-first-use.
		const allowlist = new Allowlist(
			federationDir,
			process.env.FEDERATION_OWNER_SIGN_PUB,
			process.env.FEDERATION_REQUIRE_OWNER_PIN === "true",
		);
		allowlistForConsole = allowlist;
		const identity = loadOrCreateIdentity(federationDir);
		// Durable replay-guard: persisted across restarts so an authentic sealed frame
		// captured inside the 120s freshness window cannot replay once after a deploy.
		const replayDurable = new DurableStore(path.dirname(LOG_PATH), "replay-guard");
		const replayGuard = new ReplayGuard();
		{
			const persisted = replayDurable.load();
			if (Array.isArray(persisted)) replayGuard.restore(persisted as Array<[string, number]>);
		}
		replayPersist = () => replayDurable.save(replayGuard.snapshot());
		sealer = createSealer(identity, allowlist, localSwitchId, replayGuard);
		// The console channel rides the SAME durable replay guard + allowlist: a console
		// frame is sealed to this arbiter and signed by an admitted console key.
		consoleSealer = createConsoleSealer(identity, allowlist, replayGuard);
		console.log(`[federation] ${allowlist.ownerSignPub ? "enrolled" : "not yet enrolled (no Domain owner)"}`);
		// Not admitted yet: print the admit-switch QR so the owner can scan this Switch
		// into the Domain. Once admitted (mirrored from evie), this falls silent.
		if (!allowlist.selfAdmission(identity.sign.pub)) logAdmitSwitchQr(identity, localSwitchId);

		// Two transports: the service-proxy WS (preferred - creds are delivered by
		// enrollment, no kubeconfig mount, reaches a home-NAT evie through the apiserver)
		// or the legacy kubectl port-forward tunnel gated on BRIDGE_TOKEN.
		let portForward: ReturnType<typeof startPortForward> | null = null;
		let connection: { url: string; headers: Record<string, string>; tls?: { ca: string } };
		if (evieTransport) {
			connection = evieWsConnection(evieTransport);
			console.log(
				`[evie] service-proxy transport -> ${evieTransport.apiUrl} (${evieTransport.service}:${evieTransport.port})`,
			);
		} else {
			portForward = startPortForward({
				kubeconfig: evieKubeconfig,
				namespace: evieNamespace,
				deploymentLabel: evieDeploymentLabel,
				remotePort: eviePort,
				localPort: evieLocalPort,
			});
			// Port-forward needs a moment before the tunnel is ready
			await new Promise((r) => setTimeout(r, 3_000));
			connection = {
				url: `ws://localhost:${evieLocalPort}`,
				headers: { Authorization: `Bearer ${evieAuthToken}` },
			};
		}

		evieClient = startEvieClient({
			url: connection.url,
			headers: connection.headers,
			tls: connection.tls,
			switchId: localSwitchId,
			onConsoleRelay: (frame) => {
				handleConsoleRelay?.(frame);
			},
			onSwitchRelay: (frame) => {
				handleSwitchRelay?.(frame);
			},
			onDomainSync: (domain) => {
				// evie mirrors the owner root + allowlist on each register reply; apply
				// the owner-verified snapshot so this Switch enforces revocations locally.
				const parsed = DomainSnapshotSchema.safeParse(domain);
				if (!parsed.success) {
					console.warn(`[federation] dropped malformed domain sync: ${parsed.error.issues[0]?.message}`);
					return;
				}
				allowlist.applySnapshot(parsed.data);
				console.log(`[federation] domain sync applied (${parsed.data.admissions.length} admissions)`);
			},
			buildRegisterAuth: () => {
				// Present this Switch's owner-signed admission + a fresh possession proof,
				// so evie can gate registration once a Domain owner exists. Null (token
				// only) until enrollment writes the self-admission into the allowlist.
				const self = allowlist.selfAdmission(identity.sign.pub);
				if (!self) return null;
				const proofAt = Date.now();
				const proofNonce = randomBytes(18).toString("base64");
				return {
					signPub: identity.sign.pub,
					boxPub: identity.box.pub,
					admission: JSON.stringify(self),
					proof: signRegister(localSwitchId, proofAt, proofNonce, identity.sign.priv),
					proofAt,
					proofNonce,
				};
			},
			onDisconnect: () => {
				console.error(`[evie] disconnected from evie-bot`);
			},
		});

		process.on("SIGTERM", () => {
			evieClient?.stop();
			portForward?.stop();
		});
	}

	// Creds-less enrollment: when armed with a one-time nonce (start-arbiter.sh --enroll)
	// and not yet admitted, mint the identity, print the admit-switch QR with the LAN
	// target, and accept exactly one sealed bootstrap bundle over POST /enroll.
	let enrollInstall: ((frame: unknown) => string) | null = null;
	const enrollNonce = process.env.ENROLL_NONCE;
	if (enrollNonce && !evieAuthToken && !evieTransport) {
		const enrollAllowlist = new Allowlist(
			federationDir,
			process.env.FEDERATION_OWNER_SIGN_PUB,
			process.env.FEDERATION_REQUIRE_OWNER_PIN === "true",
		);
		const enrollIdentity = loadOrCreateIdentity(federationDir);
		if (!enrollAllowlist.selfAdmission(enrollIdentity.sign.pub)) {
			logAdmitSwitchQr(enrollIdentity, localSwitchId, {
				host: process.env.ENROLL_LAN_HOST || "0.0.0.0",
				port: PORT,
				nonce: enrollNonce,
			});
			// The enrollment window closes after a bounded time; the nonce dies with it so a
			// captured QR cannot be redeemed later. Re-run --enroll for a fresh nonce.
			let enrollTimer: ReturnType<typeof setTimeout> | null = null;
			enrollInstall = (frame) => {
				const bundle = openBootstrapBundle(frame, enrollIdentity, enrollNonce, localSwitchId);
				// Persist the owner-signed admission FIRST, then the transport creds: a failure
				// must never leave creds installed without the admission that authorizes them.
				enrollAllowlist.applySnapshot(bundle.domain);
				fs.writeFileSync(path.join(federationDir, "transport.json"), JSON.stringify(bundle.transport), {
					mode: 0o600,
				});
				enrollInstall = null;
				if (enrollTimer) clearTimeout(enrollTimer);
				console.log(
					`[enroll] installed credentials for Switch "${localSwitchId}". Restart the arbiter to connect.`,
				);
				return localSwitchId;
			};
			enrollTimer = setTimeout(() => {
				if (enrollInstall) {
					enrollInstall = null;
					console.log("[enroll] enrollment window expired (~10 min); re-run start-arbiter.sh --enroll");
				}
			}, 600_000);
			enrollTimer.unref?.();
		}
	}

	const wsHandlers = createWebSocketHandlers({
		registry,
		conversationRegistry,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT },
		knownTeamPaths,
		offlineCatalog,
		wakeCoordinator,
		onVirtualPeerEvicted: (conversationId) => {
			evictConsolePeer?.(conversationId);
		},
	});

	const routes = createRoutes({
		registry,
		conversationRegistry,
		store,
		config: { LOG_PATH, RESPONSE_TIMEOUT_MS, localSwitchId },
		tryWakeTeam,
		offlineCatalog,
		knownTeamPaths,
		mailboxStore,
		evieClient,
		sealer,
		resolveHandshake: wsHandlers.resolveHandshake,
	});

	if (evieClient) {
		const consoleHandler = createConsoleHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			routes,
			localSwitchId,
			isProjectName: (name) => offlineCatalog.has(name) || knownTeamPaths.has(name),
			domain: () => {
				const snapshot = allowlistForConsole?.getSnapshot() ?? null;
				return snapshot ? { version: allowlistForConsole?.version() ?? "", snapshot } : null;
			},
		});
		handleConsoleRelay = createConsoleRelayPump({
			sealer: consoleSealer!,
			handleFrame: consoleHandler.handleFrame,
			sendReply: (reply) =>
				evieClient!.callTool("console_relay_reply", reply as unknown as Record<string, unknown>),
		});
		evictConsolePeer = (conversationId) => consoleHandler.removePeer(conversationId);

		// Federation: a peer Switch's frames land here, run against the local routes,
		// and the reply routes home through the Router.
		const switchRelayHandler = createSwitchRelayHandler({ routes, tryWakeTeam });
		handleSwitchRelay = createSwitchRelayPump({
			sealer: sealer!,
			handleOp: switchRelayHandler.handleOp,
			sendReply: (reply) =>
				evieClient!.callTool("switch_relay_reply", reply as unknown as Record<string, unknown>),
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

		if (method === "POST" && url.pathname === "/enroll") {
			if (!enrollInstall) {
				return new Response(JSON.stringify({ ok: false, error: "not in enrollment mode" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			}
			try {
				const switchId = enrollInstall(body);
				return new Response(JSON.stringify({ ok: true, switchId }), {
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
