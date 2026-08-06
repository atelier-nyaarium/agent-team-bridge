import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { DomainSnapshotSchema, signRegister } from "../shared/admission.js";
import { BlobStore } from "../shared/blob-store.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { DOMAIN_ID_FILE, resolveLocalDomainId } from "../shared/domain-id.js";
import { DurableStore, openDurable, restoreDurable } from "../shared/durable-store.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES } from "../shared/evie-protocol.js";
import { resolveLocalGatewayId } from "../shared/gateway-id.js";
import {
	type HostOp,
	type HostOpResult,
	type HostPeekResult,
	isReservedHostSession,
	type TmuxTarget,
} from "../shared/host-op.js";
import { ownerKeyId } from "../shared/owner-id.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import { type PlanePersistedState, PlaneRegistry, stableHash } from "../shared/plane-registry.js";
import { BlobGetOpSchema, BlobPutOpSchema, BlobStatOpSchema } from "../shared/schemas.js";
import { isComposite, parseSessionName } from "../shared/session-id.js";
import { type CodexCatalogWriter, type SessionRecord, SessionStore } from "../shared/session-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { answerBlobOp, BlobTooLarge } from "./blobOps.js";
import { CodexAgentService } from "./codexAgentService.js";

/** The three blob routes, each keyed to the schema the console plane validates the same op with. */
const BLOB_ROUTE_SCHEMAS = {
	"/blob/stat": BlobStatOpSchema,
	"/blob/put": BlobPutOpSchema,
	"/blob/get": BlobGetOpSchema,
} as const;

import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { CapabilityStore } from "./console/capabilityStore.js";
import { createConsoleDispatcher } from "./console/consoleHandler.js";
import { type ConsoleSealer, createConsoleSealer } from "./console/consoleSealer.js";
import { DurableOpStore } from "./console/durableOpStore.js";
import { createConsoleRelayPump } from "./console/relayPump.js";
import { DaemonCapabilityStore } from "./daemonCapabilities.js";
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
import {
	CrossDomainPresenceConsumer,
	type CrossDomainPresenceSource,
	createCoalescedPresencePusher,
	createCrossDomainPresenceReconciler,
	createCrossDomainPresenceSource,
} from "./federation/crossDomainPresence.js";
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
import { IntentTracker } from "./intent.js";
import { PresenceFacade } from "./presence.js";
import { ReadAnchors } from "./readAnchors.js";
import { createRoutes } from "./routes.js";
import { createSessionAuthority, presentedByRequest } from "./sessionAuthority.js";
import { createVibeCheck } from "./vibeCheck.js";
import { decideWakeCreate, WakeCoordinator, type WakeResult } from "./wake.js";
import { createWebSocketHandlers, resolveLiveIncarnation, type WsData } from "./websocket.js";

////////////////////////////////
//  Functions & Helpers

