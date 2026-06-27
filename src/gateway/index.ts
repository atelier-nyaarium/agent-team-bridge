import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { DomainSnapshotSchema, signRegister } from "../shared/admission.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { DOMAIN_ID_FILE, resolveLocalDomainId } from "../shared/domain-id.js";
import { DurableStore } from "../shared/durable-store.js";
import { resolveLocalGatewayId } from "../shared/gateway-id.js";
import type { HostOp, HostOpResult } from "../shared/host-op.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import { isComposite } from "../shared/session-id.js";
import type { ResponsePayload } from "../shared/types.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { createConsoleDispatcher } from "./console/consoleHandler.js";
import { type ConsoleSealer, createConsoleSealer } from "./console/consoleSealer.js";
import { createConsoleRelayPump } from "./console/relayPump.js";
import { startEvieClient } from "./evie/evieClient.js";
import { type EvieTransport, evieWsConnection, loadEvieTransport } from "./evie/transport.js";
import { Allowlist } from "./federation/allowlist.js";
import { openBootstrapBundle } from "./federation/bootstrapInstall.js";
import {
	CrossDomainHandshakeCoordinator,
	createCrossDomainHandshakePump,
	parseCommitReply,
	parseRevealReply,
} from "./federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "./federation/crossDomainPeers.js";
import { CrossDomainShareState } from "./federation/crossDomainShareState.js";
import {
	type AdmitGatewayPayload,
	admitGatewayPayload,
	type EnrollDelivery,
	logAdmitGatewayQr,
} from "./federation/enrollQr.js";
import { generateEnrollCert } from "./federation/enrollTls.js";
import { createGatewayRelayHandler, createGatewayRelayPump } from "./federation/gatewayRelay.js";
import { loadOrCreateIdentity } from "./federation/identity.js";
import { ReplayGuard } from "./federation/replayGuard.js";
import { createSealer, type Sealer } from "./federation/sealer.js";
import { HostOpCoordinator } from "./hostOpCoordinator.js";
import { createRoutes } from "./routes.js";
import { WakeCoordinator } from "./wake.js";
import { createWebSocketHandlers, type WsData } from "./websocket.js";

////////////////////////////////
//  Functions & Helpers

