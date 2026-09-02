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
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
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

/** Idle shares expire unless a live thread attests them. */
const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The three blob routes, each keyed to the schema the console plane validates the same op with. */
const BLOB_ROUTE_SCHEMAS = {
	"/blob/stat": BlobStatOpSchema,
	"/blob/put": BlobPutOpSchema,
	"/blob/get": BlobGetOpSchema,
} as const;

import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { CapabilityStore } from "./console/capabilityStore.js";
import { createConsoleDispatcher } from "./console/consoleHandler.js";
import { createConsoleSealer } from "./console/consoleSealer.js";
import type { TrustedCatalogProject } from "./console/consoleTypes.js";
import { DurableOpStore } from "./console/durableOpStore.js";
import { createConsoleRelayPump } from "./console/relayPump.js";
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
	// Pinned-TLS listener for phone enrollment.
	const ENROLL_TLS_PORT = parseInt(process.env.ENROLL_TLS_PORT || "20003", 10);
	// Legacy state directory used by the one-shot schema cleanup.
	const LOG_DIR = path.join("/app", "log");

	// Durable identity and delivery state stays separate from logs.
	const DATA_DIR = process.env.DATA_DIR || "/app/data";
	// Before any store is built, so no writer can run an unfenced tick first.
	useMigrationEpochFile(DATA_DIR);
	// Attachments share DATA_DIR so log cleanup cannot remove referenced bytes.
	const blobStore = new BlobStore(`${DATA_DIR}/blobs`);
	// Board attachments are not swept with the cache.
	const boardAttachments = new BoardAttachmentStore(`${DATA_DIR}/board-attachments`);
	// Ceiling for the whole store, swept on the persist tick. A MULTIPLE of the largest single
	// attachment, deliberately: a store only a few max-size blobs deep starts evicting live
	// transfers to make room for each other, so the sweep would thrash instead of reclaiming. It
	// still needs a ceiling at all because this shares DATA_DIR with the federation keypair and
	// allowlist, and a store allowed to grow without limit takes the gateway's identity down with it
	// when the disk fills.
	const MAX_BLOB_STORE_BYTES = parseInt(process.env.MAX_BLOB_STORE_BYTES || String(MAX_BLOB_BYTES * 16), 10);
	fs.mkdirSync(DATA_DIR, { recursive: true });

	const WAKE_TIMEOUT_MS = parseInt(process.env.WAKE_TIMEOUT_MS || "600000", 10);
	const localGatewayId = resolveLocalGatewayId();
	console.log(`[gateway] Gateway id: ${localGatewayId}`);
	// Federation state and staging live here.
	const federationDir = process.env.FEDERATION_DIR || path.join(DATA_DIR, "federation");
	recoverStaging(federationDir);
	for (const name of sweepAtomicTemps(federationDir)) console.log(`[gateway] removed atomic temp ${name}`);
	let cachedIdentity: Identity | null = null;
	const identity = () => (cachedIdentity ??= loadOrCreateIdentity(federationDir));
	const contentKeyStore = new ContentKeyStore(federationDir, () => identity().box.priv);
	let localDomainId = resolveLocalDomainId(federationDir);
	console.log(`[gateway] Domain id: ${localDomainId ?? "(none - not yet enrolled)"}`);

	// The boot lifecycle as ONE value (see boot.ts): every write is a named transition (enterArming,
	// enterFederationActive, the arming window's two exits), and every read resolves through fed().
	let boot: BootState = { phase: "standalone" };
	const fed = (): FederationSlice | null => federationOf(boot);

	// One-shot schema wipe: the address grammar changed with NO back-compat, so the stores whose keys
	// embed a fully-qualified session address (pending jobs, mailboxes, cross-domain shares) are stale
	// on upgrade and would orphan under the new parser. Gated on a version sentinel so it runs exactly
	// once, AFTER federationDir/localDomainId resolve and BEFORE the durable restore. The federation
	// keypair/allowlist/transport/domain-id are NOT touched, and session-resume.json is NOT wiped: it
	// is keyed by the LOCAL team field (`spawn.session`), whose dot grammar is unchanged, so those
	// `claude --resume` records + the known-session list parse fine and must survive the upgrade.
	const SCHEMA_VERSION = "2";
	try {
		const sentinelPath = path.join(DATA_DIR, "schema-version");
		const current = fs.existsSync(sentinelPath) ? fs.readFileSync(sentinelPath, "utf8").trim() : "";
		if (current !== SCHEMA_VERSION) {
			const legacyDir = LOG_DIR;
			for (const f of ["pending-jobs.json", "mailboxes.json"]) {
				fs.rmSync(path.join(DATA_DIR, f), { force: true });
				// Also drop the legacy-dir copy, so the temporary legacy->DATA_DIR migration (gated only
				// on dst-absent, not this sentinel) cannot re-seed an old-grammar file after a crash
				// between this wipe and the first durable re-snapshot.
				fs.rmSync(path.join(legacyDir, f), { force: true });
			}
			// Keyed by the old canonical; drop the single file, never the federation dir around it.
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
	// Written by the host daemon's catalog frame, read by discovery. Starts UNKNOWN, not empty: until
	// a daemon has answered, this machine has said nothing about what it offers, and saying "nothing"
	// on its behalf is a different and wrong claim.
	const hostSpawnPoints: HostSpawnState = { known: false, ids: [] };
	const { isTrustedCatalogProject, isAvailableProject } = createProjectPredicates(offlineCatalog, knownTeamPaths);
	const wakeCoordinator = new WakeCoordinator();
	const hostOpCoordinator = new HostOpCoordinator();

	// Console bridge: per-install mailboxes drained by the console's poll op.
	const mailboxStore = new DeviceMailboxStore();

	store.startCleanup();
	mailboxStore.startCleanup();

	// In-memory delivery state otherwise vanishes on restart, 404ing replies and losing queued
	// mail. Snapshot the persistent job anchors and device mailboxes (each box keeps its epoch so
	// the console's durable cursor still matches) to DATA_DIR, reload on boot, re-save on a timer.
	const jobsDurable = new DurableStore(DATA_DIR, "pending-jobs");
	const mailboxDurable = new DurableStore(DATA_DIR, "mailboxes");
	// Restart-proof idempotency for send/respond, consulted only on an in-memory opCache miss -
	// see durableOpStore.ts. Persists synchronously on every state transition rather than on this
	// file's usual periodic tick, so it holds its own DurableStore instead of sharing a tick-driven
	// snapshot.
	const durableOpStore = openDurable(DATA_DIR, "op-idempotency", (d) => new DurableOpStore(d));
	// Messages accepted for a session that could not take them. Persisted on every transition for the
	// same reason as the op store: the sender has already been told its message landed.
	const pendingDeliveries = openDurable(DATA_DIR, "pending-deliveries", (d) => new PendingDeliveryStore(d));
	const inboxClaims = createInboxClaims(DATA_DIR);
	// The same mechanism for the board's ABSOLUTE writes, in its own file: a shared one would let a
	// coincidental opId collision replay a console result as a board reply.
	const boardReplays = openDurable(DATA_DIR, "board-idempotency", (d) =>
		DurableOpStore.withValidator<BoardReply>(d, isBoardReply),
	);
	// Session records: the durable known-session list (id-keyed, with the Claude harness resume id
	// so a later wake can `claude --resume <id>`). Entries past this TTL are swept on the persist
	// timer so the store cannot grow without bound. Mint/adopt ids must never land on a catalog
	// project or a reserved host session, so the clash space is injected here.
	const SESSION_RESUME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
	// Minting is reachable without a credential, so the TTL alone bounds nothing over 30 days.
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
	// What plugins the owner's consoles have enabled. Starting empty costs only that tools fail open
	// until a device re-registers, which is the same posture as a fresh install.
	const capabilityStore = openDurable(DATA_DIR, "console-capabilities", (d) => new CapabilityStore(d));
	// The host daemon's own configuration, kept apart from the console's so neither source can
	// overwrite the other's answer. /capabilities serves the union.
	const daemonCapabilityStore = openDurable(DATA_DIR, "daemon-capabilities", (d) => new DaemonCapabilityStore(d));

	// Session records and the presence plane registry's own version identity (epoch/counter/hash/
	// cleanShutdown) are ONE atomic file, written by the SAME save() call - an asymmetric loss
	// between "presence knows its epoch" and "SessionStore knows its sessions" (the two-file idiom
	// every OTHER durable store here uses) is structurally impossible, since they are no longer two
	// files. `sessions` holds SessionStore's own snapshot shape; `planes` holds PlaneRegistry's.
	const loadedResumeRaw = sessionResumeDurable.load();
	// A pre-migration file is the bare flat team->record map SessionStore.snapshot() always
	// produced; the wrapped shape is `{sessions, planes}`. Distinguished by the wrapper key's
	// presence, since a team key never collides with it (team names are slugs, never "sessions").
	const isWrapped = loadedResumeRaw !== null && typeof loadedResumeRaw === "object" && "sessions" in loadedResumeRaw;
	const restoredSessions: unknown = isWrapped
		? (loadedResumeRaw as { sessions?: unknown }).sessions
		: loadedResumeRaw;
	const restoredPlanes: Record<string, PlanePersistedState> | undefined = isWrapped
		? (loadedResumeRaw as { planes?: Record<string, PlanePersistedState> }).planes
		: undefined;
	// Read-anchors' own raw per-owner data - a THIRD field on this same wrapped file, alongside
	// sessions/planes, so it stays covered by the identical one-atomic-write property (see this
	// file's own doc above) rather than becoming a fourth durable-store file.
	const restoredReadAnchors: unknown = isWrapped
		? (loadedResumeRaw as { readAnchors?: unknown }).readAnchors
		: undefined;
	// The cross-Domain-presence CONSUMER (landed) side's own raw per-Domain data - a FOURTH field
	// on this same wrapped file, for the same one-atomic-write reason readAnchors is a third rather
	// than its own durable-store file.
	const restoredCrossDomainPresence: unknown = isWrapped
		? (loadedResumeRaw as { crossDomainPresence?: unknown }).crossDomainPresence
		: undefined;
	// Each restore is contained to its own file. Sharing one try would let a throw part-way through
	// skip every restore after it, and the persist tick below writes each store back unconditionally
	// - so a corrupt mailboxes.json would take the owner's whole session list with it.
	restoreDurable("pending-jobs", () => {
		const jobs = jobsDurable.load();
		if (Array.isArray(jobs)) store.restore(jobs as Parameters<typeof store.restore>[0]);
	});
	restoreDurable("mailboxes", () => {
		const boxes = mailboxDurable.load();
		if (boxes && typeof boxes === "object")
			mailboxStore.restore(boxes as Parameters<typeof mailboxStore.restore>[0]);
	});
	restoreDurable("session-resume", () => sessionStore.restore(restoredSessions));
	console.log(
		`[durability] restored jobs=${store.size} mailboxes=${mailboxStore.size} resume=${sessionStore.size} ops=${durableOpStore.size}`,
	);

	const planeRegistry = new PlaneRegistry();
	// domainMeta (learned from the Router's register reply) rides the federation slice: a fresh
	// plane's constructor calls snapshot() synchronously, and fed() already answers null pre-federation.
	const presence = new PresenceFacade({
		sessionStore,
		registry,
		offlineCatalog,
		localGatewayId,
		localDomainId: () => localDomainId,
		displayName: () => fed()?.domainMeta?.displayName ?? null,
		isAdminDomain: () => fed()?.domainMeta?.isAdminDomain ?? null,
	});
	// The one place "what must a caller prove to act as X" is answered. Every gate consults it
	// rather than reading the credential fields itself, so all of them share one rule.
	const sessionAuthority = createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => localDomainId ?? "",
		localGatewayId,
	});

	presence.attach(planeRegistry);
	presence.registerPlane(restoredPlanes?.presence);
	// Boot reconciliation: a clean-shutdown-restored plane recomputes against the live boot-time
	// state and bumps ONCE if it differs from the persisted hash (live-derived fields cannot
	// survive a process exit even a graceful one, so this is expected whenever a session was
	// active at shutdown - not a bug). A fresh-epoch plane has nothing to reconcile.
	planeRegistry.reconcileOnBoot();
	// The tripwire: catches a mutation that changed presence's content without ever calling
	// markDirty (an escaped write bypassing the facade) and self-heals it. Slow tick, never the
	// per-poll hot path.
	const tripwireTimer = setInterval(() => planeRegistry.tripwireTick(), 60_000);
	tripwireTimer.unref?.();

	// Resolves each live team's daemon-derivation cadence from every device's declared focus.
	// Purely in-memory/TTL-based (no persistence: a restart's console re-declares on its very
	// next poll, well inside the TTL a real client ever notices).
	const intentTracker = new IntentTracker();

	// Cross-device read-position sync: one plane PER OWNER, registered lazily on that owner's own
	// first poll/report (see readAnchors.ts) rather than up front like presence - there is no fixed
	// owner set known at boot. restoredPlanes is read lazily at that point (closed over here), so a
	// clean-shutdown-restored owner still resumes its counter lineage correctly even though its
	// plane is registered well after this constructor runs.
	const readAnchors = new ReadAnchors(planeRegistry, restoredPlanes);
	readAnchors.restore(restoredReadAnchors);

	// Cross-Domain-presence CONSUMER (landed) side: one plane per Domain that has ever pushed to
	// this Gateway, lazily registered on first land (same reasoning as readAnchors above - no
	// fixed set of linked Domains known at boot). Constructed unconditionally (mirroring
	// readAnchors) even though it only ever receives a land() call once federation is active and a
	// friend actually pushes; nothing calls its methods until then.
	const crossDomainPresenceConsumer = new CrossDomainPresenceConsumer(planeRegistry, restoredPlanes);
	crossDomainPresenceConsumer.restore(restoredCrossDomainPresence);

	// The owner's task board, in its OWN durable file with synchronous checked writes - a trash op
	// the owner watched succeed must survive a crash, unlike readAnchors' low-stakes tick cadence.
	// Built further down, once wake tracking exists; until then a board write announces nothing.
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
	// End-of-life for a session's board entries. Done/cancelled trash either way; the disposition
	// decides the rest, and every caller states it rather than inheriting one. Own catch: board
	// trouble must never block a forget (the persist tick has its own containment).
	const boardSessionEnded = (team: string, disposition: BoardDisposition): number => {
		try {
			const count = boardStore.sessionEnded(team, disposition);
			// After the store, so a throw leaves the bank naming work the session provably still holds.
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

	// `cleanShutdown` is the ONE signal that decides whether a restart trusts the persisted plane
	// counter lineage at all (see PlaneRegistry.persistedState): the regular 3s tick always writes
	// false (assume dirty until a clean exit proves otherwise); only the synchronous SIGTERM/SIGINT
	// handler passes true, as its last action before the process exits.
	const runPersistSteps = createPersistRunner();
	// Every save and sweep the tick runs rides this table, so a step is contained by construction
	// rather than by its call site remembering a try: one failure costs that step alone.
	const persistDelivery = (cleanShutdown: boolean) =>
		runPersistSteps([
			{ name: "pending-jobs", run: () => jobsDurable.save(store.snapshot()) },
			{ name: "mailboxes", run: () => mailboxDurable.save(mailboxStore.snapshot()) },
			{
				name: "session-sweep",
				// sweep() deletes TTL-expired records outright - a genuine, hash-affecting change to
				// presence.snapshot()'s row set (unlike touchLive's lastSeen-only refresh, ambient and
				// excluded from the identity hash). Announce it like any other mutation rather than
				// leaving it to the 60s tripwire - but only on the rare tick that actually removed
				// something: a snapshot()+stableHash recompute runs unconditionally the moment markDirty
				// is called, so announcing every 3 seconds would cost a full presence rebuild forever
				// for a cutoff that removes something roughly once per record per month.
				run: () => {
					const sweptTeams = sessionStore.sweep(SESSION_RESUME_TTL_MS, {
						maxEntries: MAX_SESSION_RESUME_ENTRIES,
						isLive: (team) => resolveLiveIncarnation(registry, sessionStore, team) !== undefined,
					});
					if (sweptTeams.length === 0) return;
					presence.markDirty();
					// A swept session is one nobody decided about, so its work returns to the backlog
					// rather than being cancelled on its behalf.
					for (const team of sweptTeams) boardSessionEnded(team, "release");
				},
			},
			{ name: "board-trash-sweep", run: () => boardStore.sweepTrash() },
			// Actively removes TTL-expired op records rather than leaving them as dead weight only
			// masked at read time - see durableOpStore.ts's own sweep() doc (every OTHER conversation's
			// persist() re-serializes the whole store, so idle dead weight inflates everyone's writes).
			{ name: "op-idempotency-sweep", run: () => durableOpStore.sweep() },
			// Same reason as the console's: without it, expired board replays are masked at read time
			// but stay resident and re-serialized on every persist.
			{ name: "board-idempotency-sweep", run: () => boardReplays.sweep() },
			{ name: "console-capabilities-sweep", run: () => capabilityStore.sweep() },
			{
				name: "blob-sweep",
				// The blob plane's only reclaim path. Nothing reference-counts a blob, so without this
				// the store only grows, and it shares DATA_DIR with the federation identity: an
				// unbounded store eventually stops the gateway persisting its keys.
				run: () => {
					const freed = blobStore.sweep({ maxBytes: MAX_BLOB_STORE_BYTES });
					if (freed > 0) console.error(`[blobs] swept ${freed} bytes`);
				},
			},
			{ name: "session-resume", run: () => sessionResumeDurable.save(sessionResumeSnapshot(cleanShutdown)) },
			{ name: "replay-guard", run: () => fed()?.replayPersist() },
		]);
	// Stops under the fence: the cut is a tar of DATA_DIR, and a tick writing into it mid-archive
	// tears the snapshot. Shutdown still persists, so the final state reaches disk before the cut.
	//
	// The settle is the ONE deliberate write the fence allows, and only once: an op the fence caught
	// mid-flight has an outcome nobody can know, and a record is a marker rather than a request, so
	// it is dropped for the client to re-run rather than imported.
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
		const dropped = durableOpStore.failInFlight();
		console.log(`[migration] settled: ${dropped} in-flight op(s) dropped for the client to re-run`);
	}, 3_000);
	persistTimer.unref?.();
	// Registering a signal listener REPLACES the runtime's default terminate, so this has to exit
	// itself. Without the exit the process persists and then keeps running: a `timeout`-wrapped
	// gateway outlives its budget and leaks, `docker stop` can only ever SIGKILL after the grace
	// period, and the 3s persist tick overwrites the cleanShutdown flag this just wrote.
	const shutdown = () => {
		persistDelivery(true);
		fed()?.routerClient.stop();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	// An uncaughtException can fire mid-mutation, so the in-memory store may be inconsistent right
	// now. Do NOT flush it - that would overwrite the last good snapshot with crash-moment state.
	// Just log and exit: the last quiescent persist-timer/SIGTERM snapshot is consistent, and the
	// docker restart policy restores from it. Boot restore is guarded so a bad snapshot cannot loop.
	// The persist timer's own writes always carry cleanShutdown=false, so a crash landing here -
	// between two ticks, after mutations already fanned out live to peers - correctly mints a
	// fresh epoch on the next boot rather than restoring a counter behind what peers already
	// installed.
	process.on("uncaughtException", (err) => {
		console.error("[gateway] uncaughtException:", err);
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

	// The host op timeout must EXCEED the host's worst-case work so a succeeding-but-slow op
	// never spuriously times out (a sendText runs two sequential 8s execs = up to 16s, and a
	// timeout on a keystroke send is indeterminate - the retry would re-inject). 20s clears that
	// with margin and still nests well under the console relay hold (the Router ~55s - the full
	// chain is pinned in ChatRepositoryConstantsTest, not here; this comment is context, not a
	// source of truth).
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

	// Pushes the daemon's peek/derive watch list (every live team x its resolved cadence) whenever
	// it actually changed, diffed against the last push - so a per-poll focus declaration cannot
	// turn into a per-poll daemon message. `force` bypasses the diff for a fresh/reconnected host
	// socket, which starts with no watches of its own regardless of whether the computed list
	// happens to match what was last pushed to a PRIOR connection.
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
	// A short, fixed tick rather than per-poll: intent is inherently slow-moving (a declaration's
	// own TTL, IntentTracker.INTENT_TTL_MS, is measured in minutes), so decoupling this from the
	// console's own poll cadence means a poll storm can never turn into a daemon-watch storm. 2s
	// matches the board's own fastest cadence tier.
	const presenceWatchTimer = setInterval(() => pushPresenceWatch(), 2_000);
	presenceWatchTimer.unref?.();

	// Liveness is composed here rather than inside the push, which then needs no registry.
	// resolveLiveIncarnation is two-valued, so the wake signal is what separates waking from gone.
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
	// Own catch: an uncaught throw in a timer exits the gateway, and no board notice is worth that.
	const awarenessTimer = setInterval(() => {
		try {
			awareness?.tick();
		} catch (err) {
			console.error("[awareness] tick failed:", err);
		}
	}, 1_000);
	awarenessTimer.unref?.();

	// A Domain is "trusted/linked" iff this Gateway holds a cross-Domain peer for it (the owner linked
	// it). The single predicate the share gate uses to resolve an everyone-trusted share + to bound a
	// per-Domain share to a real link, so an everyone-trusted share can never reach a non-peer.
	const isLinkedDomain = (domainId: string): boolean =>
		fed()
			?.crossDomainPeers.all()
			.some((p) => p.friendDomainId === domainId) ?? false;

	const routerTransport = loadRouterTransport(federationDir);
	const enrollNonce = process.env.ENROLL_NONCE;
	// The whole boot-time phase decision, named and pinned by tests; the enterArming and
	// enterFederationActive call sites below act on it.
	const bootDecision = decideBootPhase({
		hasTransport: routerTransport !== null,
		hasDomainId: localDomainId !== null,
		hasEnrollNonce: !!enrollNonce,
	});

	// Builds everything FederationActive owns. Only enterFederationActive calls this; the slice's
	// handlers land there as a second stage, once the federation-aware routes exist.
	function buildFederationSlice(transport: RouterTransport, domainId: string): FederationSlice {
		// Deferred reads (handlers, domainMeta) resolve through the slice returned below; every
		// deferred caller fires from a WS event, well after this function returns.
		let slice: FederationSlice;
		// Load this Gateway's federation identity + mirrored allowlist from its volume,
		// and build the E2E sealer (cross-Gateway frames are sealed peer-to-peer).
		const allowlist = new Allowlist(federationDir);
		// Cross-Domain peers (other owners' Gateways this Gateway has linked with): a
		// DISJOINT store from the single-owner allowlist, written only by the handshake,
		// so a local-Domain sync can never wipe it and it never contaminates intra-Domain
		// resolution. The sealer resolves local peers first, then this set.
		const crossDomainPeers = new CrossDomainPeers(federationDir, () => {
			planeRegistry.markDirty("linked-peers");
			// CrossDomainPeers' onChange is argument-less by construction - it cannot identify which
			// Domain a link/unlink affected, so it falls back to a full sweep of the current
			// linked-and-shared roster (bounded by the same cap recomputeAll's own callers use). This
			// is also what correctly grants a Domain its first push the instant it is linked, when an
			// everyone-trusted share already existed before the link (the grant-on-link case).
			slice.handlers?.presenceSource.recomputeAll();
		});
		// The linked-peers plane: a one-call registration, same pattern as presence - the store's
		// own onChange hook above is the single writer, so a link/unlink/untrust can never forget
		// to announce itself. Registered here (federation activation may run well after boot, even
		// after the OTHER planes' own reconcileOnBoot pass) rather than at top-level construction,
		// since there is nothing to register until a Domain actually activates federation; the
		// tripwire's own periodic sweep (already running by then) covers this plane's one-time
		// boot-reconcile regardless of how late it joins the registry.
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
		// Per-session share state: which local sessions are offered to which linked friend
		// Domains, persisted alongside the peer set. Plain gateway-local state (the device's
		// submit op is authenticated by the existing console seal), read by discovery and the
		// relay so an un-share bites without the Router.
		const shareState = new CrossDomainShareState(federationDir, (reason) => {
			if (reason.kind === "domain") slice.handlers?.presenceSource.recomputeDomain(reason.domainId);
			else slice.handlers?.presenceSource.recomputeAll();
			// Attest changed shares before the next sweep.
			shareAttestor?.attest();
		});
		const federationIdentity = identity();
		// Durable replay-guard: persisted across restarts so an authentic sealed frame
		// captured inside the 120s freshness window cannot replay once after a deploy.
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
		// The requester leg routes both commit-reveal rounds through the Router seam below; the Router
		// (content-blind) forwards each frame to the receiver Gateway and holds the reply.
		// The seam reads the client through the slice, assigned further down, so it stays lazy.
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
		// The console channel rides the SAME durable replay guard + allowlist: a console
		// frame is sealed to this gateway and signed by an admitted console key.
		const consoleSealer = createConsoleSealer(federationIdentity, allowlist, replayGuard);
		console.log(`[federation] ${allowlist.ownerSignPub ? "enrolled" : "not yet enrolled (no Domain owner)"}`);
		// Not admitted yet: print the admit-gateway QR so the owner can scan this Gateway
		// into the Domain. Once admitted (mirrored from the Router), this falls silent.
		if (!allowlist.selfAdmission(federationIdentity.sign.pub))
			logAdmitGatewayQr(federationIdentity, localGatewayId);

		// The federation WS: dial the Router and pin its leaf fingerprint. Creds are delivered by
		// enrollment, so there is nothing to mount and nothing to configure by hand.
		const connection = routerWsConnection(transport);
		// The operator's own answer to "where is the Router", from Gateway Setup, wins over the address
		// the sealed bundle names: the phone knows the Router by its public host, which a machine on the
		// Router's own LAN may not be able to reach at all on a first connection. Both stay in the ring.
		const bootstrap = routerBootstrapOverride() ?? connection.url;
		console.log(`[router] direct transport -> ${bootstrap}`);

		// Frame handlers land on the slice after the routes rebuild; a frame arriving before that
		// is dropped (the console re-polls).
		const routerClient = startRouterClient({
			url: bootstrap,
			headers: connection.headers,
			tls: connection.tls,
			gatewayId: localGatewayId,
			domainId,
			reach: loadRouterReach(federationDir),
			onReach: (learned) => saveRouterReach(federationDir, learned),
			onConsoleRelay: (frame) => {
				slice.handlers?.consoleRelay(frame);
			},
			onGatewayRelay: (frame) => {
				slice.handlers?.gatewayRelay(frame);
			},
			onCrossDomainHandshake: (frame) => {
				slice.handlers?.crossDomainHandshake(frame);
			},
			onDomainSync: (domain) => {
				// The Router mirrors the owner root + allowlist on each register reply; apply
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
				slice.domainMeta = meta;
				presence.markDirty();
			},
			onDomainUpdate: (meta) => {
				// A live rename of the owner's display name: refresh only displayName, preserving
				// the domainStatus from the last register, so teams()/discover reflect the new
				// name immediately without a reconnect.
				slice.domainMeta = { ...(slice.domainMeta ?? {}), displayName: meta.displayName };
				presence.markDirty();
			},
			buildRegisterAuth: () => {
				// Present this Gateway's owner-signed admission + a fresh possession proof,
				// so the Router can gate registration once a Domain owner exists. Null (token
				// only) until enrollment writes the self-admission into the allowlist.
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
			// Match the local share sweep's liveness rule.
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
		// Built unwired; blobUploader.ts owns the reason.
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
			// The awareness bank renders board observations.
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
			ownerSignPub: () => allowlist.ownerSignPub,
			contentKeyStore,
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
			consoleSealer,
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

	// Creds-less enrollment: when armed with a one-time nonce (setup.sh (Enroll gateway)), mint the
	// identity, print the admit-gateway QR with the LAN target, hold the payload for
	// GET /admit-payload, and accept exactly one sealed bootstrap bundle over POST /enroll.
	// Leaving the arming phase is what closes the window: both slice fields die with the state.
	function enterArming(nonce: string): void {
		const enrollIdentity = identity();
		// The phone delivers the sealed bundle over a pinned-TLS listener the gateway opens only while
		// armed: the bundle is already E2E sealed, so this exists only to satisfy Android's no-cleartext
		// policy without an app-wide permit and to keep the LAN wire private. The phone pins the cert
		// fingerprint carried in the QR; the SAN is the LAN IP, so its hostname check stays on. A
		// non-LAN host (0.0.0.0) mints no cert -> no listener -> the Console enrolls by paste (nonce-gated).
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
		// The enrollment window closes after a bounded time; the nonce dies with it so a
		// captured QR cannot be redeemed later. Re-arm via setup.sh (Enroll gateway) for a fresh nonce.
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
			// Graceful stop (not stop(true)): let the in-flight POST's 200 flush before the listener
			// closes, so the Console sees success instead of a truncated-stream "delivery unreachable".
			enrollTlsServer?.stop();
			enrollTlsServer = null;
			if (enrollTimer) clearTimeout(enrollTimer);
			// no restart: connect to the Router in-process from the just-installed creds.
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
				// transport.json is now on disk, so a plain restart cannot self-arm; only a re-enroll recovers.
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
		// Hold the payload in memory for setup.sh to GET /admit-payload over loopback, instead of
		// a root-owned file the host user cannot read.
		boot = {
			phase: "arming",
			arming: { install, admitPayload: admitGatewayPayload(enrollIdentity, localGatewayId, delivery) },
		};
	}
	if (bootDecision === "arm" && enrollNonce) enterArming(enrollNonce);

	// POST /enroll intake, shared by the main HTTP listener (host loopback paste) and the arming-only
	// pinned-TLS listener (the phone's LAN delivery). Gated on the arming phase, so it 404s off-window.
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

	// Built here rather than inside the handlers: both the send path and the register hook drive it,
	// so it has to outlive either one's construction.
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
		onVirtualPeerEvicted: (conversationId) => {
			fed()?.handlers?.evictConsolePeer(conversationId);
		},
		// A fresh/reconnected host socket starts with no watches of its own, so it needs the current
		// watch list regardless of whether it happens to match what was last pushed to a prior
		// connection (a `force` push, not a diffed one).
		onTeamConnect: (team) => {
			if (team === "host") pushPresenceWatch(true);
			// The session arriving is what clears its backlog. Anything accepted while it was away goes
			// out now, in the order it was accepted.
			const handed = channelDeliveries.drain(team);
			if (handed > 0) console.log(`[delivery] handed ${handed} held message(s) to ${team}`);
		},
		onDeliveryAck: (team, deliveryId) => {
			void inboxPump?.onChannelDeliveryAck(team, deliveryId);
			if (channelDeliveries.acknowledge(deliveryId)) {
				console.log(`[delivery] ${team} confirmed ${deliveryId.slice(0, 8)}`);
			}
		},
		onTeamDisconnect: (team) => {
			if (team === "host") {
				// The daemon was the only frame source for every session's working/needsLogin; per
				// plan item 3's derivation-death semantics, all of it clears to unknown, not a frozen
				// last-known value. Also announces the offlineCatalog.clear() this disconnect just did.
				presence.clearAllWorking();
				presence.markDirty();
			}
		},
		onCatalogChange: () => presence.markDirty(),
		onDaemonCapabilities: (capabilities) => daemonCapabilityStore.declare(capabilities),
		onCodexHostMessage: (msg) => codexRelay.handleHostMessage(msg),
		onCopilotHostMessage: (msg) => copilotRelay.handleHostMessage(msg),
		// A confirmed daemon derivation for one team; undefined means derivation became impossible for
		// it (a peek-failure streak, or it dropped off the watch list) - a clear to unknown, distinct
		// from observing it as not-working.
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

	// Outlives the rebuild below, which is the whole point: activating federation mid-session runs
	// buildRoutes() again, and anything createRoutes allocates per call would restart from empty.
	const routesCarryOver = createRoutesCarryOver();

	function buildRoutes() {
		// One read of the phase; every federation-gated dep below derives from it.
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
			mailboxStore,
			routerClient: f?.routerClient ?? null,
			sealer: f?.sealer ?? null,
			crossDomainPeers: f?.crossDomainPeers ?? null,
			// Local-first seal-target resolution on the send side: a target gateway the local
			// allowlist admits seals v1 to the local Domain, mirroring the sealer's open-side ordering, so a
			// local/friend gateway-id collision never routes a local send to the friend.
			resolvesLocalGateway: f ? (gatewayId) => f.allowlist.resolveGateway(gatewayId) !== null : null,
			// teams() refreshes each online session's cross-Domain shares so presence keeps a
			// share from auto-forgetting; the periodic sweep below reaps only absent sessions.
			touchShares: f ? (sessionTarget) => f.shareState.touch(sessionTarget) : null,
			// respond re-reads the per-session share on a cross-Domain reply forward: a send
			// accepted while shared, then un-shared, has its in-flight reply dropped here instead
			// of relayed back to the origin (the un-share bites every direction, not just fresh sends).
			isSharedToForReply: f
				? (sessionTarget, domainId) => f.shareState.isSharedTo(sessionTarget, domainId, isLinkedDomain)
				: null,
			// The cross-Domain-presence source side's own filter, reusing the exact same
			// shareState.sharesFor gatewayRelay.ts's list_teams case already applies for a pull.
			sharesFor: f ? (domainId) => f.shareState.sharesFor(domainId, isLinkedDomain) : null,
			crossDomainPresenceConsumer,
			resolveHandshake: wsHandlers.resolveHandshake,
			findPendingHandshake: wsHandlers.findPendingHandshakeId,
			repushHandshake: wsHandlers.repushHandshake,
			deliveries: channelDeliveries,
			// This Gateway's own Domain owner id, for the mirror-tap's console-bound entries.
			// Mirrors resolvesLocalGateway's allowlist-ready gating: null pre-enrollment.
			ownerId: f ? () => (f.allowlist.ownerSignPub ? ownerKeyId(f.allowlist.ownerSignPub) : null) : null,
			boardClient: f?.boardClient,
			boardReplays,
			awareness: awareness ?? undefined,
		});
	}

	let routes = buildRoutes();

	// Builds the Router-frame handlers against the federation-aware `routes` the transition just
	// rebuilt; the returned presenceSource is what the slice's onChange hooks reach.
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
		// Every local presence mutation (session/WS/wake/working-state changes) also recomputes
		// every currently linked-and-shared Domain - the trigger set's first half (see the plan's
		// Source side section); the second half is CrossDomainPeers'/CrossDomainShareState's own
		// onChange hooks, wired in buildFederationSlice above.
		presence.onMarkDirty(() => {
			presenceSource.recomputeAll();
			presenceReporter?.markDirty();
		});
		// Re-register a plane for every Domain already linked-and-shared from a prior run.
		// reconcileOnBoot()'s own global pass already completed before federation activates (this
		// runs well after boot), so each plane's own cold-start/restored-state handling in
		// recomputeDomain is what actually reconciles it - mirrors the linked-peers plane's own
		// "registered late, tripwire is the backstop" reasoning in buildFederationSlice.
		presenceSource.recomputeAll();

		// Cross-Domain-presence CONSUMER-side backstop pull: `presence_push` gets no long-running
		// retry chain of its own, so a failed/exhausted push is simply caught here a few seconds
		// later - see crossDomainPresence.ts's own doc. Runs on its own 10s cadence, fully decoupled
		// from the console's own poll loop, so a hung/unreachable linked peer can never stall it.
		// unlinkDomain/untrustOwner below reach its `cancel` - a Domain unlinked while its pull is
		// still in flight (a real window: a Domain can run 2+ gateways, and only one needs to answer
		// for the pull to resolve) must not have that resolution resurrect the state teardown() just
		// removed.
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
			mailboxStore,
			routes,
			localGatewayId,
			localDomainId: localDomainId ?? "",
			isTrustedCatalogProject,
			// Forget drops the session's durable resume record so it stops listing as available. The
			// board hook rides HERE - the deliberate forget - and on the TTL sweep, never inside
			// SessionStore.forget itself, whose failed-wake/failed-create rollback callers would
			// otherwise apply the session-ended policy to a launch that never happened.
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
			// The console register reply carries this Gateway's Domain status (learned from
			// the Router's register reply) so the app knows to first-root vs just-provision.
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
				// The linked-peer roster read from the disjoint cross-Domain peer set, so a
				// freshly-linked peer is listed regardless of online / shared-back state (the
				// console unions these with the discovery-derived Domains). Read fresh each call.
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
				// After a successful unshare, settle any in-flight cross-Domain job so an
				// already-accepted send's reply stops at the destination instead of forwarding
				// back to the origin. A specific-Domain unshare scopes to that Domain; an everyone-trusted
				// unshare must settle every Domain it reached, i.e. every currently-linked one.
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
			// Unlink a friend Domain: drop the LOCAL trust + share + in-flight state for it.
			// Forgetting the peer makes the sealer refuse both legs on the next frame; dropping
			// shares makes a re-link start from share-nothing; expiring jobs settles them instead
			// of stalling to TTL. Idempotent. The phone separately submits the owner-signed
			// link-edge revocation so the Router drops its relay-affinity edge.
			unlinkDomain,
			// Untrust a PERSON (owner-keyed): forget every peer Gateway owned by that owner across
			// ALL their Domains, then drop the shares + settle the in-flight jobs for those Domains.
			// The owner-keyed sibling of unlinkDomain, summed over the owner's Domains. Idempotent.
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
		const consoleRelay = createConsoleRelayPump({
			sealer: federation.consoleSealer,
			handleFrame: consoleHandler.handleFrame,
			sendReply: (reply) =>
				federation.routerClient.callTool("console_relay_reply", reply as unknown as Record<string, unknown>),
		});

		// Federation: a peer Gateway's frames land here, run against the local routes,
		// and the reply routes back to the origin through the Router. The share state gates a
		// cross-Domain op to a shared devcontainer/loose session and filters a
		// cross-Domain caller's list_teams to shared sessions only.
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
			// An inbound cross-Domain reply / colliding re-send is gated on the binding this
			// Gateway recorded when IT created the job (the friend Domain it was routed to /
			// came from), not on the friend-controlled bare gateway id, so a friend cannot
			// forge a reply into another friend's job or hijack an unrelated job's reply route.
			crossDomainBinding: (sessionId) => store.crossDomainBinding(sessionId),
			// Serving a peer a range of a blob THIS Gateway holds. The read path only, never a write:
			// a peer may take bytes it can already name, and nothing else.
			// Through the shared read, so a peer reaches a board attachment whose cached copy has been
			// swept. This door is neither of answerBlobOp's two, and it is the ONLY one a second device
			// or another machine's agent can reach an off-route entry's bytes through.
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

		// Cross-Domain handshake (receiver leg): a pre-trust handshake frame the Router
		// routed here runs through the coordinator's receiver leg, and the reply routes back
		// to the requester Gateway through the Router.
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
			consoleRelay,
			gatewayRelay,
			crossDomainHandshake,
			evictConsolePeer: (conversationId) => consoleHandler.removePeer(conversationId),
			presenceSource,
		};
	}

	// Per-session share auto-forget: a share whose session has not been seen online for a
	// month is dropped, UNLESS a live cross-Domain thread to that session still exists (a
	// running collaboration must not lose its share mid-stream). teams() touches every live
	// session's shares so presence keeps a share fresh; this timer reaps the absent ones.
	function startShareSweep(federation: FederationSlice): void {
		const THIRTY_DAYS_MS = SHARE_TTL_MS;
		// "Live" means RECENTLY ACTIVE, not "ever touched": a persistent anchor refreshes its
		// createdAt on every create + deliver, so a thread idle past this window stops
		// suppressing the auto-forget (otherwise a single stale anchor pins a share forever).
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

	// The ONE transition into FederationActive, and the one place deciding what survives it:
	// routesCarryOver crosses the rebuild, everything else in the slice is fresh.
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
			// The payload carries the one-time nonce + box key, so gate it on the nonce the operator
			// armed with: setup.sh has it, a LAN client that never armed does not. A source-IP check
			// would not help - the docker proxy SNATs the host fetch to the bridge gateway anyway.
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
		// One door for all five tools across both backends, so session authority and validation cannot drift apart
		// across them.
		if (method === "POST") {
			const agentRoute = agentRoutes.get(url.pathname);
			if (agentRoute) return agentRoute(req, body);
		}

		// Blob transfer for agent callers. The console reaches the same store through its sealed
		// ops; this is the plain-HTTP door for an in-process MCP, which has no relay to ride.
		// Validated against the SAME schemas the sealed console plane uses, not a cast. These are the
		// only unauthenticated routes that write to disk, so the shape of what they accept is the
		// whole of their input handling, and a bound that exists at one door and not the other is not
		// a bound. A rejection is a 400 naming the field rather than a 500 from deep in the store.
		const blobRoute = BLOB_ROUTE_SCHEMAS[url.pathname as keyof typeof BLOB_ROUTE_SCHEMAS];
		if (method === "POST" && blobRoute) {
			// The only callers are this machine's own MCP agents; the console reaches the same three
			// ops over its sealed plane instead. So these routes take the same posture as /send: prove
			// you are one of this gateway's sessions, unless none of them is bound at all.
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
		// Explicit so the ceiling is a decision, not an inherited default. The largest legitimate
		// body is one blob chunk, base64-inflated (~1.4 MB); everything else is prose. The headroom
		// above that exists so an oversized request is rejected by a route with a real error rather
		// than cut off by Bun with none.
		maxRequestBodySize: 8_000_000,
		fetch(req, server) {
			const url = new URL(req.url);

			// Connector proxy: /connector/{project}/ws
			const proxyMatch = url.pathname.match(/^\/connector\/([^/]+)\/ws$/);
			if (proxyMatch) {
				const project = proxyMatch[1];
				// SSRF guard: `project` is dialed as ws://<project>:20002/ws, so only a project from the
				// host daemon's trusted catalog (offlineCatalog, written only under the HOST_WS_TOKEN gate)
				// may be proxied. Deliberately NOT the broader availability predicate: it also trusts knownTeamPaths, which
				// an unauthenticated /bridge register can poison with a hostile name (e.g. "localhost").
				// Requires the host daemon connected; the broader unauth-/bridge surface is a known,
				// deliberately postponed gap.
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
				wsHandlers.pong(ws);
			},
		},
	});

	console.log(`[router] listening on :${PORT} (HTTP + WebSocket)`);
}
