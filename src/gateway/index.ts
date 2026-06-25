import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { DomainSnapshotSchema, signRegister } from "../shared/admission.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { DOMAIN_ID_FILE, resolveLocalDomainId } from "../shared/domain-id.js";
import { DurableStore } from "../shared/durable-store.js";
import { resolveLocalGatewayId } from "../shared/host-id.js";
import type { HostOp, HostOpResult } from "../shared/host-op.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { createConsoleHandler } from "./console/consoleHandler.js";
import { type ConsoleSealer, createConsoleSealer } from "./console/consoleSealer.js";
import { createConsoleRelayPump } from "./console/relayPump.js";
import { startEvieClient } from "./evie/evieClient.js";
import { evieWsConnection, loadEvieTransport } from "./evie/transport.js";
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
import { ADMIT_PAYLOAD_FILE, admitGatewayPayload, logAdmitGatewayQr } from "./federation/enrollQr.js";
import { createGatewayRelayHandler, createGatewayRelayPump } from "./federation/hostRelay.js";
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
	const LOG_PATH = path.join("/app", "log", "debug.log");

	// Clear debug log on startup so it only contains entries from this run
	try {
		const dir = path.dirname(LOG_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(LOG_PATH, "");
	} catch {}

	const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || "600000", 10);
	const WAKE_TIMEOUT_MS = parseInt(process.env.WAKE_TIMEOUT_MS || "600000", 10);
	const localGatewayId = resolveLocalGatewayId();
	console.log(`[gateway] Gateway id: ${localGatewayId}`);
	// The Gateway persists its federation identity, mirrored allowlist, and the enrollment-delivered
	// transport.json + domain-id under this dir.
	const federationDir = process.env.FEDERATION_DIR || path.join(path.dirname(LOG_PATH), "federation");
	const localDomainId = resolveLocalDomainId(federationDir);
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
	// Exposed to the console handler (built in a later block) so its poll reply can carry
	// the mirrored keyring + version for the Console's keyring sync.
	let allowlistForConsole: Allowlist | null = null;
	// This Gateway's own Domain lifecycle metadata, learned from evie's gateway_register
	// reply (refreshed on every reconnect). The console register reply carries domainStatus
	// so the app knows to first-root vs just-provision; teams()/discover stamp displayName
	// so a linked friend Domain shows the owner's self-set network label. Null until the
	// first register (or against a pre-feature evie that sends neither field).
	let domainMeta: { domainStatus?: string; displayName?: string | null; isAdminDomain?: boolean } | null = null;
	// The cross-Domain listening-mode handshake coordinator (built in the federation block),
	// exposed to the console handler so the cross_domain_* ops drive the mutual pairing. The
	// ONLY writer of the disjoint CrossDomainPeers store.
	let crossDomainCoordinator: CrossDomainHandshakeCoordinator | null = null;
	// The per-session share state (built in the federation block alongside crossDomainPeers),
	// exposed to the console handler so the cross_domain_share/unshare/list_shares ops manage
	// which local sessions are offered to a linked friend Domain. `isLinkedDomain` reads the
	// peer set so a share can only target a Domain the owner has actually linked.
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
	if (evieTransport && localDomainId) {
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
		const replayDurable = new DurableStore(path.dirname(LOG_PATH), "replay-guard");
		const replayGuard = new ReplayGuard();
		{
			const persisted = replayDurable.load();
			if (Array.isArray(persisted)) replayGuard.restore(persisted as Array<[string, number]>);
		}
		replayPersist = () => replayDurable.save(replayGuard.snapshot());
		sealer = createSealer(identity, allowlist, localGatewayId, crossDomainPeers, localDomainId, replayGuard);
		// The cross-Domain listening-mode handshake: the ONLY writer of crossDomainPeers. It
		// carries this Gateway's keys + ids into the SAS/link and reads the phone-held owner
		// root from the allowlist. The requester leg routes both commit-reveal rounds through
		// the Router seam below; evie (content-blind) forwards each frame to the receiver
		// Gateway and holds the reply. evieClient is assigned further down in this block, so
		// the seam reads it lazily at request time.
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
		const connection = evieWsConnection(evieTransport);
		console.log(
			`[evie] service-proxy transport -> ${evieTransport.apiUrl} (${evieTransport.service}:${evieTransport.port})`,
		);

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
				allowlist.applySnapshot(parsed.data);
				console.log(`[federation] domain sync applied (${parsed.data.admissions.length} admissions)`);
			},
			onDomainMeta: (meta) => {
				domainMeta = meta;
			},
			onDomainUpdate: (meta) => {
				// A live rename of THIS Domain's network: refresh only displayName, preserving
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

	// Creds-less enrollment: when armed with a one-time nonce (provision-admin-domain.sh (Enroll gateway))
	// and not yet admitted, mint the identity, print the admit-gateway QR with the LAN
	// target, and accept exactly one sealed bootstrap bundle over POST /enroll.
	let enrollInstall: ((frame: unknown) => string) | null = null;
	const enrollNonce = process.env.ENROLL_NONCE;
	if (enrollNonce && !evieTransport) {
		const enrollAllowlist = new Allowlist(federationDir);
		const enrollIdentity = loadOrCreateIdentity(federationDir);
		if (!enrollAllowlist.selfAdmission(enrollIdentity.sign.pub)) {
			const delivery = {
				host: process.env.ENROLL_LAN_HOST || "0.0.0.0",
				port: PORT,
				nonce: enrollNonce,
			};
			logAdmitGatewayQr(enrollIdentity, localGatewayId, delivery);
			// Also persist the raw payload so the setup script can re-render it (QR or pretty JSON)
			// without scraping the rendered QR out of docker logs.
			fs.writeFileSync(
				path.join(federationDir, ADMIT_PAYLOAD_FILE),
				JSON.stringify(admitGatewayPayload(enrollIdentity, localGatewayId, delivery)),
				{ mode: 0o600 },
			);
			// The enrollment window closes after a bounded time; the nonce dies with it so a
			// captured QR cannot be redeemed later. Re-run --enroll for a fresh nonce.
			let enrollTimer: ReturnType<typeof setTimeout> | null = null;
			enrollInstall = (frame) => {
				const bundle = openBootstrapBundle(frame, enrollIdentity, enrollNonce, localGatewayId);
				// Persist the owner-signed admission FIRST, then the transport creds: a failure
				// must never leave creds installed without the admission that authorizes them.
				enrollAllowlist.applySnapshot(bundle.domain);
				fs.writeFileSync(path.join(federationDir, "transport.json"), JSON.stringify(bundle.transport), {
					mode: 0o600,
				});
				// Record the joined Domain so the post-enroll restart resolves the same Domain.
				if (bundle.domainId) {
					fs.writeFileSync(path.join(federationDir, DOMAIN_ID_FILE), bundle.domainId, { mode: 0o600 });
				}
				// The admit payload's job ends once the bundle installs; drop it.
				fs.rmSync(path.join(federationDir, ADMIT_PAYLOAD_FILE), { force: true });
				enrollInstall = null;
				if (enrollTimer) clearTimeout(enrollTimer);
				console.log(
					`[enroll] installed credentials for Gateway "${localGatewayId}". Restart the gateway to connect.`,
				);
				return localGatewayId;
			};
			enrollTimer = setTimeout(() => {
				if (enrollInstall) {
					enrollInstall = null;
					console.log(
						"[enroll] enrollment window expired (~10 min); re-run provision-admin-domain.sh (Enroll gateway)",
					);
				}
			}, 600_000);
			enrollTimer.unref?.();
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
	});

	const routes = createRoutes({
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
		// This Gateway's own network display name (learned from evie's register reply), stamped
		// on every local TeamInfo so a linked friend Domain sees the owner's self-set label over
		// the discovery roster (D1). Null until the first register.
		displayName: () => domainMeta?.displayName ?? null,
		// True when this Gateway's own Domain is the admin's (the evie-runner who provisions
		// others), learned from the register reply. Stamped on the local TeamInfo so the console
		// shows the admin surfaces only on the admin's own session. Null (not false) until the
		// first register, mirroring displayName: "unknown" stays unknown rather than asserting
		// "not admin" (the TeamInfo stamp omits the field for any falsy value either way).
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
			? (sessionTarget, domainId) => crossDomainShareState!.isSharedTo(sessionTarget, domainId, isLinkedDomain)
			: null,
		resolveHandshake: wsHandlers.resolveHandshake,
	});

	if (evieClient) {
		const consoleHandler = createConsoleHandler({
			registry,
			conversationRegistry,
			mailboxStore,
			routes,
			localGatewayId,
			isProjectName: (name) => offlineCatalog.has(name) || knownTeamPaths.has(name),
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
			// Unlink a linked friend Domain: drop the LOCAL trust + share + in-flight state for
			// it. Forgetting the peer makes the sealer refuse both legs to that Domain on the
			// next frame; dropping the shares makes a re-link start from share-nothing; expiring
			// the in-flight jobs settles them fast instead of stalling to TTL. Idempotent - an
			// already-unlinked Domain returns zero counts. The phone separately submits the
			// owner-signed link-edge revocation so the Router drops its relay-affinity edge.
			unlinkDomain:
				crossDomainShareState && crossDomainPeersForConsole
					? (domainId) => ({
							peersRemoved: crossDomainPeersForConsole!.removeByDomain(domainId),
							sharesDropped: crossDomainShareState!.dropDomain(domainId),
							jobsExpired: store.expireByDomain(domainId),
						})
					: undefined,
			// Untrust a PERSON (owner-keyed): forget every peer Gateway owned by that owner across ALL
			// their Domains, then drop the shares + settle the in-flight jobs for exactly those Domains.
			// The owner-keyed sibling of unlinkDomain; the same local-cleanup primitives, summed over the
			// owner's Domains. Idempotent - an already-untrusted owner returns zero counts.
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