export async function startGateway(): Promise<void> {
	const PORT = parseInt(process.env.PORT || "20000", 10);
	// The arming-only pinned-TLS listener for the phone's LAN bundle delivery (see the arming block).
	const ENROLL_TLS_PORT = parseInt(process.env.ENROLL_TLS_PORT || "20003", 10);
	// The legacy pre-DATA_DIR durable-state dir, kept only so the one-shot schema wipe below can
	// drop any old-grammar files left there by the historical legacy->DATA_DIR migration.
	const LOG_DIR = path.join("/app", "log");

	// Durable state (federation private keys, pending-jobs, mailboxes, replay-guard, the session
	// resume map) lives in DATA_DIR, deliberately SEPARATE from the legacy /app/log volume so a
	// "clear the logs" action can never wipe federation identity.
	const DATA_DIR = process.env.DATA_DIR || "/app/data";
	// Byte store. Lives under DATA_DIR (a real docker volume) rather than the log volume, so
	// clearing logs cannot destroy attachments a message still references.
	const blobStore = new BlobStore(`${DATA_DIR}/blobs`);
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
	// The Gateway persists its federation identity, mirrored allowlist, and the enrollment-delivered
	// transport.json + domain-id under this dir (inside DATA_DIR, separate from the debug log).
	const federationDir = process.env.FEDERATION_DIR || path.join(DATA_DIR, "federation");
	let localDomainId = resolveLocalDomainId(federationDir);
	console.log(`[gateway] Domain id: ${localDomainId ?? "(none - not yet enrolled)"}`);

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
	const store = new PendingJobStore<ResponsePayload>();
	const knownTeamPaths = new Map<string, string>();
	const offlineCatalog = new Map<string, string>();
	// A name is a spawn-point project iff it is in the catalog (the dir scan or a bare register).
	// Composites are never added (the register write-guard), so membership alone is the signal -
	// even for a dotted dir name that the mechanical isComposite test would misread as a session.
	const isCatalogProject = (name: string) => offlineCatalog.has(name) || knownTeamPaths.has(name);
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
	// Restart-proof idempotency for send/respond, consulted only on an in-memory opCache miss -
	// see durableOpStore.ts. Persists synchronously on every state transition rather than on this
	// file's usual periodic tick, so it holds its own DurableStore instead of sharing a tick-driven
	// snapshot.
	const durableOpStore = openDurable(DATA_DIR, "op-idempotency", (d) => new DurableOpStore(d));
	// Session records: the durable known-session list (id-keyed, with the Claude harness resume id
	// so a later wake can `claude --resume <id>`). Entries past this TTL are swept on the persist
	// timer so the store cannot grow without bound. Mint/adopt ids must never land on a catalog
	// project or a reserved host session, so the clash space is injected here.
	const SESSION_RESUME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
	const sessionResumeDurable = new DurableStore(DATA_DIR, "session-resume");
	let persistCodexCatalogChecked: (() => void) | undefined;
	let codexCatalogWriter: CodexCatalogWriter | undefined;
	const sessionStore = new SessionStore({
		clash: (id) => isCatalogProject(id) || isReservedHostSession(id),
		codexCatalogPersistence: {
			persistChecked: () => {
				if (!persistCodexCatalogChecked) throw new Error("Codex persistence is not initialized");
				persistCodexCatalogChecked();
			},
			receiveWriter: (writer) => {
				codexCatalogWriter = writer;
			},
		},
	});
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

	// This Gateway's own Domain lifecycle metadata, learned from evie's gateway_register reply.
	// domainStatus tells the app to first-root vs just-provision; displayName lets teams()/discover
	// show a linked friend Domain the owner's self-set name. Null until the first register. Declared
	// here (ahead of presence.registerPlane below) rather than nearer its other evie-bridge state
	// further down: a fresh plane's constructor calls its snapshot() synchronously to seed the
	// initial hash, which reads this via the displayName/isAdminDomain closures immediately - a
	// `let` declared later in this same function is in the temporal dead zone at that point.
	let domainMeta: { domainStatus?: string; displayName?: string | null; isAdminDomain?: boolean } | null = null;

	const planeRegistry = new PlaneRegistry();
	const presence = new PresenceFacade({
		sessionStore,
		registry,
		offlineCatalog,
		localGatewayId,
		localDomainId: () => localDomainId,
		displayName: () => domainMeta?.displayName ?? null,
		isAdminDomain: () => domainMeta?.isAdminDomain ?? null,
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
	const sessionResumeSnapshot = (cleanShutdown: boolean) => ({
		sessions: sessionStore.snapshot(),
		planes: planeRegistry.persistedState(cleanShutdown),
		readAnchors: readAnchors.snapshot(),
		crossDomainPresence: crossDomainPresenceConsumer.snapshot(),
	});
	persistCodexCatalogChecked = () => sessionResumeDurable.saveChecked(sessionResumeSnapshot(false));
	if (!codexCatalogWriter) throw new Error("Codex catalog writer was not initialized");
	const codexAgentService = new CodexAgentService({
		auth: sessionAuthority,
		sessionStore,
		offlineCatalog,
		catalogWriter: codexCatalogWriter,
	});

	// The federation replay-guard wires its own persistence here once built (it only
	// exists when the evie bridge is configured); null-safe until then.
	let replayPersist: (() => void) | null = null;
	// Same shape as replayPersist: the evie bridge registers its teardown here rather than adding a
	// second signal listener, which would never run once the shutdown handler below exits.
	let evieStop: (() => void) | null = null;
	// `cleanShutdown` is the ONE signal that decides whether a restart trusts the persisted plane
	// counter lineage at all (see PlaneRegistry.persistedState): the regular 3s tick always writes
	// false (assume dirty until a clean exit proves otherwise); only the synchronous SIGTERM/SIGINT
	// handler passes true, as its last action before the process exits.
	const persistDelivery = (cleanShutdown: boolean) => {
		jobsDurable.save(store.snapshot());
		mailboxDurable.save(mailboxStore.snapshot());
		// sweep() deletes TTL-expired records outright - a genuine, hash-affecting change to
		// presence.snapshot()'s row set (unlike touchLive's lastSeen-only refresh, ambient and
		// excluded from the identity hash). Announce it like any other mutation rather than leaving
		// it to the 60s tripwire - but only on the rare tick that actually removed something: a
		// snapshot()+stableHash recompute runs unconditionally the moment markDirty is called (the
		// registry only gates the COUNTER BUMP behind the hash compare, not the compute that
		// produces it), so calling this every 3 seconds regardless of sweep's own result would cost a
		// full presence rebuild forever for a cutoff (SESSION_RESUME_TTL_MS, 30 days) that removes
		// something roughly once per record per month.
		if (sessionStore.sweep(SESSION_RESUME_TTL_MS)) presence.markDirty();
		// Actively removes TTL-expired op records rather than leaving them as dead weight only
		// masked at read time - see durableOpStore.ts's own sweep() doc for why this matters (every
		// OTHER conversation's persist() call re-serializes the whole store, so idle dead weight
		// inflates everyone else's write cost too).
		durableOpStore.sweep();
		capabilityStore.sweep();
		// The blob plane's only reclaim path. Nothing reference-counts a blob, so without this the
		// store only grows: every ref snapshot, every superseded designer card, every transfer that
		// died mid-flight stays forever. It shares DATA_DIR with the federation identity, so an
		// unbounded store is not merely untidy, it eventually stops the gateway persisting its keys.
		const freed = blobStore.sweep({ maxBytes: MAX_BLOB_STORE_BYTES });
		if (freed > 0) console.error(`[blobs] swept ${freed} bytes`);
		sessionResumeDurable.save(sessionResumeSnapshot(cleanShutdown));
		replayPersist?.();
	};
	const persistTimer = setInterval(() => persistDelivery(false), 3_000);
	persistTimer.unref?.();
	// Registering a signal listener REPLACES the runtime's default terminate, so this has to exit
	// itself. Without the exit the process persists and then keeps running: a `timeout`-wrapped
	// gateway outlives its budget and leaks, `docker stop` can only ever SIGKILL after the grace
	// period, and the 3s persist tick overwrites the cleanShutdown flag this just wrote.
	const shutdown = () => {
		persistDelivery(true);
		evieStop?.();
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

	// Concurrent sends to the same sleeping team must share ONE wake: two
	// parallel `devcontainer up` runs for the same project race each other and
	// both error out, failing sends whose container actually comes up.
	const inflightWakes = new Map<string, Promise<WakeResult>>();
	// create_session's relayToHost branch (a host target, or any target with no tryWakeTeam wired)
	// never touches inflightWakes above, so isWakeInFlight needs a separate signal for that branch
	// covering "launch requested" through "MCP registered" (consoleHandler.ts's create_session pairs
	// this with awaitRegister below to keep it set through the actual registration, not just the
	// host-op's own near-instant tmux-spawn ack). Tracked separately (rather than folded into
	// inflightWakes) so it never interferes with tryWakeTeam's own dedup-by-team join semantics.
	const inflightCreates = new Set<string>();

	function tryWakeTeam(
		team: string,
		createOpts?: { displayLabel?: string; mintedFrom?: string },
	): Promise<WakeResult> {
		const existing = inflightWakes.get(team);
		if (existing) {
			console.log(`[wake] ${team} wake already in flight; joining it`);
			return existing;
		}
		// Presence-facade wake-in-flight tracking: a SEPARATE signal from inflightWakes below (which
		// exists purely for promise-joining) with a correlated but independently-owned lifecycle - see
		// presence.ts's own doc comment. Started only on a genuinely NEW wake (a join must not
		// re-announce what is already showing verifying).
		presence.wakeStart(team);
		const wake = doWakeTeam(team, createOpts);
		inflightWakes.set(team, wake);
		// `.catch` before `.finally` so this cleanup-chain promise resolves; callers still receive
		// the original `wake` (unchanged) and see any rejection via their own await.
		void wake
			.catch(() => {})
			.finally(() => {
				inflightWakes.delete(team);
				presence.wakeEnd(team);
			});
		return wake;
	}

	async function doWakeTeam(
		team: string,
		createOpts: { displayLabel?: string; mintedFrom?: string } = {},
	): Promise<WakeResult> {
		// Clean break: a catalog project is a non-chat spawn-point, not a session. A send to it has no
		// destination (the daemon would launch project.<default> under a name the waiter never sees),
		// so fail fast instead of waiting out WAKE_TIMEOUT_MS. Catalog membership is the signal (a
		// dotted dir name "my.app" is still a project); named sessions are never in the catalog. A
		// definitive "no" - there is no ambiguity to wait out, so no errorKind.
		if (isCatalogProject(team)) {
			console.log(`[wake] ${team} is a spawn-point project, not a session; not waking`);
			return { ok: false };
		}

		// A live incarnation already serves this record - its canonical pane, or an alias re-incarnation
		// (a manual `claude --resume` under a different name) stamped as liveTeam. Routing reaches it, so
		// relaunching would spawn a duplicate on the same transcript. Report it up rather than wake.
		if (resolveLiveIncarnation(registry, sessionStore, team)) {
			console.log(`[wake] ${team} already has a live incarnation; not waking`);
			return { ok: true };
		}

		// A composite `project.session` resolves its container/path by the PROJECT segment (composites
		// are never in knownTeamPaths); a mapped Claude id lets the daemon `--resume` the session.
		const { project, session } = parseSessionName(team);
		// Never dispatch a wake that would relaunch over the host-daemon's own supervisor pane (the
		// daemon refuses it too; this stops the wake message at the source).
		if (project === "host" && isReservedHostSession(session)) {
			console.log(`[wake] ${team} is a reserved host session; not waking`);
			return { ok: false };
		}
		// A send-woken composite with an existing record just reattaches (idempotent - a re-wake lands
		// on the same record, and a displayLabel is ignored - the target is addressed, not (re)created).
		// One with no record yet is a genuine creation: a displayLabel mints a fresh opaque id under the
		// addressed spawn (the SAME mint-and-provenance path create_session uses, via mintOrReattach -
		// mintedFrom lets a retry sharing the same provenance key reattach instead of minting again)
		// rather than adopting the typed segment as-is - no silent typed-text-becomes-the-id. No
		// displayLabel refuses outright rather than adopt. The decision itself is pure and side-effect-
		// free, so it is checked BEFORE the host-connectivity check below (a doomed-either-way send gets
		// the more specific, more actionable reason) - but the actual mint is DEFERRED until after that
		// check passes, so a disconnected host can never leave a freshly-minted, never-to-be-woken record
		// behind (the rollback below only runs once a wake was actually attempted). Minting means the
		// address actually launched is NOT necessarily the one the caller typed - wakeTeam tracks the
		// real one, and the caller must address that for everything downstream of this wake. A bare
		// (non-composite) wake keeps the legacy convention and gets no record either way.
		let pendingMintLabel: string | undefined;
		if (isComposite(team)) {
			const decision = decideWakeCreate(team, sessionStore.getByTeam(team) != null, createOpts.displayLabel);
			if (decision.kind === "refuse") {
				console.log(`[wake] ${team} has no record and no displayLabel; refusing to adopt the typed name`);
				return { ok: false, error: decision.error };
			}
			if (decision.kind === "mint") pendingMintLabel = decision.sessionLabel;
		}

		const hostSubs = registry.get("host");
		const hostWs = hostSubs ? [...hostSubs.values()].find((ws) => ws.readyState === 1) : undefined;

		if (!hostWs) {
			console.log(`[wake] cannot wake ${team} - host is not connected`);
			return { ok: false, errorKind: "disconnected" };
		}

		let provisionalCreated = false;
		let wakeTeam = team;
		if (pendingMintLabel !== undefined) {
			const minted = presence.mintOrReattach({
				spawn: project,
				sessionLabel: pendingMintLabel,
				workdirHint: pendingMintLabel,
				mintedFrom: createOpts.mintedFrom,
			});
			provisionalCreated = minted.created;
			wakeTeam = sessionStore.teamOf(minted.record);
		}

		const projectPath = knownTeamPaths.get(project) ?? offlineCatalog.get(project);
		const record = sessionStore.getByTeam(wakeTeam);
		const resumeSessionId = record?.claudeSessionId;
		// The host workdir hint: the record's hint (workdirHint ?? sessionLabel, owned by the store).
		// A devcontainer ignores the hint; a bare (non-composite, recordless) host wake has none.
		const workdirHint = record ? sessionStore.hostWorkdirHint(record) : undefined;
		hostWs.send(
			JSON.stringify({
				type: "wake",
				team: wakeTeam,
				...(projectPath ? { projectPath } : {}),
				...(resumeSessionId ? { resumeSessionId } : {}),
				...(workdirHint ? { workdirHint } : {}),
				...(record ? { sessionToken: sessionStore.ensureBindToken(record) } : {}),
			}),
		);

		console.log(`[wake] requesting ${wakeTeam} startup${projectPath ? ` (${projectPath})` : " (convention)"}`);

		const result = await wakeCoordinator.waitFor(wakeTeam, WAKE_TIMEOUT_MS);
		console.log(`[wake] ${wakeTeam} ${result.ok ? "is now online" : "failed to come online"}`);
		// Roll back a provisional record THIS wake created if the launch never came online (a bogus or
		// removed project, a dead launch), so a failed send-wake leaves no persisted phantom "available"
		// card (mirrors create_session). A record a confirm has since bound (confirmedAt set, or a live
		// incarnation) is left intact - the wake may have timed out while a slow session was confirming.
		if (!result.ok && provisionalCreated) {
			const rec = sessionStore.getByTeam(wakeTeam);
			if (rec && rec.confirmedAt === undefined && !resolveLiveIncarnation(registry, sessionStore, wakeTeam)) {
				presence.forget(wakeTeam);
			}
		}
		return wakeTeam !== team ? { ...result, resolvedTeam: wakeTeam } : result;
	}

	// The host op timeout must EXCEED the host's worst-case work so a succeeding-but-slow op
	// never spuriously times out (a sendText runs two sequential 8s execs = up to 16s, and a
	// timeout on a keystroke send is indeterminate - the retry would re-inject). 20s clears that
	// with margin and still nests well under the console relay hold (evie ~55s, apiserver
	// ConsoleClient.PROXY_CEILING_MS 60s - the full chain is pinned in
	// ChatRepositoryConstantsTest, not here; this comment is context, not a source of truth).
	const HOST_OP_TIMEOUT_MS = 20_000;

	async function relayToHost(op: HostOp): Promise<HostOpResult> {
		const hostSubs = registry.get("host");
		const hostWs = hostSubs ? [...hostSubs.values()].find((ws) => ws.readyState === 1) : undefined;
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
		const hostSubs = registry.get("host");
		const hostWs = hostSubs ? [...hostSubs.values()].find((ws) => ws.readyState === 1) : undefined;
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

	// Start evie-bot bridge if config is present
	let evieClient: ReturnType<typeof startEvieClient> | null = null;
	let sealer: Sealer | null = null;
	let consoleSealer: ConsoleSealer | null = null;
	// Exposed to the console handler (built later) so its poll reply can carry the mirrored
	// keyring + version for the Console's keyring sync.
	let allowlistForConsole: Allowlist | null = null;
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
	// The cross-Domain-presence source side (gateway/federation/crossDomainPresence.ts), assigned
	// once activateEvieHandlers() builds it (it needs a federation-aware `routes`, only available
	// after buildRoutes() reruns post-activateFederation). Declared here, ahead of
	// activateFederation, so CrossDomainPeers' onChange hook below can close over the eventual
	// value - onChange only ever fires on a genuine link/unlink, which cannot happen before
	// enrollment completes, well after activateEvieHandlers has already run.
	let crossDomainPresenceSourceRef: CrossDomainPresenceSource | undefined;

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
		const crossDomainPeers = new CrossDomainPeers(federationDir, () => {
			planeRegistry.markDirty("linked-peers");
			// CrossDomainPeers' onChange is argument-less by construction - it cannot identify which
			// Domain a link/unlink affected, so it falls back to a full sweep of the current
			// linked-and-shared roster (bounded by the same cap recomputeAll's own callers use). This
			// is also what correctly grants a Domain its first push the instant it is linked, when an
			// everyone-trusted share already existed before the link (the grant-on-link case).
			crossDomainPresenceSourceRef?.recomputeAll();
		});
		crossDomainPeersForConsole = crossDomainPeers;
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
		// relay so an un-share bites without evie.
		crossDomainShareState = new CrossDomainShareState(federationDir, (reason) => {
			if (reason.kind === "domain") crossDomainPresenceSourceRef?.recomputeDomain(reason.domainId);
			else crossDomainPresenceSourceRef?.recomputeAll();
		});
		const identity = loadOrCreateIdentity(federationDir);
		// Durable replay-guard: persisted across restarts so an authentic sealed frame
		// captured inside the 120s freshness window cannot replay once after a deploy.
		const replayDurable = new DurableStore(DATA_DIR, "replay-guard");
		const replayGuard = new ReplayGuard();
		restoreDurable("replay-guard", () => {
			const persisted = replayDurable.load();
			if (Array.isArray(persisted)) replayGuard.restore(persisted as Array<[string, number]>);
		});
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
				presence.markDirty();
			},
			onDomainUpdate: (meta) => {
				// A live rename of the owner's display name: refresh only displayName, preserving
				// the domainStatus from the last register, so teams()/discover reflect the new
				// name immediately without a reconnect.
				domainMeta = { ...(domainMeta ?? {}), displayName: meta.displayName };
				presence.markDirty();
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

		evieStop = () => evieClient?.stop();
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

	// The tmux target a session record's pane lives at: the host's own tmux for a host session, else
	// a docker exec into the spawn's devcontainer. Mirrors consoleHandler's resolveTmuxTarget for the
	// composite case, built directly from the record since spawn/id are already resolved.
	function recordTmuxTarget(record: SessionRecord): TmuxTarget {
		return record.spawn === "host"
			? { kind: "host", name: "host", sessionName: record.id }
			: { kind: "devcontainer", name: record.spawn, sessionName: record.id };
	}

	// The vibe check: AI-managed session descriptions (see gateway/vibeCheck.ts). Message counting
	// hooks ride the routes deps; the disconnect reset rides createWebSocketHandlers below; the
	// scheduler tick peeks due sessions and asks at the earliest idle detection.
	const vibeCheck = createVibeCheck({
		auth: sessionAuthority,
		sessionAccess: presence,
		resolveLead: (team) => {
			const live = resolveLiveIncarnation(registry, sessionStore, team);
			if (!live?.data.handshakeConfirmed) return undefined;
			// The binding rides along so a vc- answer is checked against the socket actually serving
			// this team, rather than against the record (which an alias incarnation cannot prove).
			return { send: (payload: string) => live.send(payload), binding: sessionAuthority.toAnswerFor(live) };
		},
		peekScreen: async (record) => {
			const r = await relayToHost({ kind: "peek", target: recordTmuxTarget(record) });
			if (!r.ok || !r.result) return null;
			const peek = r.result as HostPeekResult;
			// Only a live tmux pane can be idle-evaluated; container logs mean the pane isn't up yet.
			return peek.kind === "tmux" ? peek.ansi : null;
		},
		sendRename: async (record, description, dedupKey) => {
			const r = await relayToHost({
				kind: "sendText",
				target: recordTmuxTarget(record),
				text: `/rename ${description}`,
				dedupKey,
			});
			if (!r.ok) throw new Error(r.error ?? "rename keystroke failed");
		},
	});
	const VIBE_TICK_MS = 15_000;
	const vibeTimer = setInterval(() => {
		vibeCheck
			.tick()
			.catch((err) => console.warn(`[vibe] tick failed: ${err instanceof Error ? err.message : err}`));
	}, VIBE_TICK_MS);
	void vibeTimer;

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
		// A fresh/reconnected host socket starts with no watches of its own, so it needs the current
		// watch list regardless of whether it happens to match what was last pushed to a prior
		// connection (a `force` push, not a diffed one).
		onTeamConnect: (team) => {
			if (team === "host") pushPresenceWatch(true);
		},
		// A team's last real socket dropping restarts its vibe-check fresh phase: the next
		// incarnation is a fresh wake or reconnect, which re-earns its first check via user messages.
		onTeamDisconnect: (team) => {
			vibeCheck.noteOffline(team);
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

	function buildRoutes() {
		return createRoutes({
			registry,
			conversationRegistry,
			store,
			capabilityStore,
			daemonCapabilityStore,
			codexAgentService,
			blobStore,
			auth: sessionAuthority,
			config: { localGatewayId, localDomainId },
			tryWakeTeam,
			isWakeInFlight: (team) => inflightWakes.has(team) || inflightCreates.has(team),
			offlineCatalog,
			knownTeamPaths,
			sessionStore,
			presence,
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
			// The cross-Domain-presence source side's own filter, reusing the exact same
			// shareState.sharesFor gatewayRelay.ts's list_teams case already applies for a pull.
			sharesFor: crossDomainShareState
				? (domainId) => crossDomainShareState!.sharesFor(domainId, isLinkedDomain)
				: null,
			crossDomainPresenceConsumer,
			resolveHandshake: wsHandlers.resolveHandshake,
			findPendingHandshake: wsHandlers.findPendingHandshakeId,
			repushHandshake: wsHandlers.repushHandshake,
			// This Gateway's own Domain owner id, for the mirror-tap's console-bound entries.
			// Mirrors resolvesLocalGateway's allowlist-ready gating: null pre-enrollment.
			ownerId: allowlistForConsole
				? () => (allowlistForConsole!.ownerSignPub ? ownerKeyId(allowlistForConsole!.ownerSignPub) : null)
				: null,
			vibeCheck,
		});
	}

	let routes = buildRoutes();

	function activateEvieHandlers(): void {
		// Cross-Domain-presence SOURCE side: needs the federation-aware `routes` buildRoutes() just
		// rebuilt (presenceForDomain/pushPresenceToDomain), so it is constructed here rather than
		// inside activateFederation. Assigning the module-level ref lets CrossDomainPeers'/
		// CrossDomainShareState's onChange hooks (wired earlier, inside activateFederation) reach it.
		const presencePusher = createCoalescedPresencePusher((domainId, sessions) =>
			routes.pushPresenceToDomain(domainId, sessions),
		);
		const crossDomainPresenceSource =
			crossDomainShareState && crossDomainPeersForConsole
				? createCrossDomainPresenceSource({
						planeRegistry,
						restoredPlanes,
						presenceForDomain: (domainId) => routes.presenceForDomain(domainId),
						invalidatePresenceCache: () => routes.invalidatePresenceSnapshotCache(),
						linkedAndSharedDomainIds: () => {
							const domainIds = [
								...new Set(crossDomainPeersForConsole!.all().map((p) => p.friendDomainId)),
							];
							return domainIds.filter(
								(id) => crossDomainShareState!.sharesFor(id, isLinkedDomain).length > 0,
							);
						},
						push: presencePusher.push,
						cancelPush: presencePusher.cancel,
					})
				: undefined;
		crossDomainPresenceSourceRef = crossDomainPresenceSource;
		// Every local presence mutation (session/WS/wake/working-state changes) also recomputes
		// every currently linked-and-shared Domain - the trigger set's first half (see the plan's
		// Source side section); the second half is CrossDomainPeers'/CrossDomainShareState's own
		// onChange hooks, wired inside activateFederation above.
		presence.onMarkDirty(() => crossDomainPresenceSource?.recomputeAll());
		// Re-register a plane for every Domain already linked-and-shared from a prior run.
		// reconcileOnBoot()'s own global pass already completed before federation activates (this
		// runs well after boot), so each plane's own cold-start/restored-state handling in
		// recomputeDomain is what actually reconciles it - mirrors the linked-peers plane's own
		// "registered late, tripwire is the backstop" reasoning a few lines above in this file.
		crossDomainPresenceSource?.recomputeAll();

		// Cross-Domain-presence CONSUMER-side backstop pull: `presence_push` gets no long-running
		// retry chain of its own, so a failed/exhausted push is simply caught here a few seconds
		// later - see crossDomainPresence.ts's own doc. Runs on its own 10s cadence, fully decoupled
		// from the console's own poll loop, so a hung/unreachable linked peer can never stall it.
		// Declared as a function-level const (not scoped inside the `if` below) so unlinkDomain/
		// untrustOwner further down can reach its `cancel` - a Domain unlinked while its pull is
		// still in flight (a real window: a Domain can run 2+ gateways, and only one needs to answer
		// for the pull to resolve) must not have that resolution resurrect the state teardown() just
		// removed.
		const crossDomainPresenceReconciler = crossDomainPeersForConsole
			? createCrossDomainPresenceReconciler({
					linkedDomainIds: () => [...new Set(crossDomainPeersForConsole!.all().map((p) => p.friendDomainId))],
					pull: (domainId) => routes.pullPresenceFromDomain(domainId),
					land: (domainId, sessions) => crossDomainPresenceConsumer.land(domainId, sessions),
				})
			: undefined;
		if (crossDomainPresenceReconciler) setInterval(() => crossDomainPresenceReconciler.tick(), 10_000);

		const consoleHandler = createConsoleDispatcher({
			blobStore,
			fetchBlobFromGateway: routes.fetchBlobFromGateway,
			registry,
			conversationRegistry,
			mailboxStore,
			routes,
			localGatewayId,
			localDomainId: localDomainId ?? "",
			isProjectName: isCatalogProject,
			// Forget drops the session's durable resume record so it stops listing as available.
			dropSessionResume: (team) => {
				presence.forget(team);
			},
			sessionStore: presence,
			capabilityStore,
			domain: () => {
				const snapshot = allowlistForConsole?.getSnapshot() ?? null;
				return snapshot ? { version: allowlistForConsole?.version() ?? "", snapshot } : null;
			},
			// The console register reply carries this Gateway's Domain status (learned from
			// evie's register reply) so the app knows to first-root vs just-provision.
			domainStatus: () => domainMeta?.domainStatus,
			planeRegistry,
			presence,
			intentTracker,
			readAnchors,
			crossDomainPresenceConsumer,
			linkedDomainIds: () => [...new Set(crossDomainPeersForConsole?.all().map((p) => p.friendDomainId) ?? [])],
			relayToHost,
			tryWakeTeam,
			isWakeInFlight: (team) => inflightWakes.has(team) || inflightCreates.has(team),
			markCreateInFlight: (team) => {
				inflightCreates.add(team);
				presence.createStart(team);
				return () => {
					inflightCreates.delete(team);
					presence.createEnd(team);
				};
			},
			awaitRegister: (team) => wakeCoordinator.waitFor(team, WAKE_TIMEOUT_MS),
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
								for (const d of domains) store.expireBySession(sessionTarget, d);
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
					? (domainId) => {
							const result = {
								peersRemoved: crossDomainPeersForConsole!.removeByDomain(domainId),
								sharesDropped: crossDomainShareState!.dropDomain(domainId),
								jobsExpired: store.expireByDomain(domainId),
							};
							crossDomainPresenceSource?.teardown(domainId);
							crossDomainPresenceConsumer.teardown(domainId);
							crossDomainPresenceReconciler?.cancel(domainId);
							return result;
						}
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
								crossDomainPresenceSource?.teardown(domainId);
								crossDomainPresenceConsumer.teardown(domainId);
								crossDomainPresenceReconciler?.cancel(domainId);
							}
							return { peersRemoved: removed, sharesDropped, jobsExpired };
						}
					: undefined,
			durableOpStore,
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
			localDomainId: localDomainId ?? "",
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
			crossDomainBinding: (sessionId) => store.crossDomainBinding(sessionId),
			// Serving a peer a range of a blob THIS Gateway holds. The read path only, never a write:
			// a peer may take bytes it can already name, and nothing else.
			serveBlobRange: (blobId, offset, length) => {
				const r = blobStore.read(blobId, offset, Math.min(length, BLOB_CHUNK_BYTES));
				return { ...(r.bytes.length > 0 ? { chunk: r.bytes.toString("base64") } : {}), eof: r.eof };
			},
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
		if (method === "GET" && url.pathname === "/pending") return routes.pending();
		if (method === "GET" && url.pathname === "/teams") return routes.teams();
		if (method === "GET" && url.pathname === "/capabilities") return routes.capabilities();
		if (method === "GET" && url.pathname === "/discover") return routes.discover();
		if (method === "POST" && url.pathname === "/send") return routes.send(req, body);
		if (method === "POST" && url.pathname === "/respond") return routes.respond(req, body);
		if (method === "POST" && url.pathname === "/poll") return routes.poll(req, body);
		if (method === "GET" && url.pathname === "/health") return routes.health();
		if (method === "POST" && url.pathname === "/human/notify") return routes.humanNotify(req, body);
		if (method === "POST" && url.pathname === "/plugin-action") return routes.pluginAction(req, body);

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
				return Response.json(await answerBlobOp(blobStore, parsed.data, routes.fetchBlobFromGateway));
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
				// may be proxied. Deliberately NOT isCatalogProject: that also trusts knownTeamPaths, which
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
				ws.data.missedPings = 0;
			},
		},
	});

	console.log(`[router] listening on :${PORT} (HTTP + WebSocket)`);
}