export async function startGateway(): Promise<void> {
	const PORT = parseInt(process.env.PORT || "20000", 10);
	// The arming-only pinned-TLS listener for the phone's LAN bundle delivery (see the arming block).
	const ENROLL_TLS_PORT = parseInt(process.env.ENROLL_TLS_PORT || "20003", 10);
	const LOG_PATH = path.join("/app", "log", "debug.log");

	// Clear debug log on startup so it only contains entries from this run
	try {
		const dir = path.dirname(LOG_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(LOG_PATH, "");
	} catch {}

	// Durable state (federation private keys, pending-jobs, mailboxes, replay-guard, the session
	// resume map) lives in DATA_DIR, deliberately SEPARATE from the debug-log dir so a "clear the
	// logs" action can never wipe federation identity.
	const DATA_DIR = process.env.DATA_DIR || "/app/data";
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		// TODO(remove after a few days, ~2026-07): one-time migration of durable state that used to
		// live beside debug.log into DATA_DIR. Copies each item only if absent there (runs once, never
		// clobbers newer data, must not lose federation keys). Delete once all gateways have migrated.
		const legacyDir = path.dirname(LOG_PATH);
		for (const item of ["federation", "pending-jobs.json", "mailboxes.json", "replay-guard.json"]) {
			const src = path.join(legacyDir, item);
			const dst = path.join(DATA_DIR, item);
			if (fs.existsSync(src) && !fs.existsSync(dst)) {
				fs.cpSync(src, dst, { recursive: true });
				console.log(`[data-migrate] moved ${item} to ${DATA_DIR}`);
			}
		}
	} catch (err) {
		console.error("[data-migrate] migration to DATA_DIR failed:", err);
	}

	const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || "600000", 10);
	const WAKE_TIMEOUT_MS = parseInt(process.env.WAKE_TIMEOUT_MS || "600000", 10);
	const localGatewayId = resolveLocalGatewayId();
	console.log(`[gateway] Gateway id: ${localGatewayId}`);
	// The Gateway persists its federation identity, mirrored allowlist, and the enrollment-delivered
	// transport.json + domain-id under this dir (inside DATA_DIR, separate from the debug log).
	const federationDir = process.env.FEDERATION_DIR || path.join(DATA_DIR, "federation");
	let localDomainId = resolveLocalDomainId(federationDir);
	console.log(`[gateway] Domain id: ${localDomainId ?? "(none - not yet enrolled)"}`);
	const HEARTBEAT_INTERVAL_MS = 30000;
	const MISSED_PINGS_LIMIT = 2;

	const registry = new Map<string, Map<string, ServerWebSocket<WsData>>>();
	const conversationRegistry = new Map<string, ServerWebSocket<WsData>>();
	const store = new PendingJobStore<ResponsePayload>();
	const knownTeamPaths = new Map<string, string>();
	const offlineCatalog = new Map<string, string>();
	const wakeCoordinator = new WakeCoordinator();
	const hostOpCoordinator = new HostOpCoordinator();

	// Console bridge: per-install mailboxes drained by the console's poll op. The
	// handler is constructed after routes exist; relay frames arriving before
	// that are dropped (the console re-polls).
	const mailboxStore = new DeviceMailboxStore();
	// Takes unknown: the relay pump owns the full frame validation.
	let handleConsoleRelay: ((frame: unknown) => void) | null = null;
	// Cross-Gateway frames the Router routed to this Gateway; the gateway-relay pump owns
	// full validation.
	let handleGatewayRelay: ((frame: unknown) => void) | null = null;
	// Pre-trust cross-Domain handshake frames the Router routed to this Gateway (the
	// receiver leg); the handshake pump owns full validation.
	let handleCrossDomainHandshake: ((frame: unknown) => void) | null = null;
	let evictConsolePeer: ((conversationId: string) => void) | null = null;

	store.startCleanup();
	mailboxStore.startCleanup();

	// In-memory delivery state otherwise vanishes on restart, 404ing replies and losing queued
	// mail. Snapshot the persistent job anchors and device mailboxes (each box keeps its epoch so
	// the console's durable cursor still matches) to DATA_DIR, reload on boot, re-save on a timer.
	const jobsDurable = new DurableStore(DATA_DIR, "pending-jobs");
	const mailboxDurable = new DurableStore(DATA_DIR, "mailboxes");
	// team -> the session's Claude harness id, so a later wake can `claude --resume <id>` it.
	const sessionResume = new Map<string, { claudeSessionId: string; lastSeen: number }>();
	const sessionResumeDurable = new DurableStore(DATA_DIR, "session-resume");
	try {
		const jobs = jobsDurable.load();
		if (Array.isArray(jobs)) store.restore(jobs as Parameters<typeof store.restore>[0]);
		const boxes = mailboxDurable.load();
		if (boxes && typeof boxes === "object")
			mailboxStore.restore(boxes as Parameters<typeof mailboxStore.restore>[0]);
		const resume = sessionResumeDurable.load();
		if (resume && typeof resume === "object")
			for (const [team, v] of Object.entries(
				resume as Record<string, { claudeSessionId: string; lastSeen: number }>,
			))
				sessionResume.set(team, v);
	} catch (err) {
		// A corrupt or partial snapshot must not crash-loop boot; start from empty delivery state.
		console.error("[durability] restore failed, starting fresh:", err);
	}
	console.log(`[durability] restored jobs=${store.size} mailboxes=${mailboxStore.size} resume=${sessionResume.size}`);
	// The federation replay-guard wires its own persistence here once built (it only
	// exists when the evie bridge is configured); null-safe until then.
	let replayPersist: (() => void) | null = null;
	const persistDelivery = () => {
		jobsDurable.save(store.snapshot());
		mailboxDurable.save(mailboxStore.snapshot());
		sessionResumeDurable.save(Object.fromEntries(sessionResume));
		replayPersist?.();
	};
	const persistTimer = setInterval(persistDelivery, 3_000);
	persistTimer.unref?.();
	process.on("SIGTERM", persistDelivery);
	process.on("SIGINT", persistDelivery);
	// An uncaughtException can fire mid-mutation, so the in-memory store may be inconsistent right
	// now. Do NOT flush it - that would overwrite the last good snapshot with crash-moment state.
	// Just log and exit: the last quiescent persist-timer/SIGTERM snapshot is consistent, and the
	// docker restart policy restores from it. Boot restore is guarded so a bad snapshot cannot loop.
	process.on("uncaughtException", (err) => {
		console.error("[gateway] uncaughtException:", err);
		process.exit(1);
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
		// `.catch` before `.finally` so this cleanup-chain promise resolves; callers still receive
		// the original `wake` (unchanged) and see any rejection via their own await.
		void wake.catch(() => {}).finally(() => inflightWakes.delete(team));
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

	// The host op timeout must EXCEED the host's worst-case work so a succeeding-but-slow op
	// never spuriously times out (a sendText runs two sequential 8s execs = up to 16s, and a
	// timeout on a keystroke send is indeterminate - the retry would re-inject). 20s clears that
	// with margin and still nests well under the console relay hold (evie ~55s, apiserver 60s).
	const HOST_OP_TIMEOUT_MS = 20_000;

	async function relayToHost(op: HostOp): Promise<HostOpResult> {
		const hostSubs = registry.get("host");
		const hostWs = hostSubs ? [...hostSubs.values()].find((ws) => ws.readyState === 1) : undefined;
		if (!hostWs) return { ok: false, error: "host daemon offline - terminal unavailable" };
		const reqId = randomBytes(8).toString("hex");
		hostWs.send(JSON.stringify({ type: "host_op", reqId, op }));
		return hostOpCoordinator.wait(reqId, HOST_OP_TIMEOUT_MS);
	}

	// Start evie-bot bridge if config is present
	let evieClient: ReturnType<typeof startEvieClient> | null = null;
	let sealer: Sealer | null = null;
	let consoleSealer: ConsoleSealer | null = null;
	// Exposed to the console handler (built later) so its poll reply can carry the mirrored
	// keyring + version for the Console's keyring sync.
	let allowlistForConsole: Allowlist | null = null;
	// This Gateway's own Domain lifecycle metadata, learned from evie's gateway_register reply.
	// domainStatus tells the app to first-root vs just-provision; displayName lets teams()/discover
	// show a linked friend Domain the owner's self-set name. Null until the first register.
	let domainMeta: { domainStatus?: string; displayName?: string | null; isAdminDomain?: boolean } | null = null;
	// Cross-Domain handshake coordinator, exposed to the console handler so the cross_domain_*
	// ops drive the mutual pairing. The ONLY writer of the disjoint CrossDomainPeers store.
	let crossDomainCoordinator: CrossDomainHandshakeCoordinator | null = null;
	// Per-session share state: which local sessions are offered to which linked friend Domain.
	// Exposed to the console handler for the cross_domain_share/unshare/list_shares ops.
	let crossDomainShareState: CrossDomainShareState | null = null;
	let crossDomainPeersForConsole: CrossDomainPeers | null = null;
	// A Domain is "trusted/linked" iff this Gateway holds a cross-Domain peer for it (the owner linked
	// it). The single predicate the share gate uses to resolve an everyone-trusted share + to bound a
	// per-Domain share to a real link, so an everyone-trusted share can never reach a non-peer.
	const isLinkedDomain = (domainId: string): boolean =>
		crossDomainPeersForConsole?.all().some((p) => p.friendDomainId === domainId) ?? false;

	const evieTransport = loadEvieTransport(federationDir);

	// The evie bridge activates only with both a delivered transport AND a resolved Domain id;
	// missing either, the gateway stays standalone (no mesh) and serves /health + /enroll.
	function activateFederation(transport: EvieTransport, domainId: string): void {
		localDomainId = domainId;
		// Load this Gateway's federation identity + mirrored allowlist from its volume,
		// and build the E2E sealer (cross-Gateway frames are sealed peer-to-peer).
		const allowlist = new Allowlist(federationDir);
		allowlistForConsole = allowlist;
		// Cross-Domain peers (other owners' Gateways this Gateway has linked with): a
		// DISJOINT store from the single-owner allowlist, written only by the handshake,
		// so a local-Domain sync can never wipe it and it never contaminates intra-Domain
		// resolution. The sealer resolves local peers first, then this set.
		const crossDomainPeers = new CrossDomainPeers(federationDir);
		crossDomainPeersForConsole = crossDomainPeers;
		// Per-session share state: which local sessions are offered to which linked friend
		// Domains, persisted alongside the peer set. Plain gateway-local state (the device's
		// submit op is authenticated by the existing console seal), read by discovery and the
		// relay so an un-share bites without evie.
		crossDomainShareState = new CrossDomainShareState(federationDir);
		const identity = loadOrCreateIdentity(federationDir);
		// Durable replay-guard: persisted across restarts so an authentic sealed frame
		// captured inside the 120s freshness window cannot replay once after a deploy.
		const replayDurable = new DurableStore(DATA_DIR, "replay-guard");
		const replayGuard = new ReplayGuard();
		{
			const persisted = replayDurable.load();
			if (Array.isArray(persisted)) replayGuard.restore(persisted as Array<[string, number]>);
		}
		replayPersist = () => replayDurable.save(replayGuard.snapshot());
		sealer = createSealer(identity, allowlist, localGatewayId, crossDomainPeers, localDomainId, replayGuard);
		// The requester leg routes both commit-reveal rounds through the Router seam below; evie
		// (content-blind) forwards each frame to the receiver Gateway and holds the reply.
		// evieClient is assigned further down in this block, so the seam reads it lazily.
		const routeHandshake = async (
			action: string,
			receiverGatewayId: string,
			payload: unknown,
		): Promise<unknown> => {
			if (!evieClient) throw new Error("the Router is not connected; cannot reach the friend's Gateway");
			const res = await evieClient.callTool(action, {
				handshakeId: randomBytes(18).toString("base64url"),
				srcDomain: localDomainId,
				srcGateway: localGatewayId,
				dstGateway: receiverGatewayId,
				payload,
			});
			if (res.error) throw new Error(res.error);
			const r = res.result as { ok?: boolean; error?: string; result?: unknown } | undefined;
			if (!r?.ok) throw new Error(r?.error ?? "the friend's Gateway did not complete the handshake");
			return r.result;
		};
		crossDomainCoordinator = new CrossDomainHandshakeCoordinator({
			self: {
				ownerSignPub: () => allowlist.ownerSignPub,
				gatewaySignPub: identity.sign.pub,
				gatewayBoxPub: identity.box.pub,
				domainId: localDomainId,
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
		// The console channel rides the SAME durable replay guard + allowlist: a console
		// frame is sealed to this gateway and signed by an admitted console key.
		consoleSealer = createConsoleSealer(identity, allowlist, replayGuard);
		console.log(`[federation] ${allowlist.ownerSignPub ? "enrolled" : "not yet enrolled (no Domain owner)"}`);
		// Not admitted yet: print the admit-gateway QR so the owner can scan this Gateway
		// into the Domain. Once admitted (mirrored from evie), this falls silent.
		if (!allowlist.selfAdmission(identity.sign.pub)) logAdmitGatewayQr(identity, localGatewayId);

		// The service-proxy WS: creds are delivered by enrollment, no kubeconfig mount, and it
		// reaches a behind-NAT evie through the apiserver. The SA token authenticates to the API
		// server (consumed there); the cluster CA is pinned for TLS.
		const connection = evieWsConnection(transport);
		console.log(`[evie] service-proxy transport -> ${transport.apiUrl} (${transport.service}:${transport.port})`);

		evieClient = startEvieClient({
			url: connection.url,
			headers: connection.headers,
			tls: connection.tls,
			gatewayId: localGatewayId,
			domainId: localDomainId,
			onConsoleRelay: (frame) => {
				handleConsoleRelay?.(frame);
			},
			onGatewayRelay: (frame) => {
				handleGatewayRelay?.(frame);
			},
			onCrossDomainHandshake: (frame) => {
				handleCrossDomainHandshake?.(frame);
			},
			onDomainSync: (domain) => {
				// evie mirrors the owner root + allowlist on each register reply; apply
				// the owner-verified snapshot so this Gateway enforces revocations locally.
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
				domainMeta = meta;
			},
			onDomainUpdate: (meta) => {
				// A live rename of the owner's display name: refresh only displayName, preserving
				// the domainStatus from the last register, so teams()/discover reflect the new
				// name immediately without a reconnect.
				domainMeta = { ...(domainMeta ?? {}), displayName: meta.displayName };
			},
			buildRegisterAuth: () => {
				// Present this Gateway's owner-signed admission + a fresh possession proof,
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
					proof: signRegister(localGatewayId, proofAt, proofNonce, identity.sign.priv),
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
		});
	}

	// Creds-less enrollment: when armed with a one-time nonce (setup.sh (Enroll gateway)), mint the
	// identity, print the admit-gateway QR with the LAN target, hold the payload for
	// GET /admit-payload, and accept exactly one sealed bootstrap bundle over POST /enroll.
	let enrollInstall: ((frame: unknown) => string) | null = null;
	let armedAdmitPayload: AdmitGatewayPayload | null = null;
	const enrollNonce = process.env.ENROLL_NONCE;
	if (enrollNonce && !evieTransport) {
		const enrollAllowlist = new Allowlist(federationDir);
		const enrollIdentity = loadOrCreateIdentity(federationDir);
		// The phone delivers the sealed bundle over a pinned-TLS listener the gateway opens only while
		// armed: the bundle is already E2E sealed, so this exists only to satisfy Android's no-cleartext
		// policy without an app-wide permit and to keep the LAN wire private. The phone pins the cert
		// fingerprint carried in the QR; the SAN is the LAN IP, so its hostname check stays on. A
		// non-LAN host (0.0.0.0) mints no cert -> no listener -> the Console enrolls by paste (nonce-gated).
		const enrollLanHost = process.env.ENROLL_LAN_HOST || "0.0.0.0";
		const enrollCert = generateEnrollCert(enrollLanHost);
		let enrollTlsServer: ReturnType<typeof Bun.serve> | null = null;
		const delivery: EnrollDelivery = {
			nonce: enrollNonce,
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
		// Hold the payload in memory for setup.sh to GET /admit-payload over loopback, instead of
		// a root-owned file the host user cannot read.
		armedAdmitPayload = admitGatewayPayload(enrollIdentity, localGatewayId, delivery);
		// The enrollment window closes after a bounded time; the nonce dies with it so a
		// captured QR cannot be redeemed later. Re-arm via setup.sh (Enroll gateway) for a fresh nonce.
		let enrollTimer: ReturnType<typeof setTimeout> | null = null;
		enrollInstall = (frame) => {
			const bundle = openBootstrapBundle(frame, enrollIdentity, enrollNonce, localGatewayId);
			// Persist the owner-signed admission FIRST, then the transport creds: a failure
			// must never leave creds installed without the admission that authorizes them. A
			// foreign-owner re-root is refused, so no creds are written for it.
			if (!enrollAllowlist.applySnapshot(bundle.domain)) {
				throw new Error("bundle is rooted at a different owner than this gateway's Domain");
			}
			fs.writeFileSync(path.join(federationDir, "transport.json"), JSON.stringify(bundle.transport), {
				mode: 0o600,
			});
			// Record the joined Domain so the gateway resolves it now and on any future boot.
			if (bundle.domainId) {
				fs.writeFileSync(path.join(federationDir, DOMAIN_ID_FILE), bundle.domainId, { mode: 0o600 });
			}
			enrollInstall = null;
			armedAdmitPayload = null;
			// Graceful stop (not stop(true)): let the in-flight POST's 200 flush before the listener
			// closes, so the Console sees success instead of a truncated-stream "delivery unreachable".
			enrollTlsServer?.stop();
			enrollTlsServer = null;
			if (enrollTimer) clearTimeout(enrollTimer);
			// no restart: activate evie in-process from the just-installed creds.
			const installedTransport = loadEvieTransport(federationDir);
			const installedDomainId = resolveLocalDomainId(federationDir);
			if (installedTransport && installedDomainId) {
				try {
					activateEvieBridge(installedTransport, installedDomainId);
					console.log(`[enroll] installed credentials for Gateway "${localGatewayId}"; connecting to evie.`);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(
						`[enroll] credentials installed but evie activation failed: ${msg}. Re-run setup.sh (Setup Gateway).`,
					);
				}
			} else {
				// transport.json is now on disk, so a plain restart cannot self-arm; only a re-enroll recovers.
				console.log(
					`[enroll] credentials installed but no Domain id resolved; re-run setup.sh (Setup Gateway).`,
				);
			}
			return localGatewayId;
		};
		enrollTimer = setTimeout(() => {
			if (enrollInstall) {
				enrollInstall = null;
				armedAdmitPayload = null;
				enrollTlsServer?.stop(true);
				enrollTlsServer = null;
				console.log("[enroll] enrollment window expired (~10 min); re-run setup.sh (Enroll gateway)");
			}
		}, 600_000);
		enrollTimer.unref?.();
	}

	// POST /enroll intake, shared by the main HTTP listener (host loopback paste) and the arming-only
	// pinned-TLS listener (the phone's LAN delivery). Gated on enrollInstall, so it 404s off-window.
	function handleEnrollPost(body: Record<string, unknown>): Response {
		if (!enrollInstall) {
			return new Response(JSON.stringify({ ok: false, error: "not in enrollment mode" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		try {
			const gatewayId = enrollInstall(body);
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

	const wsHandlers = createWebSocketHandlers({
		registry,
		conversationRegistry,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT, hostWsToken: process.env.HOST_WS_TOKEN },
		knownTeamPaths,
		offlineCatalog,
		wakeCoordinator,
		hostOpCoordinator,
		onVirtualPeerEvicted: (conversationId) => {
			evictConsolePeer?.(conversationId);
		},
		recordSessionResume: (team, claudeSessionId) =>
			sessionResume.set(team, { claudeSessionId, lastSeen: Date.now() }),
	});

	function buildRoutes() {
		return createRoutes({
			registry,
			conversationRegistry,
			store,
			config: { LOG_PATH, RESPONSE_TIMEOUT_MS, localGatewayId, localDomainId },
			tryWakeTeam,
			offlineCatalog,
			knownTeamPaths,
			mailboxStore,
			evieClient,
			sealer,
			crossDomainPeers: crossDomainPeersForConsole,
			// The owner's display name (from evie's register reply), stamped on every local TeamInfo
			// so a linked friend Domain sees the owner's self-set label. Null until the first register.
			displayName: () => domainMeta?.displayName ?? null,
			// True when this Gateway's own Domain is the admin's (the evie-runner who provisions others).
			// Stamped on the local TeamInfo so the console shows admin surfaces only on the admin's own
			// session. Null (not false) until the first register, so "unknown" stays unknown.
			isAdminDomain: () => domainMeta?.isAdminDomain ?? null,
			// Local-first seal-target resolution on the send side: a target gateway the local
			// allowlist admits seals v1 to the local Domain, mirroring the sealer's open-side ordering, so a
			// local/friend gateway-id collision never routes a local send to the friend.
			resolvesLocalGateway: allowlistForConsole
				? (gatewayId) => allowlistForConsole!.resolveGateway(gatewayId) !== null
				: null,
			// teams() refreshes each online session's cross-Domain shares so presence keeps a
			// share from auto-forgetting; the periodic sweep below reaps only absent sessions.
			touchShares: crossDomainShareState ? (sessionTarget) => crossDomainShareState!.touch(sessionTarget) : null,
			// respond re-reads the per-session share on a cross-Domain reply forward: a send
			// accepted while shared, then un-shared, has its in-flight reply dropped here instead
			// of relayed back to the origin (the un-share bites every direction, not just fresh sends).
			isSharedToForReply: crossDomainShareState
				? (sessionTarget, domainId) =>
						crossDomainShareState!.isSharedTo(sessionTarget, domainId, isLinkedDomain)
				: null,
			resolveHandshake: wsHandlers.resolveHandshake,
		});
	}

	let routes = buildRoutes();

	function activateEvieHandlers(): void {
		const consoleHandler = createConsoleDispatcher({
			registry,
			conversationRegistry,
			mailboxStore,
			routes,
			localGatewayId,
			isProjectName: (name) => !isComposite(name) && (offlineCatalog.has(name) || knownTeamPaths.has(name)),
			domain: () => {
				const snapshot = allowlistForConsole?.getSnapshot() ?? null;
				return snapshot ? { version: allowlistForConsole?.version() ?? "", snapshot } : null;
			},
			// The console register reply carries this Gateway's Domain status (learned from
			// evie's register reply) so the app knows to first-root vs just-provision.
			domainStatus: () => domainMeta?.domainStatus,
			relayToHost,
			crossDomain: crossDomainCoordinator
				? {
						listen: () => crossDomainCoordinator!.listen(),
						request: (args) => crossDomainCoordinator!.request(args),
						confirm: (args) => crossDomainCoordinator!.confirm(args),
						cancel: (args) => crossDomainCoordinator!.cancel(args),
						listenState: (listeningToken) => crossDomainCoordinator!.listenState(listeningToken),
						// The linked-peer roster read from the disjoint cross-Domain peer set, so a
						// freshly-linked peer is listed regardless of online / shared-back state (the
						// console unions these with the discovery-derived Domains). Read fresh each call.
						listPeers: () => ({
							peers: crossDomainPeersForConsole!.all().map((p) => ({
								domainId: p.friendDomainId,
								gatewayId: p.friendGatewayId,
								ownerSignPub: p.friendOwnerSignPub,
							})),
						}),
					}
				: undefined,
			crossDomainShare:
				crossDomainShareState && crossDomainPeersForConsole
					? {
							share: (sessionTarget, target) => crossDomainShareState!.share(sessionTarget, target),
							unshare: (sessionTarget, target) => crossDomainShareState!.unshare(sessionTarget, target),
							// After a successful unshare, settle any in-flight cross-Domain job so an
							// already-accepted send's reply stops at the destination instead of forwarding
							// back to the origin. A specific-Domain unshare scopes to that Domain; an everyone-trusted
							// unshare must settle every Domain it reached, i.e. every currently-linked one.
							expireSessionJobsForTarget: (sessionTarget, target) => {
								const domains =
									target.kind === "domain"
										? [target.domainId]
										: [...new Set(crossDomainPeersForConsole!.all().map((p) => p.friendDomainId))];
								for (const d of domains) store.expireBySession(sessionTarget, d, localGatewayId);
							},
							listShares: () =>
								crossDomainShareState!
									.all()
									.map((s) => ({ sessionTarget: s.sessionTarget, target: s.target })),
							isLinkedDomain,
						}
					: undefined,
			// Unlink a friend Domain: drop the LOCAL trust + share + in-flight state for it.
			// Forgetting the peer makes the sealer refuse both legs on the next frame; dropping
			// shares makes a re-link start from share-nothing; expiring jobs settles them instead
			// of stalling to TTL. Idempotent. The phone separately submits the owner-signed
			// link-edge revocation so the Router drops its relay-affinity edge.
			unlinkDomain:
				crossDomainShareState && crossDomainPeersForConsole
					? (domainId) => ({
							peersRemoved: crossDomainPeersForConsole!.removeByDomain(domainId),
							sharesDropped: crossDomainShareState!.dropDomain(domainId),
							jobsExpired: store.expireByDomain(domainId),
						})
					: undefined,
			// Untrust a PERSON (owner-keyed): forget every peer Gateway owned by that owner across
			// ALL their Domains, then drop the shares + settle the in-flight jobs for those Domains.
			// The owner-keyed sibling of unlinkDomain, summed over the owner's Domains. Idempotent.
			untrustOwner:
				crossDomainShareState && crossDomainPeersForConsole
					? (ownerSignPub) => {
							const { removed, domains } = crossDomainPeersForConsole!.removeByOwner(ownerSignPub);
							let sharesDropped = 0;
							let jobsExpired = 0;
							for (const domainId of domains) {
								sharesDropped += crossDomainShareState!.dropDomain(domainId);
								jobsExpired += store.expireByDomain(domainId);
							}
							return { peersRemoved: removed, sharesDropped, jobsExpired };
						}
					: undefined,
		});
		handleConsoleRelay = createConsoleRelayPump({
			sealer: consoleSealer!,
			handleFrame: consoleHandler.handleFrame,
			sendReply: (reply) =>
				evieClient!.callTool("console_relay_reply", reply as unknown as Record<string, unknown>),
		});
		evictConsolePeer = (conversationId) => consoleHandler.removePeer(conversationId);

		// Federation: a peer Gateway's frames land here, run against the local routes,
		// and the reply routes back to the origin through the Router. The share state gates a
		// cross-Domain op to a shared devcontainer/loose session and filters a
		// cross-Domain caller's list_teams to shared sessions only.
		const gatewayRelayHandler = createGatewayRelayHandler({
			routes,
			tryWakeTeam,
			localGatewayId,
			shareState: crossDomainShareState
				? {
						isSharedTo: (sessionTarget, domainId) =>
							crossDomainShareState!.isSharedTo(sessionTarget, domainId, isLinkedDomain),
						sharesFor: (domainId) => crossDomainShareState!.sharesFor(domainId, isLinkedDomain),
						touch: (sessionTarget) => crossDomainShareState!.touch(sessionTarget),
					}
				: undefined,
			// An inbound cross-Domain reply / colliding re-send is gated on the binding this
			// Gateway recorded when IT created the job (the friend Domain it was routed to /
			// came from), not on the friend-controlled bare gateway id, so a friend cannot
			// forge a reply into another friend's job or hijack an unrelated job's reply route.
			crossDomainBinding: (sessionId) => store.crossDomainBinding(sessionId, localGatewayId),
		});
		handleGatewayRelay = createGatewayRelayPump({
			sealer: sealer!,
			handleOp: gatewayRelayHandler.handleOp,
			sendReply: (reply) =>
				evieClient!.callTool("gateway_relay_reply", reply as unknown as Record<string, unknown>),
		});

		// Cross-Domain handshake (receiver leg): a pre-trust handshake frame the Router
		// routed here runs through the coordinator's receiver leg, and the reply routes back
		// to the requester Gateway through the Router.
		if (crossDomainCoordinator) {
			const coordinator = crossDomainCoordinator;
			handleCrossDomainHandshake = createCrossDomainHandshakePump({
				handleIncomingCommit: (req) => coordinator.handleIncomingCommit(req),
				handleIncomingReveal: (req) => coordinator.handleIncomingReveal(req),
				sendCommitReply: (reply) =>
					evieClient!.callTool("cross_domain_handshake_reply", reply as unknown as Record<string, unknown>),
				sendRevealReply: (reply) =>
					evieClient!.callTool(
						"cross_domain_handshake_reveal_reply",
						reply as unknown as Record<string, unknown>,
					),
			});
		}
	}

	// Per-session share auto-forget: a share whose session has not been seen online for a
	// month is dropped, UNLESS a live cross-Domain thread to that session still exists (a
	// running collaboration must not lose its share mid-stream). teams() touches every live
	// session's shares so presence keeps a share fresh; this timer reaps the absent ones.
	function startShareSweep(): void {
		if (crossDomainShareState && crossDomainPeersForConsole) {
			const share = crossDomainShareState;
			const peers = crossDomainPeersForConsole;
			const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
			// "Live" means RECENTLY ACTIVE, not "ever touched": a persistent anchor refreshes its
			// createdAt on every create + deliver, so a thread idle past this window stops
			// suppressing the auto-forget (otherwise a single stale anchor pins a share forever).
			const isLive = (sessionTarget: string): boolean =>
				store.hasLiveCrossDomainThread(
					sessionTarget,
					(gatewayId) => peers.all().some((p) => p.friendGatewayId === gatewayId),
					localGatewayId,
					THIRTY_DAYS_MS,
				);
			const shareSweepTimer = setInterval(() => {
				const dropped = share.sweep(Date.now(), THIRTY_DAYS_MS, isLive);
				if (dropped > 0) console.log(`[federation] auto-forgot ${dropped} stale cross-Domain share(s)`);
			}, 3_600_000);
			shareSweepTimer.unref?.();
		}
	}

	function activateEvieBridge(transport: EvieTransport, domainId: string): void {
		if (evieClient) return;
		activateFederation(transport, domainId);
		routes = buildRoutes();
		activateEvieHandlers();
		startShareSweep();
	}
	if (evieTransport && localDomainId) activateEvieBridge(evieTransport, localDomainId);

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
			// The payload carries the one-time nonce + box key, so gate it on the nonce the operator
			// armed with: setup.sh has it, a LAN client that never armed does not. A source-IP check
			// would not help - the docker proxy SNATs the host fetch to the bridge gateway anyway.
			const presented = Buffer.from(req.headers.get("x-enroll-nonce") ?? "");
			const expected = Buffer.from(enrollNonce ?? "");
			const authed =
				!!enrollNonce && presented.length === expected.length && timingSafeEqual(presented, expected);
			if (!armedAdmitPayload || !authed) {
				return new Response(JSON.stringify({ ok: false, error: "not in enrollment mode" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(armedAdmitPayload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (method === "POST" && url.pathname === "/ingest") return routes.ingest(req, body);
		if (method === "GET" && url.pathname === "/pending") return routes.pending();
		if (method === "GET" && url.pathname === "/teams") return routes.teams();
		if (method === "GET" && url.pathname === "/discover") return routes.discover();
		if (method === "POST" && url.pathname === "/send") return routes.send(req, body);
		if (method === "POST" && url.pathname === "/respond") return routes.respond(req, body);
		if (method === "POST" && url.pathname === "/poll") return routes.poll(req, body);
		if (method === "GET" && url.pathname === "/health") return routes.health();
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

			// Team/host registration: /bridge
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
				ws.data.missedPings = 0;
			},
		},
	});

	console.log(`[router] listening on :${PORT} (HTTP + WebSocket)`);
}
