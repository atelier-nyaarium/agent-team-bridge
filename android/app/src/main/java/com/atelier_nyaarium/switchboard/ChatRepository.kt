package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.crypto.ownerKeyId
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.FocusIntent
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.SyncEntry
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.parseTarget
import java.io.File
import java.time.ZoneId
import java.util.UUID
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Wraps a drained MailboxEntry as a SyncEntry so the SyncCursor rules can dedupe/advance
 * by seq while the poll loop keeps the full entry to render. */
internal data class Drained(val entry: MailboxEntry) : SyncEntry {
	override val seq: Long get() = entry.seq
}

/**
 * Chat state over a ConsoleClient. Holds per-team threads, an unread tally and the open tab set,
 * and routes each drained reply to its team (parsed from the
 * `conv.<id>.<domain>.<gateway>.<spawn>.<session>` session id or the entry's `from`). The poll loop
 * and mailbox drain itself is the [drain] delegate (PollDrain.kt). Transcripts persist encrypted so
 * history survives restarts.
 */
class ChatRepository(
	internal val store: AppStateStore,
	// internal (not private): BoardOps reads every attachment's on-disk bucket location directly.
	internal val filesDir: File,
	// internal (not private): admitPicked (ChatRepositorySend.kt) opens every picked Uri through it.
	internal val contentResolver: ContentResolver,
	// STTS provider catalog, parsed + validated once from the bundled asset by
	// Repo.get. Empty only if the asset is missing/corrupt (Play stays dark).
	// internal (not private): the voice settings surface (ChatRepositoryStts.kt) reads it.
	internal val sttsCatalog: List<com.atelier_nyaarium.switchboard.proto.SttsProvider> = emptyList(),
) {
	/** TTS playback engine; cache lives under filesDir/stts/<team>/. Declared before the migration
	 * init block so the one-shot wipe can purge its cache root. */
	val stts = SttsPlayer(filesDir)

	/** The task board's console half: cache, pending queue and drain (see BoardManager's own doc).
	 * The poll loop presents its known version, applies its plane snapshot, and drains it. */
	val board = com.atelier_nyaarium.switchboard.board.BoardManager(store)

	// Declared before _state, which snapshots it. Kotlin initializes fields in declaration order.
	@Volatile internal var localGatewayId: String = store.loadGatewayId()

	/** The JSON codec over [store]. Declared before _state so its loads can seed the initial state. */
	// internal (not private): the drafts surface (ChatRepositoryDrafts.kt) and AttachmentOps write through it.
	internal val persistence = ChatPersistence(store)

	// One-shot grammar-version wipe. MUST run BEFORE the first thread/label load-parse below, so a
	// stale-grammar persisted key (`gateway/name`) never reaches the new parser. Kotlin runs init
	// blocks and property initializers top-to-bottom, so this settles before _state's
	// persistence.loadPersistedThreads()/loadPersistedLabels() read anything.
	init {
		if (store.migrateSchemaIfNeeded()) {
			// The prefs wipe never touched filesDir, so the matching grammar-era caches (attachment
			// bytes + TTS audio) would otherwise stay stranded. Purge them on the same one-shot latch.
			stts.purgeAll()
			Attachments.purgeAll(filesDir)
		}
	}

	// Canned directory listings for the create dialog's picker, installed only by seedSandbox
	// (emulator build). Null on every real device, so listDirs always asks the gateway there.
	@Volatile private var sandboxDirs: Map<String, List<String>>? = null
	private val loadedThreadsAtStartup: Map<String, List<Message>> = persistence.loadPersistedThreads()
	private val loadedReadAnchorsAtStartup: Map<String, ReadAnchor> = persistence.loadPersistedReadAnchors(loadedThreadsAtStartup)

	internal val _state = MutableStateFlow(
		ChatState(
			provisioned = store.load() != null,
			threads = loadedThreadsAtStartup,
			readAnchors = loadedReadAnchorsAtStartup,
			unread = loadedThreadsAtStartup.mapValues { (team, msgs) -> unreadCount(msgs, loadedReadAnchorsAtStartup[team]) },
			biometricLock = store.biometricLock,
			deviceName = currentDeviceName(),
			labels = persistence.loadPersistedLabels(),
			teamAbsenceStreaks = persistence.loadPersistedAbsenceStreaks(),
			localGatewayId = localGatewayId,
			displayName = store.displayName,
			firstRooted = store.firstRooted,
			scheduledSends = persistence.loadPersistedScheduledSends(),
			drafts = persistence.loadPersistedDrafts(),
		),
	)
	val state: StateFlow<ChatState> = _state

	////////////////////////////////
	//  Address helpers
	//
	//  The store grammar is the canonical Address (`domain.gateway.spawn.session`); thread/team keys
	//  ARE that canonical string. These resolve a wire/local target to it, mirroring the gateway's own
	//  minting so a console-derived key is byte-equal to a gateway-derived session_id.

	/** The local Domain id for minting/comparing local addresses, learned from a local session. Empty
	 * (arming mode / not yet confirmed) is passed through to parseTarget, which maps it to the sentinel
	 * - the same fallback the gateway uses. */
	private fun localDomain(): String = confirmedDomainId() ?: ""

	/** Canonicalize a target to its full address key. Accepts a local `spawn`/`spawn.session` (from the
	 * spawn dialog) or an already-canonical address (from the board). Guarded so a malformed value
	 * falls back to itself rather than throwing into the UI. */
	// internal (not private): the send pipeline (ChatRepositorySend.kt) and ScheduledSendOps resolve a
	// target's Domain against this same key.
	internal fun canonicalTarget(team: String): String =
		runCatching { parseTarget(team, localDomain(), localGatewayId).canonical }.getOrDefault(team)

	/** A `from` field (a canonical address or a local team field) resolved to its canonical address
	 * for thread attribution, or null when it is not an address (a free-form Device Name). Null lets
	 * the caller fall back to the store-key sender instead of keying a thread by a non-address - which
	 * would otherwise become an unsendable ghost chat. */
	internal fun fromCanonical(from: String): String? =
		runCatching { parseTarget(from, localDomain(), localGatewayId).canonical }.getOrNull()

	/** This device's own session address. The spawn segment is the OWNER id (matching the gateway's
	 * consoleSelfAddress), NOT the free-form device name, so a device name with spaces/capitals no
	 * longer breaks the self-thread check. Null only when the owner key is not yet available. */
	internal fun thisDeviceAddress(): Address? =
		runCatching {
			Address.local(localDomain(), localGatewayId, ownerKeyId(federation.ownerSignPub()), Protocol.DEFAULT_SESSION)
		}.getOrNull()

	// Read and invalidated across threads (poll loop, main, the player's daemon thread);
	// @Volatile gives the writes visibility. A rare double-construct race is harmless
	// (last writer wins, cheap build).
	@Volatile internal var client: ConsoleClient? = null
	// The mailbox cursor is console-owned and durable: MailboxSync loads it from the store
	// and the console resumes from its own consumption point, never re-adopting a server-
	// dictated cursor that would ack away the offline backlog on the next poll.
	internal val mailboxSync = MailboxSync(store)
	// The background poll cadence ladder. `store` already implements IdleSilenceStore; the
	// service wires its own scheduler (alarm + wakelock side effects) in after construction, the
	// same pattern as onInbound below.
	val pushback = IdlePushbackManager(store, System.currentTimeMillis()) { ZoneId.systemDefault() }

	// Always available from construction, independent of the drain's scope (null until the loop
	// starts) and of SwitchboardService's own lifecycle - a receiver-triggered fire kick must never be
	// a silent no-op the way scheduleAttachmentDelete's best-effort drain.scope?.launch is allowed to be
	// (a missed scheduled send has no "next cold start heals it" backstop the way an orphan
	// attachment delete does). Never cancelled: ChatRepository is a bare process singleton with no
	// teardown of its own, so this lives for the process's lifetime, same as the singleton itself.
	// internal (not private): PlaybackOps and BoardOps launch their own background transfers on this
	// same scope, so an exception routes through the one CoroutineExceptionHandler below.
	internal val repoScope = CoroutineScope(
		SupervisorJob() + Dispatchers.IO +
			CoroutineExceptionHandler { _, e ->
				DebugLog.log("Repo", "uncaught in repo scope: ${e.javaClass.simpleName}: ${e.message}")
				// An Error (OOM on an oversized encode, a torn write) would otherwise reach the
				// thread's uncaught handler and kill the app. Surfaced as a red banner instead.
				_state.update { it.copy(error = "Something went wrong: ${e.javaClass.simpleName}") }
			},
	)

	/**
	 * Run a repository command on the repository's OWN scope.
	 *
	 * UI code must never launch repository work on a Compose scope. That scope carries no exception
	 * handler, so the identical call is survivable from here and fatal from there - which is how one
	 * oversized attachment turned into a crash on every foreground. Routing through this is what
	 * makes the difference structural rather than something each call site has to remember.
	 */
	fun command(block: suspend ChatRepository.() -> Unit) {
		repoScope.launch { block() }
	}

	// The Domain trust anchor: owner root key, console member identity, and the keyring
	// the Console resolves every Gateway against before sealing to it.
	internal val federation = FederationManager(store)

	/** The poll loop's keyring-sync landing, wrapped so the federation surface stays confined to
	 * this class and its federation delegates (federation-manager-residue pins that reach). */
	internal fun applyDomainSync(snapshot: com.atelier_nyaarium.switchboard.proto.DomainSnapshot, version: String) {
		federation.applyDomainSync(snapshot, version)
	}
	// The federation surface, split into collaborators by concern (see each class's own doc).
	// Screens call through these (repo.ownerFacts.X, repo.devices.X, ...) rather than on ChatRepository
	// directly.
	internal val ownerFacts = OwnerFacts(this)
	internal val gatewayEnroll = GatewayEnrollment(this)
	internal val ceremony = EnrollCeremonyOps(this)
	internal val devices = DeviceApprovalOps(this)
	internal val domainAdmin = DomainAdminOps(this)
	internal val trust = TrustOps(this)
	// The playback surface (the autoplay queue and every transport control over it) and the
	// repository-side board wiring, split out the same way (see each class's own doc).
	// Must stay declared after `stts` and `repoScope`: PlaybackOps subscribes to the player from its
	// own init, so constructing it earlier reads those fields before they exist.
	internal val playback = PlaybackOps(this)
	internal val boardOps = BoardOps(this)
	// The inbound-attachment surface (fetch, land, sweep). Reads nothing here while constructing, so
	// unlike the two above it may be declared anywhere.
	internal val attachments = AttachmentOps(this)
	// Sends banked to fire later, holding the fire mutex and the two fields the service wires in
	// after construction (see ScheduledSendOps' own doc).
	internal val scheduled = ScheduledSendOps(this)
	// ADMIN-side enroll-invite secrets (handshakeId + pin) minted per staged tenant when the invite
	// blob is built, reused to drive the admin's leg of the in-person compare. Transient like the link
	// ceremony's linkNonce: the in-person flow keeps the detail screen open, and regenerating the
	// invite mints fresh secrets (abandoning the old QR's window). internal: shared by EnrollCeremonyOps
	// (adminEnrollContext) and DomainAdminOps (regenerateInvite, buildInviteBlob).
	internal val enrollInvites = java.util.concurrent.ConcurrentHashMap<String, EnrollInvite>()
	@Volatile internal var sttsClient: SttsClient? = null

	/** True while the Activity is started; drives the poll cadence - chained long-polls while
	 * visible, a tiered silence ladder otherwise (see [IdlePushbackManager]). The mailbox
	 * accumulates server-side either way. */
	@Volatile private var visible = false
	val isVisible: Boolean get() = visible
	// Bounds the optimistic-forget/board-resurrection race: a wholesale teams() snapshot dispatched
	// BEFORE forget() completes server-side can still list the just-forgotten team when it resolves
	// AFTER the optimistic local removal below. A short-lived tombstone masks that one stale
	// snapshot without permanently hiding the team - a bounded TTL (not a confirmation-cleared one)
	// so a failed forget or a legitimate same-address recreate both self-correct on expiry instead
	// of staying hidden forever (neither ever produces a snapshot confirming the team's absence).
	// Written on the main thread (forget() is a UI callback); read/pruned on Dispatchers.IO (the
	// poll loop and connect()) - a plain HashMap would race across that split.
	private val forgottenUntil = java.util.concurrent.ConcurrentHashMap<String, Long>()
	// Rows already given their one reconcile attempt this process. Synchronized:
	// the service's start and the Activity's foreground transition can race here.
	// internal (not private): reconcilePending (ChatRepositorySend.kt) is its only reader.
	internal val reconciled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	// The raw (pre-tombstone, pre-label-override) team snapshot the presence merge path last saw -
	// never persisted (a fresh process starts with no cache and full-resyncs on its first poll).
	// Re-merging this same cached list against the CURRENT tombstone set is what lets a
	// tombstone's own expiry resurrect a team locally without waiting for a fresh server push -
	// see applyPresence.
	@Volatile private var lastRawTeams: List<Team>? = null

	// This device's currently-declared focus (what poll() presents as `focus`), read fresh on every
	// poll - see declareFocus. Starts "background": a cold app has not yet observed the board or a
	// terminal, so it should not falsely claim the board's ramped cadence before the UI ever renders.
	@Volatile internal var currentFocus: FocusIntent = FocusIntent(screen = "background")

	/** The poll loop and mailbox drain (see PollDrain.kt): the loop lifecycle, the plane version
	 * cursors and both drain-gate subscriber lists live there; it reaches back into this class the
	 * way the federation Ops delegates do. */
	internal val drain = PollDrain(this)

	// The per-team read anchor last REPORTED to the Gateway (via report_read), so the poll loop
	// reports a team's local anchor only once per genuine local advance instead of every cycle.
	// Never persisted: a fresh process starts empty, so its first cycle re-reports every team's
	// current anchor - a harmless no-op on the Gateway if nothing actually changed (monotonic merge).
	@Volatile private var lastReportedReadAnchors: Map<String, ReadAnchor> = emptyMap()

	/** Set by the service: called per poll with the new inbound messages of one
	 * team, so a background burst can become a notification. */
	var onInbound: ((team: String, messages: List<Message>) -> Unit)? = null

	/** The Activity came on screen: gateway to the fast cadence, optimistically
	 * clear a doze-corpse failure banner (the kicked poll re-raises it within
	 * seconds if the bridge is genuinely down), and poll right now. */
	fun onForeground() {
		visible = true
		drain.onForegroundResume()
		_state.update { it.copy(error = null, pollFailStreak = 0, enrollingSince = 0L, foreground = true) }
		drain.kickPoll()
	}

	fun onBackground() {
		visible = false
		pushback.onBackground(System.currentTimeMillis())
		declareFocus(FocusIntent(screen = "background"))
		_state.update { it.copy(foreground = false) }
	}

	/** Wakes the poll loop immediately - the alarm receiver's bridge into a possibly-parked pass. */
	fun kickPoll() {
		drain.kickPoll()
	}

	/** Declares this device's current UI focus - what the board/thread/terminal composables are
	 * currently showing - read fresh on the NEXT poll (op.focus). A genuine TRANSITION (a different
	 * focus than the one already declared, not a redundant re-declare of the same value) interrupts
	 * an in-flight held poll so the Gateway's intent tracker - and the host daemon's derivation
	 * cadence it drives - ramps up within about one RTT instead of waiting out the remainder of the
	 * current hold (see pollRacingFocusChange). MainActivity/TerminalView call this on every
	 * relevant UI transition (the board shown, a terminal opened/closed); onBackground calls it too. */
	fun declareFocus(focus: FocusIntent) {
		val prior = currentFocus
		currentFocus = focus
		if (prior != focus) drain.interrupt()
	}

	internal fun client(): ConsoleClient {
		client?.let { return it }
		val blob = store.load() ?: error("not provisioned")
		return ConsoleClient(Provisioning.parse(blob), store).also { client = it }
	}

	/**
	 * What this device can render, asked at every register. Supplied by the app because the plugin
	 * framework is Context-bound and this class deliberately holds none. Null (unset, or a register
	 * that beats the framework's boot) states nothing rather than asserting emptiness, so a race can
	 * never read as "the owner turned everything off".
	 */
	@Volatile var enabledPlugins: (() -> List<com.atelier_nyaarium.switchboard.proto.EnabledPlugin>)? = null

	// Armed whenever a toggle's report has not reached the gateway. A dropped report is not
	// self-correcting the way most staleness here is: the gateway keeps serving an AFFIRMATIVE
	// union, and an affirmative union is precisely what a starting session does not second-guess,
	// so the owner would silently lose a tool they had just switched on. Retried from the poll loop.
	@Volatile internal var pluginReportPending = false

	/**
	 * Re-report after the owner toggles a plugin, so the change reaches the gateway now instead of
	 * waiting for the next reconnect. A session already running keeps the tools it started with,
	 * since an agent's tool list is fixed at startup.
	 */
	suspend fun reportEnabledPlugins() = withContext(Dispatchers.IO) {
		pluginReportPending = true
		if (!_state.value.connected) return@withContext
		runCatchingCancellable { client().register(enabledPlugins?.invoke()) }
			.onSuccess { pluginReportPending = false }
			.onFailure { DebugLog.log("Plugins", "re-register after toggle failed, retrying: ${it.message?.take(120)}") }
		reportPluginsToOtherGateways()
		Unit
	}

	/** The same plugin list to every OTHER Gateway this owner has. A capability store is per
	 * Gateway and only the route one hears a register, so a session homed elsewhere would otherwise
	 * never get the tools at all. Best-effort per Gateway; an offline one keeps its last report. */
	private suspend fun reportPluginsToOtherGateways() {
		val plugins = enabledPlugins?.invoke() ?: return
		val route = localGatewayId
		// From the KEYRING, not the session roster: a Gateway with no sessions listed still needs
		// the report, and the first session created there would otherwise start with no tools.
		val others = otherKeyringGateways(route)
		for (gw in others) {
			runCatchingCancellable { client().reportPluginsTo(gw, plugins) }
				.onFailure { DebugLog.log("Plugins", "report to $gw failed (keeps its last): ${it.message?.take(80)}") }
		}
	}

	/** The SAF tree the user chose to save attachments into. Raw string: whether the grant behind it
	 * is still alive is SaveTarget's question, and a caller must ask it rather than trust this. */
	var saveTreeUri: String
		get() = store.saveTreeUri
		set(value) {
			store.saveTreeUri = value
		}

	suspend fun provision(blob: String) = withContext(Dispatchers.IO) {
		// Strict wire parse: reject before persisting. Surfaced as state.error
		// rather than thrown - callers launch this from coroutines with no
		// catch, and the strict kotlinx parse rejects malformed blobs (single
		// quotes, stringy numbers) instead of silently coercing them.
		val prov = try {
			Provisioning.parse(blob)
		} catch (e: Exception) {
			_state.update { it.copy(error = "Invalid provisioning blob: ${e.message?.take(160) ?: "unparseable"}") }
			return@withContext
		}
		store.save(blob)
		// The blob is transport-only: the Console owns its locally-generated identity and resolves
		// every Gateway's keys from the synced keyring, so nothing cryptographic is imported. A
		// re-import is a fresh enrollment against a possibly re-rooted Domain, so clear the
		// console-admitted gate to re-submit this Console's admission on the next connect.
		store.consoleAdmitted = false
		// A re-import may carry a fresh invite (a friend re-onboarding, or a regenerated QR), so clear
		// the first-root latch: the next connect re-evaluates the blob's pendingTenant and re-roots if
		// present. An ordinary already-rooted blob (no pendingTenant) skips the step.
		store.firstRooted = false
		// A fresh invite is a fresh trust ceremony: re-offer the in-person compare on the next connect.
		store.enrollCeremonyDone = false
		client = null
		sttsClient = null
		// firstRooted=false in the state mirrors the latch reset so a re-imported fresh invite does not
		// show the "already set up" host pointer before the next connect re-evaluates the pendingTenant.
		_state.update { it.copy(provisioned = true, error = null, deviceName = prov.device, firstRooted = false) }
	}

	suspend fun connect() = withContext(Dispatchers.IO) {
		// DEBUG: wire the ingest sender from the blob up front, BEFORE any enroll step can fail, then
		// flush on every exit path (the finally below). Otherwise a pre-register failure (admission
		// submit, register) strands its trace on-device until a poll cycle that never starts. The
		// attach + flush + every DebugLog.log here compile out of release builds (BuildConfig.DEBUG).
		runCatching { store.load()?.let { DebugLog.attachIngest(Provisioning.parse(it)) } }
		DebugLog.log("Connect", "start gateway=${localGatewayId.ifEmpty { "?" }} admitted=${store.consoleAdmitted}")
		try {
			// Preflight the cluster path (API server + SA token + TLS) before blaming the
			// bridge or enrollment, so a stale blob says "re-provision" and a missing
			// identity says "not enrolled" - two distinguishable causes.
			runCatchingCancellable { client().apiReachable() }.onFailure { e ->
				val (cause, kind) = classifyConnError(e)
				_state.update {
					if (kind == ConnKind.TERMINAL) {
						it.copy(status = "error", error = "Cluster: $cause", connected = false, enrollingSince = 0L)
					} else {
						it.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
					}
				}
				return@withContext
			}
			DebugLog.log("Connect", "apiReachable ok")
			// First-root step (friend invite): a blob carrying a pendingTenant means this app must
			// root that pending Domain at its silently-generated owner key BEFORE submitting its own
			// admission (evie only trusts the owner-signed admission once the Domain is rooted at that
			// owner key). A reject (expired / already-claimed invite) is terminal: the root was
			// decided, not dropped, so stop with the friendly guidance.
			if (!ownerFacts.firstRootIfPending()) return@withContext
			// Reflect the first-root latch into the UI state now, so if the steps below fail with the
			// no-gateway cause (a freshly-rooted friend has no host yet) the empty board shows the
			// "set up, now bring up a host" guidance rather than the admin Add-a-Gateway CTA.
			if (store.firstRooted && !_state.value.firstRooted) _state.update { it.copy(firstRooted = true) }
			// Submit this Console's own admission before the sealed register, so the Gateway
			// has an owner-signed reason to trust its sealed ops. Bearer-gated, so it lands
			// even though the Console is not admitted yet. A THROW here (e.g. the Keystore-backed
			// store is unavailable, so the member identity cannot be persisted) is the REAL cause;
			// surface it instead of falling through to register()'s generic "not enrolled".
			runCatchingCancellable { ownerFacts.submitConsoleAdmission() }.onFailure { e ->
				val (cause, kind) = classifyConnError(e)
				_state.update {
					it.copy(
						status = if (kind == ConnKind.TERMINAL) "error" else "connecting",
						error = cause,
						connected = false,
						enrollingSince = 0L,
					)
				}
				return@withContext
			}
			// MailboxSync owns the durable cursor, so register's cursor/epoch are not adopted. We
			// still register to learn gatewayId, claim the mailbox, and get the epoch the box is on;
			// the poll loop's advance() reconciles any epoch change.
			val reg = client().register(enabledPlugins?.invoke())
			pluginReportPending = false
			DebugLog.log("Connect", "register ok gateway=${reg.gatewayId}")
			// Every OTHER Gateway needs the same list, or its sessions never learn this console's
			// capabilities. Fired after the roster exists, so it runs off the poll loop's first pass.
			repoScope.launch { reportPluginsToOtherGateways() }
			val id = reg.gatewayId
			if (id.isNotEmpty() && id != localGatewayId) {
				localGatewayId = id
				store.saveGatewayId(id)
			}
			// Pin every subsequent relay to this route Gateway so the Gateway routes there
			// even once other Gateways join the mesh.
			client().routeGateway = localGatewayId.ifEmpty { null }
			// A teams refresh failure is not a connect failure: register succeeded, so we
			// are connected. Log and proceed with the prior team list rather than masking
			// the error as an empty board (which would blank live sessions).
			val teams = runCatchingCancellable { client().teams(localGatewayId) }.getOrElse {
				DebugLog.log("Connect", "teams refresh failed: ${it.message?.take(120)}")
				_state.value.teams
			}
			// Seed the merge path's raw cache so a tombstone expiring before the first poll lands
			// still has something to self-heal from (see applyPresence/reapplyCachedTeams).
			lastRawTeams = teams
			_state.update {
				it.copy(
					teams = teams.withoutTombstoned(),
					status = "connected",
					error = null,
					connected = true,
					pollFailStreak = 0,
					localGatewayId = localGatewayId,
					enrollingSince = 0L,
				)
			}
			refreshDisplayNameFromTeams()
			DebugLog.log("Connect", "connected gateway=${localGatewayId.ifEmpty { "?" }}")
		} catch (e: Exception) {
			// MUST be the first statement: this catch spans the whole connect() attempt (register(),
			// teams(), submitConsoleAdmission(), firstRootIfPending() all suspend into the network), and
			// would otherwise defeat the cancellation rethrow guards on the runCatchingCancellable blocks
			// nested inside this same try - their rethrow lands right back here and gets swallowed too.
			e.rethrowIfCancellation()
			val (cause, kind) = classifyConnError(e)
			// "is not admitted" means the Gateway holds no admission for this Console. If we believed
			// we were admitted, the flag is stale (the submit never landed in evie) - clear it so the
			// next connect re-submits the admission instead of waiting forever on a calm sync-lag.
			if (kind == ConnKind.ENROLLING) store.consoleAdmitted = false
			_state.update { s ->
				when (kind) {
					// Post-enroll sync lag: calm "Finishing up enrollment..." (the poll loop
					// keeps retrying + clears it on the first success), escalating past the grace.
					ConnKind.ENROLLING -> {
						val (override, since) = enrollFold(s.enrollingSince)
						s.copy(
							status = if (override != null) "error" else "connecting",
							error = override ?: cause,
							connected = false,
							enrollingSince = since,
						)
					}
					ConnKind.TERMINAL -> s.copy(status = "error", error = cause, connected = false, enrollingSince = 0L)
					ConnKind.TRANSIENT -> s.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
				}
			}
		} finally {
			// DEBUG: stream whatever this attempt logged, even on the failure paths that return before
			// the poll loop's own flush would run. No-op in release (flushToIngest is BuildConfig.DEBUG).
			DebugLog.flushToIngest()
		}
	}

	/** This owner's display name, falling back to the local Domain id
	 * before discovery has stamped a name. Shown as "YOU" on the Users surface. */
	fun displayName(): String = state.value.displayName.ifEmpty { confirmedDomainId().orEmpty() }

	/** This owner's own Domain id, learned from a LOCAL session in the current board (the local
	 * listing stamps domainId = the connected Gateway's Domain). Null until a local session confirms
	 * it: the signing + cross-Domain routing sites refuse to act on a guessed id, so a frame never
	 * names a Domain this device has not actually joined. */
	fun confirmedDomainId(): String? {
		val gw = localGatewayId
		return _state.value.teams.firstOrNull { (it.gatewayId.ifEmpty { gw }) == gw && !it.domainId.isNullOrEmpty() }?.domainId
	}

	/** The confirmed local Domain id, or throw - for the signing/routing ops that run inside a
	 * runCatching so a not-yet-confirmed Domain surfaces as a clean failure instead of a guessed id. */
	internal fun confirmedDomainIdOrThrow(): String =
		confirmedDomainId() ?: error("Domain not yet confirmed by a local session")

	/** True only when a LOCAL session confirms this device owns the ADMIN Domain (the one that runs
	 * evie and provisions others), so it can host guest networks. evie stamps isAdminDomain on the
	 * register reply and the gateway carries it onto the local TeamInfo. A guest (its own non-admin
	 * Domain) returns false, and so does a device whose Domain is not yet confirmed - so the
	 * Guest-networks admin section is hidden rather than shown as a dead button evie would reject
	 * (provision_tenant is gated on the admin key, so "not admin-signed" for anyone else). */
	fun isAdmin(): Boolean {
		val gw = localGatewayId
		return _state.value.teams.any { (it.gatewayId.ifEmpty { gw }) == gw && it.isAdminDomain }
	}

	/** Whether to show "Revoke and Delete Domain": a CONFIRMED app-only user only. Never an admin (they
	 * purge via setup.sh), and never while the Domain is unconfirmed. Both flags read the SAME local
	 * session, so an unconfirmed id (offline, no teams) hides the action rather than letting an admin
	 * whose gateway is down read the unknown state as "not admin" and delete their whole Domain. */
	fun canDeleteOwnDomain(): Boolean = !isAdmin() && confirmedDomainId() != null

	////////////////////////////////
	//  Display name (this owner's display name)

	/** This owner's current display name, for the profile field + the MY NETWORK card. The
	 * cache (refreshed from discovery) is authoritative for display; empty until the owner sets one. */
	fun localDisplayName(): String = _state.value.displayName

	/** Refresh the cached display name from discovery's LOCAL session (the gateway stamps each
	 * session's displayName; the local Gateway's is this owner's own). A no-op when no local session
	 * carries one yet, so a board with only peer sessions never blanks the cached name. */
	private fun refreshDisplayNameFromTeams() {
		val gw = localGatewayId
		val local = _state.value.teams.firstOrNull {
			(it.gatewayId.ifEmpty { gw }) == gw && !it.displayName.isNullOrEmpty()
		}?.displayName ?: return
		if (local != store.displayName) store.displayName = local
		if (local != _state.value.displayName) _state.update { it.copy(displayName = local) }
	}

	/** Apply the linked-peers plane's pushed snapshot into state, so TrustOps.linkedDomains() can union it
	 * with discovery. The one writer of linkedPeerOwners - the poll loop calls this when a poll
	 * response carries `linkedPeers` (a real change; see PlaneRegistry). Folds the per-gateway peer
	 * rows to their distinct Domain ids (a Domain may run more than one gateway). */
	internal suspend fun applyLinkedPeers(peers: List<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry>) {
		// domainId -> friend owner key (a Domain may run several gateways under one owner; last wins).
		val owners = peers.filter { it.domainId.isNotEmpty() }.associate { it.domainId to it.ownerSignPub }
		_state.update {
			it.copy(
				linkedPeerOwners = owners,
				// crossDomainPeerSessions is a per-domainId UPSERT (applyCrossDomainPresence), which has
				// no other way to notice an unlinked/untrusted friend's cached entry should disappear -
				// this roster change is the authoritative signal to prune it.
				crossDomainPeerSessions = it.crossDomainPeerSessions.filterKeys { domainId -> domainId in owners },
			)
		}
		drain.pruneCrossDomainVersions(owners.keys)
	}

	/** Apply the cross-Domain-presence plane's pushed/pulled entries into state: a per-domainId
	 * UPSERT (never a wholesale replace - see crossDomainPeerSessions' own doc), since the wire only
	 * carries the SUBSET of linked Domains whose plane actually changed this poll. The one writer of
	 * crossDomainPeerSessions - the poll loop calls this when a poll response carries
	 * `crossDomainPresence`. */
	internal suspend fun applyCrossDomainPresence(entries: List<CrossDomainPresenceEntry>) {
		drain.upsertCrossDomainVersions(entries)
		_state.update { it.copy(crossDomainPeerSessions = it.crossDomainPeerSessions + entries.associateBy { e -> e.domainId }) }
	}

	/** Apply the read-anchors plane's pushed snapshot: another of this owner's OWN devices may have
	 * read further than this one has locally recorded. Monotonic, mirroring the Gateway's own merge
	 * (readAnchors.ts) but resolved by ROW POSITION rather than numeric epoch/seq (this device's
	 * thread is its own local render order - see isAnchorAdvance's own doc on why equality/position,
	 * not numeric comparison, is the sound check here). A synced entry whose row this device has not
	 * drained yet simply does not resolve (isAnchorAdvance returns false) and is silently skipped -
	 * low-stakes by design (see readAnchors.ts): it self-heals the moment this device's OWN reading
	 * catches up and reports past it, so there is nothing to retry or queue here. Called AFTER this
	 * poll's own fresh entries are folded into `_state.threads` (the poll loop's burst-append loop),
	 * so a row that arrived in the SAME response as its own read-anchor bump already resolves. Marks
	 * every applied entry as already-reported too, so the very next cycle's outbound report pass does
	 * not immediately bounce a just-adopted synced value straight back to the Gateway. */
	internal fun applyReadAnchors(entries: List<com.atelier_nyaarium.switchboard.proto.ReadAnchorWireEntry>) {
		var anyChanged = false
		val next = _state.updateAndGet { s ->
			var st = s
			for (e in entries) {
				val team = e.team
				val thread = st.threads[team].orEmpty()
				val candidate = ReadAnchor(e.epoch, e.seq, e.at)
				if (isAnchorAdvance(thread, st.readAnchors[team], candidate)) {
					anyChanged = true
					lastReportedReadAnchors = lastReportedReadAnchors + (team to candidate)
					st = st.copy(readAnchors = st.readAnchors + (team to candidate)).recomputeUnread(team, thread)
				}
			}
			st
		}
		if (anyChanged) persistence.persistReadAnchors(next.readAnchors)
	}

	/** Report every team whose local read anchor has advanced past what this device last told the
	 * Gateway (see lastReportedReadAnchors). Fire-and-forget per team: a failure here must never
	 * surface as a poll failure (it would wrongly trip the offline/reconnect UI for what is, per
	 * readAnchors.ts, low-stakes data that self-heals on the next successful report), so each report
	 * is individually caught and logged. Marks a team reported regardless of the Gateway's own
	 * `advanced` verdict - even a false (another device already reported further) means THIS device
	 * has successfully told the Gateway its own position, so re-sending it every cycle would be
	 * pure waste. */
	internal suspend fun reportLocalReadAdvances() {
		val anchors = _state.value.readAnchors
		for (team in teamsNeedingReadReport(anchors, lastReportedReadAnchors)) {
			val anchor = anchors.getValue(team)
			runCatching { client().reportRead(team, anchor.epoch, anchor.seq) }
				.onSuccess { lastReportedReadAnchors = lastReportedReadAnchors + (team to anchor) }
				.onFailure { DebugLog.log("Plane", "report_read failed for $team: ${it.message?.take(120)}") }
		}
	}

	/** Pull-to-refresh: forget the known presence AND linked-peers
	 * versions so the NEXT poll looks like a cold boot (ships everything for both planes), and
	 * interrupt any currently-held poll so that next poll fires now instead of inheriting up to
	 * LONG_POLL_HOLD_MS of staleness waiting out the remainder of an already-open hold - a bare
	 * version clear underneath a still-running held poll would otherwise wait for that poll's own
	 * natural expiry before the cleared version even reaches the server. Also pulls mesh-wide
	 * discovery immediately (see refreshDiscovery) rather than waiting out its own bounded
	 * interval, so a manual refresh covers everything a user would expect it to. */
	suspend fun refreshTeams() = withContext(Dispatchers.IO) {
		drain.resetPlaneCursors()
		drain.interrupt()
		refreshDiscovery()
	}

	/** Mesh-wide discovery: this Gateway's own live relay to every other same-Domain gateway and
	 * linked cross-Domain peer (routes.discover(), via the list_teams op). Unlike presence and
	 * linked-peers, this has no push mechanism yet, so it needs an explicit pull, on the poll
	 * loop's own bounded interval (DISCOVERY_REFRESH_MS) or immediately after an action that
	 * changes what should be discoverable (a manual refresh, an unlink). Routes through the same
	 * merge path as everything else (applyPresence), so tombstones/label-overrides/absence-streaks
	 * apply uniformly regardless of source. Best-effort: a relay failure keeps the prior list. */
	internal suspend fun refreshDiscovery() {
		runCatchingCancellable { client().teams(localGatewayId) }
			.onSuccess { applyPresence(it) }
	}

	/** The one plane-merge path: every fresh presence-plane snapshot lands in state through here
	 * and only here. Caches the raw list (lastRawTeams) so a LATER tombstone EXPIRY can re-derive
	 * `teams` from it directly (see reapplyCachedTeams) without waiting for a fresh server push -
	 * a failed or remote forget then resurrects locally on its own tombstone's schedule, not the
	 * next unrelated bump. */
	internal suspend fun applyPresence(fresh: List<Team>) {
		lastRawTeams = fresh
		reapplyCachedTeams()
	}

	/** Re-derives `teams` from the cached raw snapshot (see applyPresence) against the CURRENT
	 * tombstone set: filterTombstoned's own sweep (forgottenUntil.entries.removeIf) means a
	 * tombstone that has since expired no longer masks its team, so calling this on every poll
	 * loop tick - fresh presence or not - is what makes a tombstone's expiry self-heal instead of
	 * waiting for the next unrelated bump. Folds in ChatState.withFreshTeams' label-override
	 * pruning + absence-streak rules. A no-op before anything has ever been cached. Serialized
	 * against a concurrent call (the poll loop's own tick and a manual refreshTeams() both run on
	 * Dispatchers.IO) so two overlapping snapshots cannot each persist their own labels/streaks
	 * with no ordering guarantee between them - SharedPreferences.apply() only guarantees the
	 * LAST-CALLED write for a key eventually wins, not that "last called" lines up with "computed
	 * from the newer fetch" once two independent capture-then-persist sequences interleave. */
	private val freshTeamsMutex = Mutex()

	internal suspend fun reapplyCachedTeams() {
		val raw = lastRawTeams ?: return
		freshTeamsMutex.withLock {
			val visible = filterTombstoned(raw, forgottenUntil, System.currentTimeMillis())
			val next = _state.updateAndGet { it.withFreshTeams(visible) }
			persistence.persistLabels(next.labels)
			persistence.persistAbsenceStreaks(next.teamAbsenceStreaks)
		}
		refreshDisplayNameFromTeams()
	}

	// connect()'s own initial fetch stays a direct teams() pull (a cold-boot fetch has no presence
	// version to present yet either way); withoutTombstoned is used only there now, since every
	// OTHER wholesale-apply path routes through the merge path above.
	private fun List<Team>.withoutTombstoned(): List<Team> = filterTombstoned(this, forgottenUntil, System.currentTimeMillis())

	/** Capture an agent's tmux pane for the terminal view. Returns a Result so the caller can keep
	 * the last frame on a transient failure yet surface the backend's reason (container/host offline)
	 * when the pane never loaded. */
	suspend fun peekTerminal(team: String, sinceHash: String?): Result<com.atelier_nyaarium.switchboard.proto.ConsolePeekResult> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable { client().peek(team, sinceHash) }
		}
			.onSuccess { it.ansi?.let { a -> noteScreen(team, a) } }

	/** Update a session's working + needs-login flags from a captured pane (the spinner and auth
	 * footer markers are the truth). */
	fun noteScreen(team: String, ansi: String) {
		if (ansi.isEmpty()) return
		_state.update {
			it.copy(
				sessionWorking = it.sessionWorking + (team to AgentScreen.isWorking(ansi)),
				sessionNeedsLogin = it.sessionNeedsLogin + (team to AgentScreen.isLoggedOut(ansi)),
			)
		}
	}

	// The opId of the most recent still-unresolved spawnSession attempt per (project, label), so a
	// retry within the window reuses it instead of drawing a fresh one - letting the gateway's
	// mintedFrom provenance reattach the first attempt's record (or cleanly mint a new one if that
	// attempt genuinely failed) rather than always minting a second, redundant session. Cleared on a
	// confirmed success; a stale entry past the window is treated as absent. In-memory only.
	private val recentSpawnOpIds = mutableMapOf<Pair<String, String>, Pair<String, Long>>()

	/** Spawn a session in a spawn-point project with a free-form label. The gateway adopts the
	 * session's record synchronously and bumps the presence plane with it, so its own tile (or its
	 * rollback, on a failed launch) appears via this device's own next poll - there is no separate
	 * placeholder and no manual refresh nudge. A failure also surfaces as a transient Snackbar
	 * message; a retry with the same project + label shortly after reuses the prior attempt's opId
	 * (see recentSpawnOpIds) so it reattaches instead of duplicating. A label the gateway could not
	 * use as-is (unsupported characters) still creates the session under its minted id, surfaced with
	 * its own transient message rather than silently losing the typed name. A call for a (project,
	 * label) still pending from an earlier, unresolved call is a silent no-op (see pendingSpawns)
	 * rather than a second, ambiguous create. Runs on the caller's scope (the Activity's), so a tap
	 * always fires even before the poll loop's scope exists. */
	suspend fun spawnSession(project: String, label: String, workdir: String? = null) = coroutineScope {
		val key = project to label
		// A synchronous check before any suspension point - CreateSessionDialog's own disabled-while-pending
		// state is the primary guard, but it is a Composable snapshot (recomposes asynchronously), not a
		// lock; this is the real one, closing the gap for a caller that races ahead of that recomposition
		// or bypasses the dialog entirely.
		if (key in _state.value.pendingSpawns) return@coroutineScope
		val now = System.currentTimeMillis()
		recentSpawnOpIds.entries.removeAll { now - it.value.second >= SPAWN_RETRY_WINDOW_MS }
		val opId = recentSpawnOpIds[key]?.first ?: UUID.randomUUID().toString()
		recentSpawnOpIds[key] = opId to now
		_state.update { it.copy(pendingSpawns = it.pendingSpawns + key) }
		try {
			// The gateway's mint/adopt bumps the presence plane synchronously with the create, so the
			// just-adopted record's tile shows on this device's own NEXT poll with no manual nudge -
			// unlike the pre-plane teams() pull, a fresh presence snapshot needs no explicit trigger.
			runCatchingCancellable {
				withContext(Dispatchers.IO) { client().createSession(project, displayLabel = label, workdir = workdir, opId = opId) }
			}
				.onSuccess { result ->
					recentSpawnOpIds.remove(key)
					_state.update {
						it.copy(
							transientMessage = if (result.labelSanitized == true) {
								"\"$label\" has unsupported characters; the session was created using its id as the name instead"
							} else it.transientMessage,
						)
					}
				}
				.onFailure { e ->
					_state.update { it.copy(transientMessage = e.message ?: "Failed to create \"$label\"") }
				}
		} finally {
			// The removal point: cleared once createSession itself settles (success or failure), or on
			// cancellation, so a retry within the window can reuse this opId (see recentSpawnOpIds)
			// rather than racing a still-claimed key.
			_state.update { it.copy(pendingSpawns = it.pendingSpawns - key) }
		}
	}

	/** Take and clear the one-shot transient message, so a recomposition never re-shows it. */
	fun consumeTransientMessage(): String? {
		val msg = _state.value.transientMessage
		if (msg != null) _state.update { it.copy(transientMessage = null) }
		return msg
	}

	/** Send text (submitted with Enter) or a named control key to an agent's tmux pane. */
	suspend fun tmuxSend(team: String, text: String? = null, key: String? = null, submit: Boolean = true) =
		withContext(Dispatchers.IO) { client().tmuxSend(team, text, key, submit) }

	/**
	 * Clear a usage-limit dialog and pick the work back up: answer it with choice 1 (wait for the
	 * reset), then type "resume" and submit that as its own keypress.
	 *
	 * Three separate sends, none of them auto-submitting. A digit alone both selects and confirms in
	 * that dialog, so appending Enter to it would submit the composer underneath as well. Enter also
	 * only registers as Enter when delivered on its own rather than as a trailing byte on the text.
	 */
	suspend fun resumeAfterLimit(team: String) = withContext(Dispatchers.IO) {
		tmuxSend(team, text = "1", submit = false)
		tmuxSend(team, text = "resume", submit = false)
		tmuxSend(team, key = "Enter")
	}

	/** The directory picker's type-ahead read: subdirectories of one host dir. Failures collapse to
	 * an empty list - the picker just shows no suggestions. */
	suspend fun listDirs(path: String): List<String> = withContext(Dispatchers.IO) {
		// Canned listings exist only when seedSandbox installed them (emulator build), keeping the
		// picker inspectable with no gateway behind it.
		sandboxDirs?.let { return@withContext it[path].orEmpty() }
		runCatchingCancellable { client().listDirs(path).entries }.getOrDefault(emptyList())
	}

	/** This owner's admitted Gateways other than the route one. Keyring-derived, so a Gateway with
	 * no sessions in the roster is still reached, and a linked friend's is never included. */
	// internal (not private): BoardOps.refreshBoard and BoardOps.boardAssignTargets fan out to every
	// other Gateway the same way reportPluginsToOtherGateways and forget do here.
	internal fun otherKeyringGateways(route: String): List<String> =
		(Keyring.parse(store.loadDomain())?.admittedGatewayIds() ?: emptyList()).filter { it != route }

	val terminalRefreshMs: Long get() = store.terminalRefreshMs

	fun setTerminalRefreshMs(ms: Long) {
		store.terminalRefreshMs = ms
	}

	/** Mark a team fully read without opening it (swipe-away on its notification reads the burst).
	 * Advances the persisted anchor to the thread's tail - not just the volatile `unread` count -
	 * so a deliberate dismiss survives a process restart instead of resurrecting. */
	fun markRead(team: String) {
		var anchorChanged = false
		val next = _state.updateAndGet { s ->
			val thread = s.threads[team].orEmpty()
			val candidate = lastInboundAnchor(thread)
			val withAnchor = if (candidate != null && isAnchorAdvance(thread, s.readAnchors[team], candidate)) {
				anchorChanged = true
				s.copy(readAnchors = s.readAnchors + (team to candidate))
			} else {
				anchorChanged = false
				s
			}
			withAnchor.recomputeUnread(team, thread)
		}
		if (anchorChanged) persistence.persistReadAnchors(next.readAnchors)
	}

	/** Open (or focus) a thread's tab, deduped by canonical key. The spawn dialog opens a local
	 * `spawn.session` while the board and inbound replies use the full canonical address, so
	 * canonicalize before adding or the same session lands as two tabs. Returns the canonical key so
	 * the caller can point its active-tab pointer at the same value. Does NOT clear unread - reading
	 * a thread is what clears it now (the scroll-driven receipt model), not the act of opening it. */
	fun openThread(team: String): String {
		val key = canonicalTarget(team)
		_state.update { s ->
			s.copy(
				openTabs = if (key in s.openTabs) s.openTabs else s.openTabs + key,
				// Reopening un-mutes: a previously-closed team goes back to full notification treatment.
				closedTeams = s.closedTeams - key,
			)
		}
		return key
	}

	/** Replace the open-tabs order wholesale (drag-to-reorder in the tab row). Only applied when
	 * `newOrder` is still a permutation of the CURRENT tabs: a drag that resolves after a tab closed
	 * or opened elsewhere (e.g. a notification landing mid-drag) must not resurrect a dropped tab or
	 * silently drop the new one, so a stale commit is a no-op rather than corrupting the set. */
	fun reorderTabs(newOrder: List<String>) {
		_state.update { s -> if (newOrder.toSet() == s.openTabs.toSet()) s.copy(openTabs = newOrder) else s }
	}

	/** The current first-unread row id and the pointer-region ids (rows still counting toward
	 * unread) for `team`, derived from the live anchor. Used by the reveal trigger - always AFTER
	 * flushing any pending debounced receipt, so this reflects what was just read rather than a
	 * stale pre-flush anchor. */
	fun unreadBoundary(team: String): Pair<Long?, List<Long>> {
		val s = _state.value
		val thread = s.threads[team].orEmpty()
		val anchor = s.readAnchors[team]
		return firstUnreadId(thread, anchor) to unreadRows(thread, anchor).map { it.id }
	}

	/** A scroll-driven read receipt: the highest row the reader has scrolled past, reported by id
	 * with its `at` (guards against a forget-freed id being reused by a later append before this
	 * debounced report lands). Resolves to the nearest inbound row at-or-before the report, and
	 * only advances the anchor when that resolves to a genuinely later position - so a stale or
	 * duplicate report is a harmless no-op. */
	fun readUpTo(team: String, rowId: Long, at: Long) {
		var changed = false
		val next = _state.updateAndGet { s ->
			val thread = s.threads[team].orEmpty()
			val candidate = resolveReportedAnchor(thread, rowId, at)
			if (candidate != null && isAnchorAdvance(thread, s.readAnchors[team], candidate)) {
				changed = true
				s.copy(readAnchors = s.readAnchors + (team to candidate)).recomputeUnread(team, thread)
			} else {
				changed = false
				s
			}
		}
		if (changed) persistence.persistReadAnchors(next.readAnchors)
	}

	/** Close a tab: drop it locally AND, for a local addressable session, kill its tmux on the gateway
	 * while KEEPING its resume record (so it stays listed as available for a re-wake). The record
	 * surviving is what distinguishes Close from Forget. Best-effort; a gateway rejection (e.g. mid-
	 * wake, or a user-launched session) surfaces as a transient message rather than blocking the local
	 * tab close. */
	fun closeTab(team: String) {
		// Canonicalize before touching openTabs/closedTeams (matching openThread's own key), so a
		// non-canonical spelling of an already-open team can't silently miss the removal and mute
		// the wrong (uncanonicalized) key instead.
		val key = canonicalTarget(team)
		// Muted until reopened: full notification treatment (banner + TTS) downgrades to a
		// quiet mailbox/unread-count bump for this team.
		_state.update { it.copy(openTabs = it.openTabs - key, closedTeams = it.closedTeams + key) }
		// Stop speaking a thread the user just closed, but KEEP its cache: a close is reopenable and
		// the audio was already paid for. Only `forget` deletes.
		repoScope.launch { playback.dropQueuedFor(key) }
		val t = runCatching { parseTarget(team, localDomain(), _state.value.localGatewayId) }.getOrNull()
		if (t is Address && t.gateway == _state.value.localGatewayId) {
			drain.scope?.launch(Dispatchers.IO) {
				runCatchingCancellable { client().closeSession(team) }
					.onFailure { e -> _state.update { it.copy(transientMessage = e.message ?: "close failed") } }
			}
		}
	}

	/** Wake an asleep session (the terminal-view Wake button): reattach its record and bring its
	 * container/tmux back up. Reuses create_session's reattach-and-wake path keyed on the session's
	 * own spawn + leaf, so an existing record resumes rather than a duplicate being minted.
	 * Best-effort; a failure surfaces as a transient message. */
	fun wakeSession(team: String) {
		val t = runCatching { parseTarget(team, localDomain(), _state.value.localGatewayId) }.getOrNull()
		if (t !is Address || t.gateway != _state.value.localGatewayId) return
		drain.scope?.launch(Dispatchers.IO) {
			runCatchingCancellable { client().createSession(target = t.spawn, sessionName = t.session) }
				.onFailure { e ->
					_state.update { it.copy(transientMessage = e.message ?: "wake failed") }
				}
		}
	}

	/** Relaunch claude inside team's still-existing pane (the terminal palette's Wake up button):
	 * close_session (kill the tmux, KEEP the record) then create_session (fresh launch, resuming the
	 * record's transcript). Composed from those two existing ops because a bare create cannot do
	 * this - the daemon's ensureSession no-ops whenever the tmux session still exists, whether or
	 * not claude is still running inside it (a Ctrl-C-killed pane is exactly that state). Local
	 * addressable sessions only; throws on failure so the terminal surfaces it inline (tmuxSend's
	 * contract). */
	suspend fun relaunchSession(team: String) {
		withContext(Dispatchers.IO) {
			val t = runCatching { parseTarget(team, localDomain(), _state.value.localGatewayId) }.getOrNull()
			if (t !is Address || t.gateway != _state.value.localGatewayId) error("not a local session")
			client().closeSession(team)
			client().createSession(target = t.spawn, sessionName = t.session)
		}
	}

	/** Give a team a local display label (or clear it with a blank name). Local-only: the optimistic
	 * cache that shows immediately and the fallback against a gateway with no server label. */
	fun setLabel(team: String, name: String) {
		val labels = _state.updateAndGet { s ->
			val next = if (name.isBlank()) s.labels - team else s.labels + (team to name.trim())
			s.copy(labels = next)
		}.labels
		persistence.persistLabels(labels)
	}

	/** Rename a session: set it locally for immediate feedback, then push it to the gateway so the
	 * label persists server-side, and reconcile the local label to whatever the gateway actually
	 * applied (it sanitizes and per-spawn dedups, so "foo" may land as "foo-2"). A blank name clears
	 * the local label only, unconditionally - like closeTab's own local-only mutation, clearing never
	 * needs the network or an ownership check. On an unreachable/older gateway the optimistic local
	 * label stays - the gateway is presumed to apply it eventually. The optimistic non-blank write is
	 * withheld for a target that does not resolve to THIS Gateway's own Domain (closeTab/wakeSession's
	 * "is this mine" check compares gateway alone; a federated peer's session can coincidentally share
	 * this Gateway's id, so this matches the gateway's own rename_session guard, which checks both) -
	 * a federated peer's session can otherwise pass the board's own, more permissive Rename-menu gates
	 * and flash a label that was never actually applied anywhere; the round trip is still attempted
	 * regardless (a second, reactive line of defense - the server's own rejection is the backstop even
	 * if this check has a gap). An outright rejection (a successful round trip that still reports
	 * renamed:false) reverts the optimistic write, but ONLY if the label still holds exactly what this
	 * call wrote - a fresher server value landing via withFreshTeams, or a newer overlapping rename,
	 * must never be clobbered by a stale rejection arriving late, and the transient message mirrors that
	 * same guard (no revert happened -> nothing to report). A foreign target is always refused server-side
	 * as a thrown error (not a clean renamed:false reply - there is no local record to even consider
	 * renaming), so it is treated the same as an explicit rejection instead of the quiet
	 * presumed-eventually-applied handling a genuinely unreachable LOCAL gateway gets - otherwise that
	 * case is a silent no-op indistinguishable from success. */
	suspend fun rename(team: String, name: String) {
		val trimmed = name.trim()
		if (trimmed.isEmpty()) {
			setLabel(team, "")
			return
		}
		val t = runCatching { parseTarget(team, localDomain(), _state.value.localGatewayId) }.getOrNull()
		val isLocal = t is Address && t.domain == localDomain() && t.gateway == _state.value.localGatewayId
		val previous = _state.value.labels[team]
		if (isLocal) setLabel(team, trimmed)
		val result = withContext(Dispatchers.IO) {
			runCatchingCancellable { client().renameSession(team, trimmed) }
		}
		val reply = result.getOrNull()
		val applied = reply?.takeIf { it.renamed }?.sessionLabel
		if (applied != null && applied != trimmed) {
			// A confirmed, authoritative server value always wins over "nothing was protecting the
			// label to begin with" (isLocal false - no optimistic write was ever made to clobber).
			// When there WAS an optimistic write, only overwrite it while it still holds exactly what
			// this call itself set - never stomp a fresher value a concurrent self-heal or a later
			// rename already landed in the meantime.
			val next = _state.updateAndGet { s ->
				if (!isLocal || s.labels[team] == trimmed) s.copy(labels = s.labels + (team to applied)) else s
			}
			persistence.persistLabels(next.labels)
		} else if (reply?.renamed == false || (!isLocal && result.isFailure)) {
			var reverted = true
			if (isLocal) {
				val before = _state.value.labels[team]
				val next = _state.updateAndGet { s ->
					if (s.labels[team] == trimmed) {
						s.copy(labels = if (previous != null) s.labels + (team to previous) else s.labels - team)
					} else {
						s
					}
				}
				persistence.persistLabels(next.labels)
				reverted = next.labels[team] != before
			}
			if (reverted) {
				val message = result.exceptionOrNull()?.message ?: "Could not rename to \"$trimmed\""
				_state.update { it.copy(transientMessage = message) }
			}
		}
	}

	/** Drop a peer from this device: its thread, unread, tab, label, any cached TTS audio, and any
	 * peer-mirror row elsewhere that names it as a real party (see threadsAfterForget). Threads AND
	 * read anchors change in this ONE transition (the peer sweep can orphan a sibling thread's
	 * anchor row, re-anchored below), so both persist in a single batch - a process kill between
	 * two separate writes could otherwise strand a sibling's anchor against its already-updated
	 * (shrunk) thread. `unread` is recomputed for every team, not just the forgotten one: the sweep
	 * can remove rows another thread was counting, so its count must be re-derived too. Also drops
	 * the team from the board tile list immediately (see forgottenUntil above for why that needs a
	 * tombstone rather than a bare filter). */
	/**
	 * Install canned sessions and threads, for the `emulator` sandbox build only.
	 *
	 * This is the single entry point that build type needs in shared code, and it exists for a
	 * structural reason rather than convenience: `teams` is never restored from disk. It is only ever
	 * what the Gateway last reported, and the board renders its onboarding screen whenever there are
	 * no sessions. So a build with no network has an empty board no matter how much thread history is
	 * persisted, and cannot reach the surfaces worth looking at.
	 *
	 * The build-type guard is not decoration. A hook that merely happens to be unset in release is one
	 * refactor away from being set; one that checks its own build type stays inert even if something
	 * wires it up by mistake.
	 */
	fun seedSandbox(
		teams: List<Team>,
		threads: Map<String, List<Message>>,
		dirs: Map<String, List<String>> = emptyMap(),
		drafts: Map<String, Draft> = emptyMap(),
	) {
		if (BuildConfig.BUILD_TYPE != "emulator") return
		// The Create button and the local/peer board split key off localGatewayId, which a
		// gatewayless sandbox never learns from a register. Adopt the first fixture's gateway
		// segment so the seeded board renders as this device's own (Create button included).
		teams.firstOrNull()?.name?.split(".")?.getOrNull(1)?.let { localGatewayId = it }
		sandboxDirs = dirs
		_state.update { s ->
			s.copy(
				teams = teams,
				threads = threads,
				openTabs = threads.keys.toList(),
				unread = threads.mapValues { (team, msgs) -> unreadCount(msgs, s.readAnchors[team]) },
				connected = true,
				provisioned = true,
				status = "",
				error = null,
				localGatewayId = localGatewayId,
				drafts = drafts,
			)
		}
	}

	fun forget(team: String, boardDisposition: String? = null, onForgotten: (() -> Unit)? = null) {
		// Canonicalize once and key every field removal by it (matching openThread's own key), so
		// a non-canonical spelling can't leave a field's entry behind while the others clear.
		val key = canonicalTarget(team)
		forgottenUntil[key] = System.currentTimeMillis() + FORGET_TOMBSTONE_MS
		var dropped: List<Message> = emptyList()
		val priorDraft = _state.value.drafts[key]
		val next = _state.updateAndGet { s ->
			val afterForget = threadsAfterForget(s.threads, key)
			dropped = afterForget.dropped
			val newThreads = afterForget.threads
			val newAnchors = (s.readAnchors - key).mapValues { (t, anchor) ->
				reanchorAfterForget(newThreads[t].orEmpty(), anchor) ?: anchor
			}
			lastReportedReadAnchors = lastReportedReadAnchors - key
			s.copy(
				teams = s.teams.filterNot { it.name == key },
				threads = newThreads,
				labels = s.labels - key,
				unread = newThreads.mapValues { (t, msgs) -> unreadCount(msgs, newAnchors[t]) },
				readAnchors = newAnchors,
				openTabs = s.openTabs - key,
				closedTeams = s.closedTeams - key,
				sessionWorking = s.sessionWorking - key,
				sessionNeedsLogin = s.sessionNeedsLogin - key,
				drafts = s.drafts - key,
			)
		}
		persistence.persistThreadsAndReadAnchors(next.threads, next.readAnchors)
		persistence.persistLabels(next.labels)
		persistence.persistDrafts(next.drafts)
		// Nothing left to send it into - clears the record, re-arms the alarm, and drops its bucket.
		scheduled.cancelScheduledSend(key)
		// Queue first, cache second. Dropping under the advance mutex stops the player only once the
		// queue no longer points at it, so the stop's own terminal cannot advance into an entry whose
		// audio `purge` is about to delete.
		repoScope.launch {
			playback.dropQueuedFor(key)
			stts.purge(key)
		}
		// Deliberately its OWN unconditional call, not nested in the local-gateway gate below -
		// the files are local no matter where the session lives, unlike the gateway RPC.
		attachments.scheduleAttachmentDelete(dropped.flatMap { it.files }.mapNotNull { it.src })
		priorDraft?.let { attachments.scheduleAttachmentDelete(it.files.mapNotNull { f -> f.src }) }
		// Also tear the live session down on the gateway (kill tmux + drop the resume record) so it
		// stops listing as available, and dispose of its board work in the same call. Any Gateway this
		// owner's keyring can seal to: a session on another machine has a pane and a board there, and
		// gating this on the route Gateway left its record alive to return when the tombstone expired.
		// Best-effort, the gateway no-ops an absent session.
		val t = runCatching { parseTarget(team, localDomain(), _state.value.localGatewayId) }.getOrNull()
		val reachable = (otherKeyringGateways(localGatewayId) + localGatewayId).toSet()
		if (t is Address && t.domain == localDomain() && t.gateway in reachable) {
			drain.scope?.launch(Dispatchers.IO) {
				runCatchingCancellable { client().forget(team, boardDisposition) }
					// The record drop already bumps the presence plane server-side, which wakes this
					// device's own currently-held poll for free (same as closeTab/wakeSession/
					// spawnSession, none of which nudge the poll loop either) - no client-side action
					// needed on success.
					.onSuccess { applied ->
						// A Gateway that predates the field strips the request's copy and answers
						// without one, so it RELEASED work the owner asked to cancel. Say so; the
						// session is gone either way and there is nothing left to retry against.
						if (boardDisposition != null && applied != boardDisposition) {
							_state.update {
								it.copy(transientMessage = "Gateway needs an update; that session's tasks went back to the backlog.")
							}
						}
						withContext(Dispatchers.Main) { onForgotten?.invoke() }
					}
					.onFailure { e -> _state.update { it.copy(transientMessage = e.message ?: "Forget failed") } }
			}
		} else {
			// Nothing to send it to, so the local drop IS the whole forget.
			onForgotten?.invoke()
		}
	}

	fun setBiometricLock(enabled: Boolean) {
		store.biometricLock = enabled
		_state.update { it.copy(biometricLock = enabled) }
	}

	suspend fun setDeviceName(name: String) = withContext(Dispatchers.IO) {
		val blob = store.load() ?: return@withContext
		val j = JSONObject(blob).put("device", name)
		store.save(j.toString())
		client = null
		_state.update { it.copy(deviceName = name) }
		connect()
	}

	private fun currentDeviceName(): String =
		store.load()?.let { runCatching { Provisioning.parse(it).device }.getOrNull() } ?: ""

	suspend fun clearAll() = withContext(Dispatchers.IO) {
		// cancelAndJoin (not cancel): the poll loop's transport is cancellable, so a pass suspended
		// in it usually unwinds promptly - but a cancel landing in the loop's non-suspend tail still
		// completes that pass normally before the job finishes, and that tail is NOT always brief:
		// its last statement is DebugLog.flushToIngest(), a plain blocking HttpURLConnection POST
		// with only per-phase connect/read timeouts (no overall call bound), so a trickling ingest
		// endpoint can hold it open well past either one. cancel() alone would let this function race
		// ahead and reset state while that tail is still about to persist mail and re-touch _state.
		// Joining serializes against it, so the worst case is this function waiting out that tail
		// (bounded in practice, not in principle), not a silent resurrection of wiped state.
		drain.stopAndJoin()
		// Preserve the settings-owned voice creds + taste: Clear & re-provision wipes
		// provisioning/identity/history, never voice (clear() is the full factory wipe).
		store.clearProvisioning()
		client = null
		sttsClient = null
		stts.purgeAll()
		// Paired with the TTS purge above, same as the one-shot schema-migration wipe does (see
		// init{}): the prefs wipe never touches filesDir, so downloaded attachments would
		// otherwise survive a Revoke-and-Delete/Clear-and-re-provision indefinitely.
		Attachments.purgeAll(filesDir)
		localGatewayId = ""
		mailboxSync.clearInMemory()
		_state.update { ChatState(provisioned = false) }
		// The fresh ChatState() above already resets scheduledSends to empty (and its own key is
		// wiped from disk, being in PROVISIONING_KEYS) - only the OS-level alarm resource needs an
		// explicit cancel. A stray late fire/retry after this would be harmless regardless (both
		// re-check live state fresh and no-op on a miss), this just avoids a pointless wakeup.
		scheduled.scheduledSendScheduler?.cancelNext()
	}

	// internal (not private): the send pipeline (ChatRepositorySend.kt) and ScheduledSendOps append
	// their own echo row through it.
	internal fun append(team: String, msg: Message): Long {
		var newId = 0L
		val threads = _state.updateAndGet { s ->
			val existing = s.threads[team].orEmpty()
			newId = (existing.maxOfOrNull { it.id } ?: -1L) + 1
			val next = existing + msg.copy(id = newId)
			s.copy(threads = s.threads + (team to next)).recomputeUnread(team, next)
		}.threads
		persistence.persistThreads(threads)
		return newId
	}

	/** Append a message that came from the wire. The first real word from the team also clears its
	 * cold-wake notice: the team has demonstrably woken. A peer-mirror row is an agent-to-agent
	 * exchange shown for visibility, never an answer to the console's own question, so it proves
	 * nothing about the wake and leaves the notice up. Every branch recomputes `unread` inside
	 * the SAME state update that touches `threads` (the single-writer derivation) rather
	 * than a separate increment, so it can never race or drift from the anchor. */
	/** `beforeCommit` runs only for a genuinely new row, and strictly BEFORE the row enters
	 * `_state`. That ordering is load-bearing: the append wakes Compose on the main thread, which
	 * serializes the row (and consults the plugin chip decorators) while this drain coroutine is
	 * still on Dispatchers.IO. Anything a decorator needs in memory must therefore be recorded
	 * here, not after the append, or the row can render against an index that has not been seeded
	 * yet - and since a row's fingerprint does not cover its decoration, such a row is never
	 * re-pushed and stays wrong for the life of that renderer. */
	internal fun appendInbound(team: String, msg: Message, beforeCommit: () -> Unit = {}): Boolean {
		if (!msg.isPeer) _state.update { it.copy(wakingTeams = it.wakingTeams - team) }
		// At-least-once dedup: an entry with the same mailbox (epoch, seq) was already
		// rendered, so fold it in place and report no new render (no re-notify/TTS).
		// seq 0 is a local or legacy row that never re-drains, so it is exempt.
		if (msg.seq > 0) {
			var folded = false
			val updated = _state.updateAndGet { s ->
				val thread = s.threads[team].orEmpty()
				val idx = thread.indexOfFirst { it.seq == msg.seq && it.epoch == msg.epoch }
				if (idx >= 0) {
					folded = true
					val old = thread[idx]
					// A re-drained entry describes its files but never carries them, so folding it in
					// raw would blank a src whose bytes are already on disk and rendered - and a row
					// with no src is one the orphan sweep is entitled to collect. Keep what landed;
					// this is the inbound twin of mergeSentEchoFiles.
					val merged = msg.copy(id = old.id, files = Attachments.mergeSentEchoFiles(old.files, msg.files).files)
					val next = thread.toMutableList().also { it[idx] = merged }
					s.copy(threads = s.threads + (team to next)).recomputeUnread(team, next)
				} else {
					folded = false
					s
				}
			}
			if (folded) {
				persistence.persistThreads(updated.threads)
				return false
			}
		}
		beforeCommit()
		append(team, msg)
		return true
	}

	/** Fold a `sent` echo: an owner's own outgoing message mirrored to all their devices. On the
	 * SENDING device it upgrades the optimistic pending row (matched by opId) in place and settles
	 * it; on the owner's OTHER devices it appends a fresh settled row. An at-least-once re-drain
	 * folds by (epoch, seq). Never bumps unread or notifies: it is the owner's own message, so the
	 * sender does not double-render and the other devices just reflect it. */
	internal fun reconcileSent(team: String, echo: Message) {
		// Both reset in the else branch (matching appendInbound's folded/replaced pattern above) -
		// updateAndGet re-invokes this lambda on a failed CAS, so a captured var must be
		// re-established on EVERY invocation, not just the one that happened to match.
		var handled = false
		var deleteSrcs: List<String> = emptyList()
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team].orEmpty()
			val idx = sentEchoMatch(thread, echo)
			if (idx >= 0) {
				handled = true
				val old = thread[idx]
				val merge = Attachments.mergeSentEchoFiles(old.files, echo.files)
				deleteSrcs = merge.deleteSrcs
				val next = thread.toMutableList().also { it[idx] = echo.copy(id = old.id, files = merge.files) }
				s.copy(threads = s.threads + (team to next))
			} else {
				handled = false
				deleteSrcs = emptyList()
				s
			}
		}.threads
		if (handled) {
			persistence.persistThreads(threads)
			// The old row's now-orphaned bucket copies (see Attachments.mergeSentEchoFiles) -
			// deleted here, not left for the cold-start sweep, so the common case never leaks
			// even transiently.
			attachments.scheduleAttachmentDelete(deleteSrcs)
		} else {
			append(team, echo)
		}
	}

	// internal (not private): a couple of these are pinned against gateway-side TypeScript
	// constants by ChatRepositoryConstantsTest, which needs to read the real values.
	internal companion object {
		/** Chosen silence. Distinct from an empty preference, which means "the bundled sound". */
		const val CHIME_SILENT = "silent"

		const val POLL_INTERVAL_MS = 5_000L
		// Visible cadence: server-held long-poll (under the gateway's 45s cap - pinned against
		// schemas.ts's MAX_POLL_HOLD_MS in ChatRepositoryConstantsTest).
		const val LONG_POLL_HOLD_MS = 40_000L
		// Slack added to a deep-tier park so the coroutine backstop wakes slightly after, never
		// before, the alarm it is backing up.
		const val PARK_SLACK_MS = 5_000L
		// Mesh-wide discovery (other same-Domain gateways + linked cross-Domain peers) has no push
		// mechanism yet, so this session's own gateway relays a live list_teams to every other
		// gateway on every discovery pull, unlike the cheap local presence/linked-peers planes.
		// Refresh it on this bounded interval rather than per poll tick, trading freshness for cost.
		const val DISCOVERY_REFRESH_MS = 30_000L
		// forgottenUntil's tombstone lifetime: only needs to outlast a single in-flight teams()
		// HTTP round trip (what the resurrection race actually races against), not the much longer
		// LONG_POLL_HOLD_MS reconciliation cadence (reapplyCachedTeams runs every poll tick, so a
		// tombstone's own expiry self-heals within about one poll regardless). Derived from
		// ConsoleHttp's own bound on that call (not an independent literal) so it can never
		// silently fall behind the client's real worst case.
		const val FORGET_TOMBSTONE_MS = ConsoleHttp.DEFAULT_RELAY_CALL_TIMEOUT_MS + 5_000L
		// DERIVED from the generated wire constant, never a literal. This was its own 16 MB number
		// sized for a path that base64'd a whole file into the heap, and it stayed at 16 MB after that
		// path was deleted - so the console went on refusing exactly the large videos the chunked
		// transport exists to carry. Deriving it means the ceiling can only move in one place.
		// A single attachment may use the whole bucket, so this is a total, not a per-file cap.
		const val MAX_OUTGOING_BYTES = Protocol.MAX_BLOB_BYTES

		// Consecutive fetch failures before a blob stops being re-requested until the next launch. A
		// reference no Gateway can serve is otherwise retried on every poll pass forever, which costs
		// metered data and wakelock for something that will never arrive. Generous, because the common
		// failure is a transient link, not a missing blob.
		internal const val MAX_ATTACHMENT_FETCH_TRIES = 5

		// How long transfer residue may sit in the blob store before a cold start reclaims it. Well
		// past any real transfer, since the cost of being early is a re-fetch of something a live
		// upload was still using.
		internal const val STALE_BLOB_MAX_AGE_MS = 24 * 60 * 60 * 1000L

		/** Fetches after which a board attachment tile stops asking and says so. A picture whose bytes
		 * are genuinely gone must not re-request on every open forever. */
		// internal (not private): BoardOps.boardAttachmentState / kickBoardDownload read this bound.
		internal const val BOARD_FETCH_GIVE_UP = 3

		// A scheduled send's own bounded failure recovery: reconcilePending
		// only mops up an INTERRUPTED (still-"pending") attempt, never a settled "error", so a fire
		// that fails outright gets exactly one automatic retry this far out before falling back to
		// the tap-to-retry error row + a local notification. Long enough that a momentary blip (the
		// phone waking from deep doze with no signal yet) has genuinely cleared by the time it fires.
		internal const val SCHEDULED_SEND_RETRY_DELAY_MS = 5 * 60_000L

		// How long a warm alarm kick waits for SwitchboardService.onCreate's synchronous scheduler
		// wiring before giving up and proceeding anyway (see awaitSchedulerWired). Sized to comfortably
		// outlast onCreate's own synchronous prefix (createChannels + startInForeground + the
		// provisioned check + wiring the two callbacks) - all in-memory/local work, no network -
		// while staying short enough that a genuinely-never-wired case (unprovisioned, stopSelf()
		// before wiring anything) does not meaningfully delay this attempt's own failure handling.
		internal const val SCHEDULER_WIRE_WAIT_MS = 5_000L

		// The picker's own DatePicker imposes no upper bound of its own (Material3's default year
		// range is 1900-2100), so without one here a stray far-future pick banks its attachment
		// bucket for an effectively unbounded duration - this feature is meant for hours-to-days-out
		// reminders, not permanent storage commitments. 30 days is generous for the stated use case
		// while keeping the worst case bounded.
		internal const val SCHEDULED_SEND_MAX_HORIZON_MS = 30L * 24 * 60 * 60_000L

		// Comfortably past create_session's own ~25s cold-container bound (src/gateway/console/
		// consoleHandler.ts: CREATE_SESSION_BOUND_MS), so a reply that arrives late (rather than
		// being lost outright) still lands under the same opId as a retry that fires after the
		// user sees a failure. Pinned by ChatRepositoryConstantsTest - update both sides together.
		internal const val SPAWN_RETRY_WINDOW_MS = 40_000L

		// Detects a gateway that ignores holdMs and returns empty instantly instead of honoring
		// the hold. Must stay well below LONG_POLL_HOLD_MS so a genuine ~40s hold is never
		// mistaken for this; the init check below pins that relationship instead of leaving it
		// as an unstated assumption on the literal.
		const val INSTANT_EMPTY_THRESHOLD_MS = 3_000L

		init {
			require(INSTANT_EMPTY_THRESHOLD_MS < LONG_POLL_HOLD_MS / 4) {
				"INSTANT_EMPTY_THRESHOLD_MS must stay well below LONG_POLL_HOLD_MS"
			}
		}
	}
}
