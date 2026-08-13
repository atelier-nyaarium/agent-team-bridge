package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import android.net.Uri
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.crypto.ownerKeyId
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.ConsolePollResult
import com.atelier_nyaarium.switchboard.proto.FocusIntent
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceKnownVersion
import com.atelier_nyaarium.switchboard.proto.LinkedPeersVersion
import com.atelier_nyaarium.switchboard.proto.PresenceVersion
import com.atelier_nyaarium.switchboard.proto.ReadAnchorsVersion
import com.atelier_nyaarium.switchboard.proto.SessionKey
import com.atelier_nyaarium.switchboard.proto.SyncEntry
import com.atelier_nyaarium.switchboard.proto.SyncPollResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.parseStoreKey
import com.atelier_nyaarium.switchboard.proto.parseTarget
import java.io.File
import java.time.ZoneId
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/** Wraps a drained MailboxEntry as a SyncEntry so the SyncCursor rules can dedupe/advance
 * by seq while the poll loop keeps the full entry to render. */
private data class Drained(val entry: MailboxEntry) : SyncEntry {
	override val seq: Long get() = entry.seq
}

/**
 * Chat state over a ConsoleClient. Holds per-team threads, an unread tally, the open
 * tab set, and a poll loop that drains the device mailbox, dedupes by mailbox seq,
 * and routes each reply to its team (parsed from the `conv.<id>.<domain>.<gateway>.<spawn>.<session>`
 * session id or the entry's `from`). Transcripts persist encrypted so history survives restarts.
 */
class ChatRepository(
	internal val store: AppStateStore,
	// internal (not private): BoardOps reads every attachment's on-disk bucket location directly.
	internal val filesDir: File,
	private val contentResolver: ContentResolver,
	// STTS provider catalog, parsed + validated once from the bundled asset by
	// Repo.get. Empty only if the asset is missing/corrupt (Play stays dark).
	private val sttsCatalog: List<com.atelier_nyaarium.switchboard.proto.SttsProvider> = emptyList(),
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
	private val persistence = ChatPersistence(store)

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
	private fun canonicalTarget(team: String): String =
		runCatching { parseTarget(team, localDomain(), localGatewayId).canonical }.getOrDefault(team)

	/** A `from` field (a canonical address or a local team field) resolved to its canonical address
	 * for thread attribution, or null when it is not an address (a free-form Device Name). Null lets
	 * the caller fall back to the store-key sender instead of keying a thread by a non-address - which
	 * would otherwise become an unsendable ghost chat. */
	private fun fromCanonical(from: String): String? =
		runCatching { parseTarget(from, localDomain(), localGatewayId).canonical }.getOrNull()

	/** This device's own session address. The spawn segment is the OWNER id (matching the gateway's
	 * consoleSelfAddress), NOT the free-form device name, so a device name with spaces/capitals no
	 * longer breaks the self-thread check. Null only when the owner key is not yet available. */
	private fun thisDeviceAddress(): Address? =
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
	private val mailboxSync = MailboxSync(store)
	// The background poll cadence ladder. `store` already implements IdleSilenceStore; the
	// service wires its own scheduler (alarm + wakelock side effects) in after construction, the
	// same pattern as onInbound below.
	val pushback = IdlePushbackManager(store, System.currentTimeMillis()) { ZoneId.systemDefault() }
	// Wired by the service, mirroring pushback's own scheduler seam.
	@Volatile var scheduledSendScheduler: ScheduledSendAlarmScheduler? = null
	// Serializes fireDueScheduledSends() so the cold-boot chain's own unconditional call and a
	// warm alarm-kick's call can never both convert the same due record into two duplicate rows -
	// the same double-fire shape DurableOpStore exists to close for send/respond, applied here at
	// the client layer instead. Ordinary schedule/cancel/edit mutations do NOT take this
	// lock (they are plain, fast, _state.update-only ops like every other mutation in this file);
	// only the fire path's check-then-convert sequence needs the exclusion.
	private val scheduledSendFireMutex = Mutex()

	// Single-flight latch for fetchPendingAttachments, which the poll loop fires once per pass while
	// a transfer routinely spans several. Not a Mutex: an overlapping pass has nothing to add, since
	// the in-flight run re-derives the same pending set, so it should be dropped rather than queued.
	private val fetchingAttachments = java.util.concurrent.atomic.AtomicBoolean(false)

	// Consecutive failed fetches per blobId. Keyed by blob rather than by row because one unreachable
	// reference can appear on several rows and is one unfetchable thing. In-memory on purpose: a
	// restart is exactly when a previously-hopeless fetch deserves another try.
	private val attachmentFetchFailures = java.util.concurrent.ConcurrentHashMap<String, Int>()

	// Blobs the fetch has GIVEN UP on (bounded tries exhausted), for any UI that must distinguish
	// "arriving" from "will never arrive" - the two were previously the same invisible nothing.
	private val _failedAttachmentFetches = MutableStateFlow<Set<String>>(emptySet())
	val failedAttachmentFetches: StateFlow<Set<String>> = _failedAttachmentFetches

	/** Give a permanently-failed blob another bounded round of tries, deliberately: clears its
	 * failure count (the fetch loop skips anything at the cap, so a retry that does not clear it
	 * would be a button that does nothing) and kicks the fetch. */
	fun retryAttachmentFetch(blobId: String) {
		attachmentFetchFailures.remove(blobId)
		_failedAttachmentFetches.update { it - blobId }
		fetchPendingAttachments()
	}

	// Always available from construction, independent of pollScope (null until startPolling runs)
	// and of SwitchboardService's own lifecycle - a receiver-triggered fire kick must never be a
	// silent no-op the way scheduleAttachmentDelete's best-effort pollScope?.launch is allowed to be
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
	/** Set by the service: called when a scheduled send's bounded one-shot retry also fails, so the
	 * service (which owns NotificationManager) can post the failure notice. Mirrors [onInbound]. */
	var onScheduledSendFailed: ((team: String, opId: String) -> Unit)? = null
	// The Domain trust anchor: owner root key, console member identity, and the keyring
	// the Console resolves every Gateway against before sealing to it.
	internal val federation = FederationManager(store)
	// The federation surface, split into four collaborators by concern (see each class's own doc).
	// Screens call through these (repo.enroll.X, repo.devices.X, ...) rather than on ChatRepository
	// directly.
	internal val enroll = EnrollOps(this)
	internal val devices = DeviceApprovalOps(this)
	internal val domainAdmin = DomainAdminOps(this)
	internal val trust = TrustOps(this)
	// The playback surface (the autoplay queue and every transport control over it) and the
	// repository-side board wiring, split out the same way (see each class's own doc).
	// Must stay declared after `stts` and `repoScope`: PlaybackOps subscribes to the player from its
	// own init, so constructing it earlier reads those fields before they exist.
	internal val playback = PlaybackOps(this)
	internal val boardOps = BoardOps(this)
	// ADMIN-side enroll-invite secrets (handshakeId + pin) minted per staged tenant when the invite
	// blob is built, reused to drive the admin's leg of the in-person compare. Transient like the link
	// ceremony's linkNonce: the in-person flow keeps the detail screen open, and regenerating the
	// invite mints fresh secrets (abandoning the old QR's window). internal: shared by EnrollOps
	// (adminEnrollContext) and DomainAdminOps (regenerateInvite, buildInviteBlob).
	internal val enrollInvites = java.util.concurrent.ConcurrentHashMap<String, EnrollInvite>()
	private var pollFails = 0
	private var pollJob: Job? = null
	// The poll loop's scope, reused to launch auto-TTS preloads that gate the
	// notification (so the audio is cached before the user is pinged).
	private var pollScope: CoroutineScope? = null

	@Volatile internal var sttsClient: SttsClient? = null

	/** True while the Activity is started; drives the poll cadence - chained long-polls while
	 * visible, a tiered silence ladder otherwise (see [IdlePushbackManager]). The mailbox
	 * accumulates server-side either way. */
	@Volatile private var visible = false
	val isVisible: Boolean get() = visible
	// Set alongside `visible = true`: onForeground front-runs the resume-kicked drain, so every
	// message still sitting in the mailbox at resume would otherwise tag arrivedVisible=true (the
	// user never actually saw it). Cleared once the first poll pass since the transition commits,
	// so only the genuinely-backgrounded backlog is tagged not-visible; a live message the NEXT
	// pass drains while still foregrounded tags normally.
	@Volatile private var resumeBacklogPending = false
	private val kick = Channel<Unit>(Channel.CONFLATED)
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
	private val reconciled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	// The raw (pre-tombstone, pre-label-override) team snapshot the presence merge path last saw -
	// never persisted (a fresh process starts with no cache and full-resyncs on its first poll).
	// Re-merging this same cached list against the CURRENT tombstone set is what lets a
	// tombstone's own expiry resurrect a team locally without waiting for a fresh server push -
	// see applyPresence.
	@Volatile private var lastRawTeams: List<Team>? = null

	// This device's currently-declared focus (what poll() presents as `focus`), read fresh on every
	// poll - see declareFocus. Starts "background": a cold app has not yet observed the board or a
	// terminal, so it should not falsely claim the board's ramped cadence before the UI ever renders.
	@Volatile private var currentFocus: FocusIntent = FocusIntent(screen = "background")

	// Non-null only while a poll is actually held open; completing it interrupts that SPECIFIC held
	// poll so a focus transition (declareFocus) or a manual refresh (refreshTeams) reaches the
	// Gateway within about one RTT instead of waiting out the remainder of the current hold (see
	// pollRacingFocusChange). Never touched by anything other than the poll loop's own iteration
	// and those two callers.
	@Volatile private var pollInterrupt: CompletableDeferred<Unit>? = null

	// The presence-plane version(s) this device last applied, presented back as knownPresenceVersions
	// on the NEXT poll so the Gateway ships the snapshot again only once it actually changed. Never
	// persisted (see lastRawTeams) - a fresh process presents an empty list, which the Gateway treats
	// as a cold boot and ships everything once.
	@Volatile private var knownPresenceVersions: List<PresenceVersion> = emptyList()

	// The linked-peers plane version this device last applied, presented back on the NEXT poll -
	// same role as knownPresenceVersions, a single scalar since this Gateway's own roster has no
	// multi-source concept. Null (never persisted) means this session has not applied one yet, which
	// the Gateway treats the same as a legacy client - ship the current roster unconditionally.
	@Volatile private var knownLinkedPeersVersion: LinkedPeersVersion? = null

	// This owner's read-anchors plane version last applied - same role/shape as
	// knownLinkedPeersVersion, for the cross-device read-position sync plane (see applyReadAnchors).
	@Volatile private var knownReadAnchorsVersion: ReadAnchorsVersion? = null

	// Every linked Domain's cross-Domain-presence plane version this device last applied - same
	// ARRAY shape as knownPresenceVersions (genuinely N independently-versioned planes), not a
	// single scalar like knownLinkedPeersVersion/knownReadAnchorsVersion. Updated by a per-domainId
	// UPSERT (see applyCrossDomainPresence), never a wholesale replace, since the wire only ships the
	// changed subset each poll - replacing this list outright would forget every OTHER already-known
	// Domain's version and cause the Gateway to needlessly re-ship them as "unknown" next poll.
	@Volatile private var knownCrossDomainPresenceVersions: List<CrossDomainPresenceKnownVersion> = emptyList()

	// The per-team read anchor last REPORTED to the Gateway (via report_read), so the poll loop
	// reports a team's local anchor only once per genuine local advance instead of every cycle.
	// Never persisted: a fresh process starts empty, so its first cycle re-reports every team's
	// current anchor - a harmless no-op on the Gateway if nothing actually changed (monotonic merge).
	@Volatile private var lastReportedReadAnchors: Map<String, ReadAnchor> = emptyMap()

	/** Set by the service: called per poll with the new inbound messages of one
	 * team, so a background burst can become a notification. */
	var onInbound: ((team: String, messages: List<Message>) -> Unit)? = null

	/** Data-plane subscribers, invoked once per genuinely-new inbound message at the drain gate
	 * (see the poll loop). Delivery is synchronous and pre-commit, so a subscriber inherits the
	 * mailbox cursor's exactly-once + crash-safety; it must be fast, non-blocking, and idempotent. */
	private val inboundSubscribers = java.util.concurrent.CopyOnWriteArrayList<InboundSubscriber>()

	/** Register a data-plane subscriber. Add-once per process (the caller is a singleton); a
	 * duplicate add would double-deliver. */
	fun addInboundSubscriber(subscriber: InboundSubscriber) {
		inboundSubscribers.addIfAbsent(subscriber)
	}

	/** Plugin-action subscribers, invoked once per `plugin_action` mailbox entry at the drain gate.
	 * Delivery is at-least-once (this entry never renders a chat message, so it has no persisted
	 * fold to dedupe a redraw against); a subscriber must be fast, non-blocking, and idempotent. */
	private val pluginActionSubscribers = java.util.concurrent.CopyOnWriteArrayList<PluginActionSubscriber>()

	/** Register a plugin-action subscriber. Add-once per process, same as [addInboundSubscriber]. */
	fun addPluginActionSubscriber(subscriber: PluginActionSubscriber) {
		pluginActionSubscribers.addIfAbsent(subscriber)
	}

	/** The Activity came on screen: gateway to the fast cadence, optimistically
	 * clear a doze-corpse failure banner (the kicked poll re-raises it within
	 * seconds if the bridge is genuinely down), and poll right now. */
	fun onForeground() {
		visible = true
		resumeBacklogPending = true
		pollFails = 0
		_state.update { it.copy(error = null, pollFailStreak = 0, enrollingSince = 0L, foreground = true) }
		kick.trySend(Unit)
	}

	fun onBackground() {
		visible = false
		pushback.onBackground(System.currentTimeMillis())
		declareFocus(FocusIntent(screen = "background"))
		_state.update { it.copy(foreground = false) }
	}

	/** Wakes the poll loop immediately - the alarm receiver's bridge into a possibly-parked pass. */
	fun kickPoll() {
		kick.trySend(Unit)
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
		if (prior != focus) pollInterrupt?.complete(Unit)
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
	@Volatile private var pluginReportPending = false

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

	/** STTS client from the settings-backed creds (NOT the blob), or null when not
	 * configured. The cache is invalidated by setSttsCreds() on an in-app edit, the
	 * one mutation point - so an edited key takes effect without an app restart. */
	// internal (not private): PlaybackOps resolves the client for every actual playback call.
	internal fun sttsClient(): SttsClient? {
		sttsClient?.let { return it.takeIf { c -> c.isConfigured } }
		// Cache only a configured client, so an unconfigured build (fresh install, no key yet)
		// is not retained as an idle OkHttpClient until creds arrive.
		return SttsClient(store.sttsUrl, store.sttsKey).takeIf { it.isConfigured }?.also { sttsClient = it }
	}

	/** Gates the Play surfaces; true once settings carry sttsUrl + sttsKey AND the
	 * bundled catalog parsed (without descriptors there is nothing to play). */
	fun sttsReady(): Boolean = sttsClient() != null && sttsCatalog.isNotEmpty()

	/** True when settings carry a non-empty url + key (the Connection block is
	 * configured), independent of catalog/health. */
	fun sttsConfigured(): Boolean = store.sttsUrl.isNotEmpty() && store.sttsKey.isNotEmpty()

	/** The current in-app voice creds, for seeding the settings Connection fields. */
	val sttsUrl: String get() = store.sttsUrl
	val sttsKey: String get() = store.sttsKey

	/** The single mutation choke for the in-app voice creds: validate+normalize the URL
	 * (via normalizeSttsUrl, so the key is never persisted to an unvalidated host), store the
	 * clean origin + trimmed key, and invalidate the cached client so the next sttsClient()
	 * rebuilds. Returns the stored origin, or null if the URL is invalid (nothing persisted),
	 * which the caller surfaces. Enforcing validation HERE means no caller can bypass it. */
	fun setSttsCreds(url: String, key: String): String? {
		val origin = normalizeSttsUrl(url) ?: return null
		store.sttsUrl = origin
		store.sttsKey = key.trim()
		sttsClient = null
		return origin
	}

	/** The provider descriptors for the settings picker. */
	fun sttsProviders(): List<com.atelier_nyaarium.switchboard.proto.SttsProvider> = sttsCatalog

	/** The selected provider id (the descriptor id, e.g. "XAI"). Unset resolves
	 * to XAI when present, else the first descriptor. */
	var sttsProviderId: String
		get() {
			val stored = store.sttsProvider
			if (stored.isNotEmpty()) return stored
			return sttsCatalog.firstOrNull { it.id == "XAI" }?.id ?: sttsCatalog.firstOrNull()?.id ?: ""
		}
		set(value) {
			store.sttsProvider = value
		}

	/** The descriptor for the current selection, or null if the stored id is not
	 * in the catalog (a removed provider) - the Play surfaces disable loudly
	 * rather than silently substituting another voice. */
	// internal (not private): PlaybackOps resolves the provider for every actual playback call.
	internal fun currentProvider(): com.atelier_nyaarium.switchboard.proto.SttsProvider? {
		val id = sttsProviderId
		return sttsCatalog.firstOrNull { it.id == id }
	}

	/** True when the stored provider id is non-empty but absent from the catalog. */
	fun sttsProviderMissing(): Boolean {
		val id = store.sttsProvider
		return id.isNotEmpty() && sttsCatalog.none { it.id == id }
	}

	/** Per-provider voice; blank uses the descriptor default. */
	fun sttsVoiceFor(providerId: String): String = store.sttsVoiceFor(providerId)

	fun setSttsVoiceFor(providerId: String, voice: String) = store.setSttsVoiceFor(providerId, voice.trim())

	/** The run-start sound, as a content Uri. Empty means the bundled asset; [CHIME_SILENT] means the
	 * user chose no sound at all, which is a decision rather than an unset preference. Persisted. */
	var sttsChimeUri: String
		get() = store.chimeUri
		set(value) {
			store.chimeUri = value
		}

	/** When on, an incoming message for a followed (open) thread is
	 * pre-synthesized before its notification. Persisted in prefs. */
	var sttsAutoGen: Boolean
		get() = store.autoTts
		set(value) {
			store.autoTts = value
		}

	/** Which tier of a new message plays aloud automatically the moment it
	 * arrives. One of "off", "title", "summary", "full". Independent of
	 * sttsAutoGen. Persisted in prefs. */
	var sttsAutoPlay: String
		get() = store.autoPlay
		set(value) {
			store.autoPlay = value
		}

	/** The SAF tree the user chose to save attachments into. Raw string: whether the grant behind it
	 * is still alive is SaveTarget's question, and a caller must ask it rather than trust this. */
	var saveTreeUri: String
		get() = store.saveTreeUri
		set(value) {
			store.saveTreeUri = value
		}

	/** TTS playback volume, 0-200% (100 = unchanged). Persisted in prefs. */
	var sttsVolume: Int
		get() = store.sttsVolume
		set(value) {
			store.sttsVolume = value
		}

	/** The chime's own volume, 0-200%. Its own control because it is balanced against the speech that
	 * follows it, not against whatever else the phone is playing. */
	var sttsChimeVolume: Int
		get() = store.sttsChimeVolume
		set(value) {
			store.sttsChimeVolume = value
		}

	/** STTS service liveness WITH the failure cause, for the settings Connection status line. */
	suspend fun sttsProbe(): SttsProbe =
		withContext(Dispatchers.IO) { sttsClient()?.probe() ?: SttsProbe.Unreachable("not configured") }

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
			if (!enroll.firstRootIfPending()) return@withContext
			// Reflect the first-root latch into the UI state now, so if the steps below fail with the
			// no-gateway cause (a freshly-rooted friend has no host yet) the empty board shows the
			// "set up, now bring up a host" guidance rather than the admin Add-a-Gateway CTA.
			if (store.firstRooted && !_state.value.firstRooted) _state.update { it.copy(firstRooted = true) }
			// Submit this Console's own admission before the sealed register, so the Gateway
			// has an owner-signed reason to trust its sealed ops. Bearer-gated, so it lands
			// even though the Console is not admitted yet. A THROW here (e.g. the Keystore-backed
			// store is unavailable, so the member identity cannot be persisted) is the REAL cause;
			// surface it instead of falling through to register()'s generic "not enrolled".
			runCatchingCancellable { enroll.submitConsoleAdmission() }.onFailure { e ->
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

	/** Serializes every read-modify-write of knownCrossDomainPresenceVersions: applyLinkedPeers and
	 * applyCrossDomainPresence both merge against its OWN prior value (a filter/upsert, not a plain
	 * replace like the sibling knownPresenceVersions/knownLinkedPeersVersion fields), and refreshTeams()
	 * resets it from a DIFFERENT coroutine (a manual pull-to-refresh, not the poll loop) - both run on
	 * Dispatchers.IO's multi-threaded pool, so an unguarded compound operation could lose the reset
	 * underneath a poll response still applying stale pre-reset data. Mirrors freshTeamsMutex's own
	 * rationale for the identical concurrent-caller pair below. */
	private val crossDomainVersionsMutex = Mutex()

	/** Apply the linked-peers plane's pushed snapshot into state, so TrustOps.linkedDomains() can union it
	 * with discovery. The one writer of linkedPeerOwners - the poll loop calls this when a poll
	 * response carries `linkedPeers` (a real change; see PlaneRegistry). Folds the per-gateway peer
	 * rows to their distinct Domain ids (a Domain may run more than one gateway). */
	private suspend fun applyLinkedPeers(peers: List<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry>) {
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
		crossDomainVersionsMutex.withLock {
			knownCrossDomainPresenceVersions = knownCrossDomainPresenceVersions.filter { it.domainId in owners }
		}
	}

	/** Apply the cross-Domain-presence plane's pushed/pulled entries into state: a per-domainId
	 * UPSERT (never a wholesale replace - see crossDomainPeerSessions' own doc), since the wire only
	 * carries the SUBSET of linked Domains whose plane actually changed this poll. The one writer of
	 * crossDomainPeerSessions - the poll loop calls this when a poll response carries
	 * `crossDomainPresence`. */
	private suspend fun applyCrossDomainPresence(entries: List<CrossDomainPresenceEntry>) {
		crossDomainVersionsMutex.withLock {
			knownCrossDomainPresenceVersions = upsertKnownCrossDomainPresenceVersions(knownCrossDomainPresenceVersions, entries)
		}
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
	private fun applyReadAnchors(entries: List<com.atelier_nyaarium.switchboard.proto.ReadAnchorWireEntry>) {
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
	private suspend fun reportLocalReadAdvances() {
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
		knownPresenceVersions = emptyList()
		knownLinkedPeersVersion = null
		knownReadAnchorsVersion = null
		crossDomainVersionsMutex.withLock { knownCrossDomainPresenceVersions = emptyList() }
		pollInterrupt?.complete(Unit)
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
	private suspend fun applyPresence(fresh: List<Team>) {
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

	private suspend fun reapplyCachedTeams() {
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

	suspend fun send(team: String, text: String, uris: List<Uri> = emptyList()) = withContext(Dispatchers.IO) {
		val (picked, refused) = admitPicked(uris, "pick-${java.util.UUID.randomUUID()}")
		if (refused != null) {
			_state.update { it.copy(error = refused.message()) }
			return@withContext
		}
		// Local echo: persist the picked files so the sent message shows its own thumbnails through
		// the same asset-loader path as inbound files. The echo starts "pending" and resolves to
		// sent (null) or "error" when the op lands. Bucketed by opId (globally unique), not a bare
		// millis timestamp - two sends in the same millisecond would otherwise collide on one
		// bucket dir, and forget()/reconcileSent's per-file delete cannot protect two rows that
		// share the identical src.
		val opId = java.util.UUID.randomUUID().toString()
		val localFiles = Attachments.storeOutgoing(filesDir, "out-$opId", picked)
		val echoId = append(
			team,
			Message(true, text, System.currentTimeMillis(), files = localFiles, status = "pending", opId = opId),
		)
		val wasAvailable = _state.value.teams.firstOrNull { it.name == team }?.status == "available"
		// Cold wake takes minutes with no wire traffic, so say so - as a notice card (ChatState.
		// wakingTeams), not a transcript row. Only the send that RAISES the notice may clear it on
		// failure, so a second send failing while the first is still in flight leaves the wait intact.
		val raisedWakeNotice = wasAvailable && team !in _state.value.wakingTeams
		if (raisedWakeNotice) _state.update { it.copy(wakingTeams = it.wakingTeams + team) }
		deliver(team, echoId, text, picked, opId, raisedWakeNotice)
	}

	/** Re-send a failed message, rebuilding attachment bytes from their local
	 * copies. The error -> pending flip is the atomic claim: a double-tap's second
	 * coroutine finds the row already pending and backs off, so the wire send runs
	 * once. The original opId is reused so the gateway dedupes a lost-reply retry.
	 * `targetDomainOverride` is passed straight through to [deliver] - used by a scheduled send's
	 * own bounded retry, whose banked targetDomainId must survive a cold process the same way the
	 * original fire itself does (state.teams is empty until connect() completes). */
	suspend fun retrySend(team: String, messageId: Long, targetDomainOverride: String? = null) = withContext(Dispatchers.IO) {
		var claimed = false
		_state.update { s ->
			val thread = s.threads[team] ?: return@update s.also { claimed = false }
			val msg = thread.firstOrNull { it.id == messageId }
			if (msg == null || !msg.fromMe || msg.status != "error") {
				claimed = false
				s
			} else {
				claimed = true
				// A retry submits the message NOW, so it belongs at the end of the thread rather than
				// back at its original position: anything that arrived while it sat failed genuinely
				// came first, and leaving it above them would misreport the order of the conversation.
				val retried = msg.copy(status = "pending", at = System.currentTimeMillis())
				s.copy(threads = s.threads + (team to (thread.filterNot { it.id == messageId } + retried)))
			}
		}
		if (!claimed) return@withContext
		val msg = _state.value.threads[team]?.firstOrNull { it.id == messageId } ?: return@withContext
		persistence.persistThreads(_state.value.threads)
		val (files, refused) = rebuildFiles(msg)
		if (refused != null) {
			setMessageStatus(team, messageId, "error")
			_state.update { it.copy(error = refused.message()) }
			return@withContext
		}
		if (msg.text.isBlank() && files.isEmpty()) {
			// Nothing recoverable (attachment copies gone); put the badge back and say why.
			setMessageStatus(team, messageId, "error")
			_state.update { it.copy(error = "Attachments are no longer on this device; cannot retry.") }
			return@withContext
		}
		if (files.size < msg.files.size) {
			_state.update { it.copy(error = "Some attachments are no longer on this device; resending the rest.") }
		}
		deliver(team, messageId, msg.text, files, msg.opId ?: java.util.UUID.randomUUID().toString(), false, targetDomainOverride)
	}

	/** Bank `text`/`uris` as a scheduled send for `team`, firing at `fireAtMillis` on its own even if
	 * the app is backgrounded or killed in the meantime. Replaces any
	 * existing scheduled send for this team - the dock is the sole edit/reschedule surface, so a
	 * second `Schedule Send` on an already-scheduled team is a deliberate replace, not a queue. Any
	 * `content://` uri is eagerly copied into its own bucket now (a transient grant may not outlive
	 * the wait); `targetDomainId` is resolved now too, from the same live `teams` entry the composer
	 * has on screen - `deliver()`'s own internal resolution reads `state.teams`, empty on a cold fire
	 * until `connect()` completes, so re-deriving it at fire time would silently drop a cross-Domain
	 * target. Returns false (nothing banked) for a non-future time or oversized attachments.  */
	suspend fun scheduleSend(team: String, text: String, uris: List<Uri>, fireAtMillis: Long): Boolean =
		withContext(Dispatchers.IO) {
			val now = System.currentTimeMillis()
			if (fireAtMillis <= now) {
				// Reachable in practice, not just in theory: the dialog's own gate is evaluated once per
				// recomposition and never re-checked against a live clock while the user idles on the
				// picker - an error here (matching the oversized-attachment branch below) is the caller's
				// only signal that nothing was banked, since silently returning false with no error would
				// leave the user believing a send went out that never did.
				_state.update { it.copy(error = "That time has already passed - try scheduling again.") }
				return@withContext false
			}
			if (fireAtMillis - now > SCHEDULED_SEND_MAX_HORIZON_MS) {
				_state.update { it.copy(error = "Can't schedule more than 30 days out.") }
				return@withContext false
			}
			val (picked, refused) = admitPicked(uris, "pick-${java.util.UUID.randomUUID()}")
			if (refused != null) {
				_state.update { it.copy(error = refused.message()) }
				return@withContext false
			}
			val opId = java.util.UUID.randomUUID().toString()
			val fileRefs = Attachments.storeOutgoing(filesDir, "sched-$opId", picked)
			val adminDomain = confirmedDomainId()
			val canonical = canonicalTarget(team)
			val targetDomainId = _state.value.teams
				.firstOrNull { it.name == canonical }
				?.domainId
				?.takeIf { it.isNotEmpty() && adminDomain != null && it != adminDomain }
			val rec = ScheduledSend(text, fileRefs, fireAtMillis, opId, targetDomainId, System.currentTimeMillis())
			val prior = _state.value.scheduledSends[team]
			val next = _state.updateAndGet { s -> s.copy(scheduledSends = s.scheduledSends + (team to rec)) }.scheduledSends
			persistence.persistScheduledSends(next)
			rearmScheduledSendAlarm(next)
			// A replace's old bucket is now unreferenced - clean it up the same way forget() does,
			// never inline (best-effort, off pollScope, healed by the next sweepOrphanAttachments if
			// this misses its narrow pollScope-null window).
			prior?.let { scheduleAttachmentDelete(it.fileRefs.mapNotNull { f -> f.src }) }
			true
		}

	/** Cancel team's scheduled send (if any): clears the record, re-arms the alarm to whatever is now
	 * earliest (or cancels it if nothing remains), and deletes the now-orphaned attachment bucket -
	 * UNLESS a fire already raced ahead of this cancel and claimed the same opId into a live thread
	 * row first (fireOne appends that row, deliberately, BEFORE it clears the record - see fireOne's
	 * own doc - so there is a real window where both the record and the row briefly coexist). This
	 * function is not mutex-guarded against fireOne (making it suspend to share scheduledSendFireMutex
	 * would ripple into every UI call site), so the two can genuinely interleave; the check below is
	 * what keeps that interleaving safe rather than deleting files a live row now depends on. */
	fun cancelScheduledSend(team: String) {
		val prior = clearScheduledSendRecord(team) ?: return
		val claimedByLiveRow = _state.value.threads[team]?.any { it.opId == prior.opId } == true
		if (!claimedByLiveRow) scheduleAttachmentDelete(prior.fileRefs.mapNotNull { it.src })
	}

	/** Cancel team's scheduled send and hand its content back into the composer instead of deleting
	 * its attachment bucket - the dock's cancel-to-restore action, where the draft becomes the
	 * bucket's new owner (the same ownership-transfer shape as fireOne's own clearScheduledSendRecord
	 * call). A restored-then-abandoned bucket still self-heals: dropping the record from
	 * scheduledSends removes it from sweepOrphanAttachments' referenced set (the draft's own files
	 * join that set instead - see sweepOrphanAttachments), so the next cold-start sweep reclaims it
	 * exactly like any other orphaned bucket. A no-op if nothing was scheduled, or if a fire already
	 * raced ahead and claimed the same opId into a live row first (see cancelScheduledSend's own doc
	 * on that race) - there is nothing left to restore once the message has genuinely gone out. */
	fun cancelScheduledSendForEdit(team: String) {
		val prior = clearScheduledSendRecord(team) ?: return
		val claimedByLiveRow = _state.value.threads[team]?.any { it.opId == prior.opId } == true
		if (!claimedByLiveRow) takeBackIntoDraft(team, prior.text, prior.fileRefs)
	}

	/** Change ONLY the fire time of team's existing scheduled send - the dock's tap-to-edit action.
	 * Deliberately narrower than a full text/attachment re-edit: the banked fileRefs are already-
	 * copied MessageFile refs, not the live content:// uris scheduleSend takes, so folding a fuller
	 * edit through that same call without a dedicated seam would risk silently dropping them. A
	 * plain time change has no such mismatch - text/fileRefs/opId/targetDomainId all carry over via
	 * copy(). Returns false (no-op) for a non-future time or if nothing is currently scheduled. */
	fun rescheduleSend(team: String, fireAtMillis: Long): Boolean {
		val now = System.currentTimeMillis()
		if (fireAtMillis <= now) {
			// Same reachable-in-practice race as scheduleSend's own past-time branch (the dialog's own
			// gate can go stale while the user idles on the picker) - the existing record is left with
			// its old time rather than destroyed, but the user still needs to know the pick did not
			// take effect.
			_state.update { it.copy(error = "That time has already passed - try scheduling again.") }
			return false
		}
		if (fireAtMillis - now > SCHEDULED_SEND_MAX_HORIZON_MS) {
			_state.update { it.copy(error = "Can't schedule more than 30 days out.") }
			return false
		}
		val prior = _state.value.scheduledSends[team] ?: return false
		val next = _state.updateAndGet { s ->
			s.copy(scheduledSends = s.scheduledSends + (team to prior.copy(fireAtMillis = fireAtMillis)))
		}.scheduledSends
		persistence.persistScheduledSends(next)
		rearmScheduledSendAlarm(next)
		return true
	}

	/** Remove team's scheduled-send record from state + persistence and re-arm the alarm, WITHOUT
	 * touching its attachment bucket - the fire path (below) transfers that bucket's ownership to a
	 * live thread row instead of orphaning it, so only the user-facing cancel/replace paths delete
	 * it. Returns the removed record (if any) so the caller decides. */
	private fun clearScheduledSendRecord(team: String): ScheduledSend? {
		val prior = _state.value.scheduledSends[team] ?: return null
		val next = _state.updateAndGet { s -> s.copy(scheduledSends = s.scheduledSends - team) }.scheduledSends
		persistence.persistScheduledSends(next)
		rearmScheduledSendAlarm(next)
		return prior
	}

	/** Re-arm the single shared "next-due" alarm to the earliest fireAtMillis across every team's
	 * record, or cancel it once none remain. Called after every mutation to scheduledSends. */
	private fun rearmScheduledSendAlarm(current: Map<String, ScheduledSend> = _state.value.scheduledSends) {
		val next = current.values.minOfOrNull { it.fireAtMillis }
		if (next != null) scheduledSendScheduler?.scheduleNext(next) else scheduledSendScheduler?.cancelNext()
	}

	/** Bounded wait for the service to finish wiring [scheduledSendScheduler] (and
	 * [onScheduledSendFailed]) via SwitchboardService.onCreate's own synchronous
	 * `repo.scheduledSendScheduler = this` line. Only the WARM kicks below need this: a dead-process
	 * revival's alarm receiver calls SwitchboardService.start(context) - which only REQUESTS an
	 * async service start; onCreate() itself runs later on the main thread - and then, in the same
	 * onReceive call, kicks straight into [repoScope], which has no dependency on onCreate having
	 * run at all. Without this wait, a fire that fails (or a retry that fails) in that narrow window
	 * would find scheduledSendScheduler/onScheduledSendFailed still null and silently skip arming the
	 * retry or posting the failure notification - the one thing this feature promises never to do
	 * silently. The cold-boot chain's own direct fireDueScheduledSends() call never needs this: it
	 * runs later in the SAME onCreate() that already set scheduledSendScheduler synchronously,
	 * earlier in that function. Gives up after a bounded wait rather than forever - an unprovisioned
	 * device's onCreate() calls stopSelf() immediately and never wires anything, and this must not
	 * leak a coroutine on repoScope forever in that case; proceeding anyway after the deadline just
	 * means scheduleRetry/onScheduledSendFailed stay no-ops for this one attempt, same as today. */
	private suspend fun awaitSchedulerWired() {
		val deadline = System.currentTimeMillis() + SCHEDULER_WIRE_WAIT_MS
		while (scheduledSendScheduler == null && System.currentTimeMillis() < deadline) delay(50)
	}

	/** Entry point for a WARM alarm kick - a BroadcastReceiver cannot suspend, so this launches on
	 * [repoScope] (always available, unlike [pollScope]) rather than awaiting inline. The cold-boot
	 * chain instead awaits [fireDueScheduledSends] directly as its own unconditional step (see
	 * SwitchboardService.onCreate). Both funnel through the same mutex-guarded function, so a warm
	 * kick can never double-convert the same due record with a concurrent cold-chain call - but the
	 * mutex alone does NOT guarantee the warm kick waits for connect() to have run first (see
	 * awaitSchedulerWired's own doc for why). That residual ordering gap is accepted rather than
	 * more heavily engineered around. */
	fun kickScheduledSendFire() {
		repoScope.launch {
			awaitSchedulerWired()
			fireDueScheduledSends()
		}
	}

	/** Convert every currently-due scheduled send into a live, delivered (or delivering) row, then
	 * re-arm the alarm to whatever is next. Safe to call with nothing due - the cold-boot chain calls
	 * this unconditionally on every start (connect() swallows its own failures internally and must
	 * not gate this, or an offline cold fire would never reach deliver()'s failure path and the
	 * bounded-retry policy below would never trigger). */
	suspend fun fireDueScheduledSends() = scheduledSendFireMutex.withLock {
		while (true) {
			val now = System.currentTimeMillis()
			val due = _state.value.scheduledSends.entries.firstOrNull { it.value.fireAtMillis <= now } ?: break
			fireOne(due.key, due.value)
		}
		rearmScheduledSendAlarm()
	}

	/** Convert one due record into a row and attempt delivery. Idempotent against a crash between
	 * appending the row and clearing the record: a re-arm that finds the row already present (by
	 * opId - persisted per row, so this check survives restarts) treats it as already-fired and only
	 * finishes the clear, never re-appending or re-delivering. */
	private suspend fun fireOne(team: String, rec: ScheduledSend) {
		val alreadyFired = _state.value.threads[team]?.any { it.opId == rec.opId } == true
		if (!alreadyFired) {
			val echoId = append(
				team,
				Message(true, rec.text, System.currentTimeMillis(), files = rec.fileRefs, status = "pending", opId = rec.opId),
			)
			// clearScheduledSendRecord, not cancelScheduledSend: the bucket's ownership just
			// transferred to the row above, so deleting it here would strand that row's attachments.
			clearScheduledSendRecord(team)
			val (picked, _) = rebuildFiles(rec.fileRefs)
			deliver(team, echoId, rec.text, picked, rec.opId, false, rec.targetDomainId)
			if (_state.value.threads[team]?.firstOrNull { it.opId == rec.opId }?.status == "error") {
				val at = System.currentTimeMillis() + SCHEDULED_SEND_RETRY_DELAY_MS
				scheduledSendScheduler?.scheduleRetry(at, team, rec.opId, rec.targetDomainId)
			}
		} else {
			clearScheduledSendRecord(team)
		}
		// Sending is a strong signal of imminent live interaction - the same nudge onForeground()
		// gives the idle-pushback ladder, without foreground's other side effects (this may well be
		// firing while genuinely backgrounded).
		pushback.onCommsActivity(System.currentTimeMillis(), visible)
	}

	/** The warm alarm kick for one team's bounded one-shot retry after a failed fire (see [fireOne]).
	 * Resolves the row fresh by opId, never by a banked Message.id - ids are reassigned densely on
	 * every load, so an id banked in the retry alarm's PendingIntent would go stale across a process
	 * death between arming and firing. A row not found in "error" state (already retried by hand,
	 * forgotten, or - defensively - still pending) is left alone; posts the failure notification only
	 * if THIS retry also fails, never on the happy path. */
	fun kickScheduledSendRetry(team: String, opId: String, targetDomainId: String?) {
		repoScope.launch {
			awaitSchedulerWired()
			val id = _state.value.threads[team]?.firstOrNull { it.opId == opId && it.status == "error" }?.id
				?: return@launch
			retrySend(team, id, targetDomainId)
			if (_state.value.threads[team]?.firstOrNull { it.opId == opId }?.status == "error") {
				onScheduledSendFailed?.invoke(team, opId)
			}
		}
	}

	/** Run the wire send and settle the echo row's state from the outcome. On success the cold-wake
	 * notice (if this send raised one) MUST survive: the wake itself is what takes minutes, and
	 * appendInbound drops the notice when the real reply arrives. On failure or cancellation, nothing
	 * is coming to clear it, so it is dropped here. */
	private suspend fun deliver(
		team: String,
		echoId: Long,
		text: String,
		picked: List<OutgoingFile>,
		opId: String,
		raisedWakeNotice: Boolean,
		targetDomainOverride: String? = null,
	) {
		var succeeded = false
		fun fail(message: String?) {
			_state.update { it.copy(error = message ?: "send failed") }
			setMessageStatus(team, echoId, "error")
		}
		try {
			// A cross-Domain target carries the friend Domain id from its discovery entry, so the
			// gateway resolves the seal target by the full (domainId, gatewayId) pair; a local /
			// same-Domain session resolves to null and keeps the existing routing. A cold scheduled-
			// send fire supplies targetDomainOverride instead: state.teams is empty until connect()
			// completes, so re-deriving here would silently drop a cross-Domain target banked at
			// schedule time (see ScheduledSend.targetDomainId).
			val targetDomain = targetDomainOverride ?: run {
				val adminDomain = confirmedDomainId()
				val canonical = canonicalTarget(team)
				_state.value.teams
					.firstOrNull { it.name == canonical }
					?.domainId
					?.takeIf { it.isNotEmpty() && adminDomain != null && it != adminDomain }
			}
			val r = client().send(team, text, picked, opId, targetDomain)
			when {
				!r.ok -> fail(r.error)
				else -> {
					succeeded = true
					setMessageStatus(team, echoId, null)
				}
			}
		} catch (e: Exception) {
			// MUST be the first statement: classifyConnError must never see a CancellationException
			// (same discipline as the poll loop's own catch), and a swallowed cancel here would
			// mark this row "error" even though nothing actually failed - a cancelled attempt
			// leaves the row "pending" for reconcilePending to retry, not "error".
			e.rethrowIfCancellation()
			// Route through the same classifier the poll loop + connect use, so a send
			// surfaces a legible cause ("Can't reach the server", "Bridge token rejected")
			// instead of a raw "HTTP 401: {json}" exception string.
			val (cause, _) = classifyConnError(e)
			fail(cause)
		} finally {
			// Only on a non-success exit (fail() above, or a cancellation rethrow that skips fail()):
			// "Waking..." is a per-ATTEMPT indicator, so a cancelled cold-wake send must not strand it,
			// while a SUCCEEDED send's notice must be left alone (see the doc above). On the
			// cancellation path this runs while a CancellationException is actively propagating, so
			// nothing here may throw - a throw would replace the propagating cancel and silently defeat
			// reconcilePending's rollback (see its own catch below).
			if (!succeeded && raisedWakeNotice) _state.update { it.copy(wakingTeams = it.wakingTeams - team) }
		}
	}

	/** Re-admit the local attachment copies stored at first send. Admission stats rather than
	 * reads, so a row too large for this device is refused here instead of dying at the encode. */
	private fun rebuildFiles(msg: Message): Pair<List<OutgoingFile>, Admission.Refused?> = rebuildFiles(msg.files)

	/** Same rebuild, from a bare file-ref list - shared with a scheduled send's eagerly-copied
	 * bucket, which has no Message row to rebuild from until the fire itself appends one. */
	private fun rebuildFiles(files: List<MessageFile>): Pair<List<OutgoingFile>, Admission.Refused?> {
		val admitted = mutableListOf<OutgoingFile>()
		var blocker: Admission.Refused? = null
		for (a in OutgoingFiles.admitAll(files, filesDir)) {
			when (a) {
				is Admission.Granted -> admitted += a.file
				// A missing copy has always been survivable (send the rest, say so); a size refusal
				// is not, because sending "the rest" would silently drop what the user attached.
				is Admission.Refused ->
					if (a.reason == Admission.Reason.GONE) Unit else if (blocker == null) blocker = a
			}
		}
		return admitted to blocker
	}

	/**
	 * Take a failed send back out of the thread and hand its content to the composer, so a message
	 * that cannot be sent as-is can be edited instead of only retried or abandoned. The row is
	 * dropped only once its content is staged for restore, so nothing is destroyed on the way.
	 *
	 * Attachment copies ride along into the same picker slot a fresh pick uses; any whose bytes are
	 * already gone are simply absent, exactly as a retry treats them.
	 */
	fun cancelFailedSend(team: String, messageId: Long) {
		val msg = _state.value.threads[team]?.firstOrNull { it.id == messageId } ?: return
		if (!msg.fromMe || msg.status != "error") return
		val refs = msg.files.filter { Attachments.fileFor(filesDir, it.src) != null }
		takeBackIntoDraft(team, msg.text, refs)
		removeMessage(team, messageId)
	}

	private fun removeMessage(team: String, id: Long) {
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team] ?: return@updateAndGet s
			s.copy(threads = s.threads + (team to thread.filterNot { it.id == id }))
		}.threads
		persistence.persistThreads(threads)
	}

	private fun setMessageStatus(team: String, id: Long, status: String?) {
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team] ?: return@updateAndGet s
			s.copy(threads = s.threads + (team to thread.map { if (it.id == id) it.copy(status = status) else it }))
		}.threads
		persistence.persistThreads(threads)
	}

	/** Stage picked Uris under one cumulative admission budget. Each is streamed to disk, never
	 * held whole, and the first refusal is reported rather than silently dropping the file. */
	// internal (not private): BoardOps.boardSetAttachmentsNow admits a board entry's newly picked
	// files through this same budget.
	internal fun admitPicked(uris: List<Uri>, bucket: String): Pair<List<OutgoingFile>, Admission.Refused?> {
		val staged = mutableListOf<OutgoingFile>()
		val dir = File(Attachments.root(filesDir), bucket)
		var running = 0L
		for ((i, uri) in uris.withIndex()) {
			when (val a = OutgoingFiles.admit(contentResolver, uri, File(dir, "staged-$i"))) {
				is Admission.Refused -> {
					staged.forEach { it.source.delete() }
					return emptyList<OutgoingFile>() to a
				}
				is Admission.Granted -> {
					running += a.file.size
					if (running > MAX_OUTGOING_BYTES) {
						staged.forEach { it.source.delete() }
						a.file.source.delete()
						return emptyList<OutgoingFile>() to
							Admission.Refused(a.file.name, Admission.Reason.OVER_TRANSPORT, running, MAX_OUTGOING_BYTES)
					}
					staged += a.file
				}
			}
		}
		return staged to null
	}

	/** Runs [block] (the poll call), but abandons it early - returning null - if a focus transition
	 * (declareFocus) or a manual refresh (refreshTeams) interrupts it mid-hold. The caller simply
	 * loops again immediately with the fresh focus/knownPresenceVersions: an ordinary
	 * abandoned-request disconnect from the Gateway's own side (nothing to reconcile - the
	 * interrupted call never reached mailboxSync.advance at all). `select` races the poll against
	 * the interrupt signal so the LOSER is cancelled by construction rather than hand-rolled
	 * exception matching: coroutineScope waits for both children (the poll and the interrupt
	 * watcher) to fully settle before this function returns, so a cancelled poll's underlying
	 * OkHttp call is guaranteed torn down, never orphaned, before the loop re-issues a fresh one -
	 * and since the CancellationException this produces never escapes past the `select` itself,
	 * the outer poll loop's own teardown-detection (e.rethrowIfCancellation) never mistakes this
	 * intentional, self-contained interrupt for the whole pollJob being torn down. */
	private suspend fun pollRacingFocusChange(block: suspend () -> ConsolePollResult): ConsolePollResult? =
		coroutineScope {
			val signal = CompletableDeferred<Unit>()
			pollInterrupt = signal
			try {
				val pollDeferred = async { block() }
				select<ConsolePollResult?> {
					pollDeferred.onAwait { it }
					signal.onAwait {
						pollDeferred.cancel()
						null
					}
				}
			} finally {
				pollInterrupt = null
			}
		}

	fun startPolling(scope: CoroutineScope) {
		if (pollJob?.isActive == true) return
		pollScope = scope
		pollJob = scope.launch(Dispatchers.IO) {
			var lastDiscoveryAt = 0L
			pollLoop@ while (isActive) {
				var failed = false
				var heldEmpty = false
				var hold = 0L
				try {
					// Mesh-wide discovery (see DISCOVERY_REFRESH_MS's own doc): the one thing left with
					// no push mechanism, so it still needs its own bounded-interval pull, independent of
					// the presence/linked-peers planes above and unconditional (no capability gate - a
					// gateway that cannot push presence can still relay discovery just fine, and this
					// covers OTHER gateways regardless of this one's own plane support).
					val now = System.currentTimeMillis()
					if (now - lastDiscoveryAt >= DISCOVERY_REFRESH_MS) {
						lastDiscoveryAt = now
						refreshDiscovery()
					}
					if (pluginReportPending) reportEnabledPlugins()
					// Visible: long-poll (the hold IS the wait; re-poll immediately).
					// Backgrounded: plain poll (hold=0); the wait after is the idle pushback
					// ladder's decision, not a flat interval - the mailbox batches either way.
					hold = if (visible) LONG_POLL_HOLD_MS else 0L
					val started = System.currentTimeMillis()
					val params = mailboxSync.pollParams()
					val focus = currentFocus
					val presented = knownPresenceVersions
					val presentedLinkedPeers = knownLinkedPeersVersion
					val presentedReadAnchors = knownReadAnchorsVersion
					val presentedCrossDomainPresence = knownCrossDomainPresenceVersions
					val presentedTaskBoard = board.knownVersion
					DebugLog.log("Poll", "firing cursor=${params.cursor} epoch=${params.epoch} hold=${hold}ms focus=${focus.screen}")
					val mb = if (hold > 0) {
						pollRacingFocusChange {
							client().poll(
								params.cursor, params.epoch, hold, presented, focus,
								presentedLinkedPeers, presentedReadAnchors, presentedCrossDomainPresence,
								presentedTaskBoard,
							)
						}
					} else {
						client().poll(
							params.cursor, params.epoch, hold, presented, focus,
							presentedLinkedPeers, presentedReadAnchors, presentedCrossDomainPresence,
							presentedTaskBoard,
						)
					}
					if (mb == null) {
						DebugLog.log("Plane", "poll interrupted by a focus/refresh change - reissuing immediately")
						continue@pollLoop
					}
					// Keyring sync: the route Gateway returns the snapshot only when it changed.
					// Apply it owner-pinned so a revocation made elsewhere reaches this Console.
					mb.domain?.let { federation.applyDomainSync(it, mb.domainVersion ?: "") }
					// Presence plane: the same piggyback shape as domainVersion above, generalized.
					// Present only when at least one source's version differs from what this device
					// presented - an empty presented list (this session's first poll) always ships
					// everything (cold boot).
					if (mb.presence != null || mb.presenceVersions != null) {
						if (mb.presenceVersions != null) knownPresenceVersions = mb.presenceVersions
						mb.presence?.let { rows ->
							val bumpAt = System.currentTimeMillis()
							DebugLog.log("Plane", "presence settled=${mb.settled} rows=${rows.size} serverAt=${started} clientAt=${bumpAt}")
							applyPresence(rows.map { teamInfoToTeam(it, localGatewayId) })
						}
					}
					// Linked-peers plane: same generalized shape, a single scalar version (no legacy
					// vs cold-boot distinction - see knownLinkedPeersVersion's own doc). A link/unlink/
					// untrust bumps the Gateway's own plane synchronously, so this device's next poll
					// reflects it.
					if (mb.linkedPeers != null || mb.linkedPeersVersion != null) {
						if (mb.linkedPeersVersion != null) knownLinkedPeersVersion = mb.linkedPeersVersion
						mb.linkedPeers?.let { peers ->
							DebugLog.log("Plane", "linkedPeers settled=${mb.settled} rows=${peers.size}")
							applyLinkedPeers(peers)
						}
					}
					// Cross-Domain-presence plane: unlike every plane above, genuinely N independently-
					// versioned planes (one per linked Domain, see knownCrossDomainPresenceVersions' own
					// doc) - the response carries only the SUBSET of linked Domains whose plane actually
					// changed, applied as a per-domainId upsert (applyCrossDomainPresence), never a
					// wholesale replace.
					mb.crossDomainPresence?.let { entries ->
						DebugLog.log("Plane", "crossDomainPresence settled=${mb.settled} rows=${entries.size}")
						applyCrossDomainPresence(entries)
					}
					// Read-anchors plane: same generalized shape again, one plane per owner. The version
					// bumps now, but applying the entries themselves waits until AFTER this poll's own
					// fresh mailbox entries are folded into `_state.threads` below (applyReadAnchors
					// resolves each synced position by ROW in that thread, so a message that arrived in
					// this SAME response must already be appended before its own read-anchor bump can
					// resolve).
					if (mb.readAnchorsVersion != null) knownReadAnchorsVersion = mb.readAnchorsVersion
					val pendingReadAnchors = mb.readAnchors
					// Task-board plane: same generalized shape, one plane per owner. The route Gateway's
					// half only - a non-route Gateway's entries arrive through board_read. Applying the
					// snapshot never clobbers a pending local edit; mergedEntries re-applies the queue.
					if (mb.taskBoard != null || mb.taskBoardVersion != null) {
						mb.taskBoard?.let { entries ->
							DebugLog.log("Plane", "taskBoard settled=${mb.settled} rows=${entries.size}")
							board.applySnapshot(localGatewayId, entries, mb.taskBoardVersion, mb.taskBoardTruncated == true)
						}
					}
					// Drain the board's pending actions on the poll cadence - the loop already runs at
					// the right rate foreground and follows the pushback ladder backgrounded, and each
					// action is its own relay carrying its own targetGateway.
					launch { runCatching { board.drain(client()) } }
					// On the drain's own cadence, because that is the loop waiting on these bytes. Guarded
					// against a second transfer of the same file, and a no-op when nothing is queued.
					boardOps.resumeBoardUploads()
					// Tombstone-expiry self-heal: re-derive `teams` from the cached raw snapshot
					// against the CURRENT tombstone set on every tick, fresh presence or not - see
					// reapplyCachedTeams. A failed or remote forget's tombstone then resurrects the
					// team locally on its own schedule rather than waiting for the next unrelated bump.
					reapplyCachedTeams()
					// An old gateway ignores holdMs and returns empty instantly; floor
					// the cadence so that degradation never becomes a tight spin.
					heldEmpty = hold > 0 && mb.entries.isEmpty() &&
						System.currentTimeMillis() - started < INSTANT_EMPTY_THRESHOLD_MS
					// Fold the result through the durable cursor: epoch flip, seq dedupe (a
					// lost-ack re-drain), and the dropped-gap DELTA all live in advance(), which
					// returns only genuinely-fresh entries. commit() advances the cursor LAST,
					// after the fresh entries are rendered + persisted (two-phase: a crash
					// re-delivers rather than skips).
					val adv = mailboxSync.advance(
						SyncPollResult(mb.entries.map { Drained(it) }, mb.cursor, mb.epoch, mb.dropped),
					)
					if (mb.entries.isEmpty()) {
						DebugLog.log("Poll", "empty (held=$heldEmpty epoch=${mb.epoch} cursor=${mb.cursor} dropped=${mb.dropped})")
					} else {
						DebugLog.log("Poll", "${adv.fresh.size}/${mb.entries.size} fresh epoch=${mb.epoch} cursor=${mb.cursor} dropped=${mb.dropped}")
					}
					if (adv.gap) _state.update { it.copy(gap = true) }
					// Idle pushback: any genuinely-fresh entry is comms activity, resetting the silence
					// clock back to the fast cadence.
					if (adv.fresh.isNotEmpty()) pushback.onCommsActivity(System.currentTimeMillis(), visible)
					val burst = mutableMapOf<String, MutableList<Message>>()
					val deviceAddr = thisDeviceAddress()
					for (d in adv.fresh) {
						val e = d.entry
						// Resolve the thread key for this entry; null means drop it. Notices thread under
						// the sender's canonical address; conv sessions use the session address, except
						// when that address is THIS device (an agent-initiated push to our own session
						// threads under `from`, the sender, not under ourselves).
						val team: String? = if (e.kind == "notice") {
							// Notice: prefer `from`, fall back to the notice store key's sender.
							e.from?.let { fromCanonical(it) }
								?: (parseStoreKey(e.session_id) as? SessionKey.Notice)?.sender?.canonical
						} else {
							when (val sk = parseStoreKey(e.session_id)) {
								is SessionKey.Conv ->
									if (deviceAddr != null && sk.address == deviceAddr) {
										// Push to our own session: thread under the sender, falling back to our own
										// self-address - a non-address `from` (a raw Device Name) would otherwise become
										// an unsendable ghost-chat key.
										e.from?.let { fromCanonical(it) } ?: sk.address.canonical
									} else {
										sk.address.canonical
									}
								// Not a conv store key; fall back to `from` if present.
								else -> e.from?.let { fromCanonical(it) }
							}
						}
						if (team == null) {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} from=${e.from} -> DROPPED (unresolvable team)")
							continue
						}
						val files = Attachments.decode(e.files)
						// status-only entries still land (e.g. a wake-failure error
						// with no body would otherwise vanish).
						val bodyText = e.body.orEmpty()
						val snippet = bodyText.replace(Regex("\\s+"), " ").trim().take(80)
						if (e.kind == "sent") {
							// The owner's own outgoing message, mirrored to all their devices.
							DebugLog.log("Drain", "seq=${e.seq} kind=sent session=${e.session_id} -> thread=$team (own mirror) opId=${e.opId} \"$snippet\"")
							val echo = Message(true, bodyText, e.at, files = files, status = null, opId = e.opId, epoch = mb.epoch, seq = e.seq)
							reconcileSent(team, echo)
							continue
						}
						if (e.kind == "plugin_action") {
							// Never rendered as a chat message, so it never depends on a nonempty body.
							val pluginId = e.pluginId
							val actionType = e.actionType
							if (pluginId != null && actionType != null) {
								DebugLog.log("Drain", "seq=${e.seq} kind=plugin_action session=${e.session_id} -> thread=$team $pluginId:$actionType")
								pluginActionSubscribers.forEach { sub ->
									runCatching { sub.onAction(team, pluginId, actionType, e.payload) }
										.onFailure { DebugLog.log("Drain", "plugin action subscriber threw: $it") }
								}
							}
							continue
						}
						if (bodyText.isNotEmpty() || files.isNotEmpty() || e.status != null) {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} -> thread=$team status=${e.status} files=${files.size} \"$snippet\"")
							val attribution = resolveMessageAttribution(e.kind, e.from, e.to, team, ::fromCanonical)
							val msg = Message(
								false, bodyText, e.at, files = files, status = e.status,
								title = e.title.tierOrNull(), summary = e.summary.tierOrNull(), fullSpoken = e.fullSpoken.tierOrNull(),
								epoch = mb.epoch, seq = e.seq, from = attribution.from, to = attribution.to, isPeer = attribution.isPeer,
								arrivedVisible = visible && !resumeBacklogPending,
							)
							// appendInbound folds an at-least-once re-drain in place and returns
							// false, so a redelivered entry never re-bumps unread or re-notifies. unread
							// itself is recomputed from the anchor inside appendInbound's own state update
							// (the single-writer derivation), not bumped here.
							//
							// Data-plane fan-out rides appendInbound's beforeCommit hook: synchronous, still
							// inside the mailbox cursor's exactly-once, and ordered BEFORE the row reaches
							// `_state` so a subscriber that feeds a render-time lookup (the references chip
							// index) is always seeded before the main thread can serialize the row. A
							// subscriber must never throw upward (a throw here would break the drain for
							// every team), so a throw is caught and logged rather than escaping.
							if (
								appendInbound(team, msg) {
									inboundSubscribers.forEach { sub ->
										runCatching { sub.onMessage(team, msg) }
											.onFailure { DebugLog.log("Drain", "inbound subscriber threw: $it") }
									}
								}
							) {
								burst.getOrPut(team) { mutableListOf() }.add(msg)
							}
						} else {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} -> thread=$team SKIPPED (no body, no files, no status)")
						}
					}
					// Apply the read-anchors piggyback now that this poll's own fresh entries (if any)
					// are already folded into `_state.threads` above - see pendingReadAnchors' own doc.
					pendingReadAnchors?.let { entries ->
						DebugLog.log("Plane", "readAnchors settled=${mb.settled} rows=${entries.size}")
						applyReadAnchors(entries)
					}
					// Report this device's own local read advances (scroll-driven reads since the last
					// cycle) back to the Gateway - the write half of the same plane. Never allowed to
					// fail the poll itself (see reportLocalReadAdvances' own doc).
					reportLocalReadAdvances()
					val burstJobs = mutableListOf<Job>()
					val autoPlayedPeerPairs = mutableSetOf<String>()
					for ((team, msgs) in burst) {
						val lastAgent = msgs.lastOrNull { !it.fromMe }
						// Only spend synthesis on followed threads (open tabs); a
						// never-opened or forgotten session is not in openTabs, so it
						// notifies without preloading.
						val followed = team in _state.value.openTabs
						val scope = pollScope
						// Pre-generate and auto-play are independent: enter the launch
						// path when either is active for this followed thread.
						val autoTier = playback.autoPlayTier(sttsAutoPlay)
						val eligible =
							scope != null && lastAgent != null && sttsReady() && followed && (sttsAutoGen || autoTier != null)
						// EVERY agent message, in arrival order, addressed by the thread it actually
						// lives in. A peer copy is NOT re-attributed to its `to`: the two mirror copies
						// carry different timestamps, so (to, at) names a row that thread does not hold,
						// and the engine would decline an entry the queue is waiting on.
						//
						// Claimed only by a thread that can actually speak. The peer dedupe hands the
						// slot to the first claimant, so letting an ineligible thread run it would let a
						// muted session silently suppress the followed one showing the same exchange.
						val agentMsgs = if (!eligible) {
							emptyList()
						} else {
							msgs.filter { !it.fromMe }
								.filterNot { isDuplicatePeerAutoPlay(it, autoPlayedPeerPairs) }
								.map { it to team }
						}
						if (eligible && agentMsgs.isNotEmpty()) {
							val t = team
							val ms = msgs
							val at = lastAgent.at
							val queueable = agentMsgs
							// The message that will speak FIRST, which is the one worth waiting on.
							// Warming the burst's last message instead would leave the one actually
							// about to play as a live cache miss.
							val warm = agentMsgs.firstOrNull()?.let { (m, owner) -> owner to m.at } ?: (t to at)
							burstJobs += scope.launch(Dispatchers.IO) {
								// When pre-generate is on, wait fully for synthesis so the
								// cache is warm when the notification lands. preloadMessage
								// never throws and is bounded by the STTS client's own
								// timeouts, so a failed or slow synth still falls through and
								// the notification fires. The rest of the burst warms as the
								// queue reaches it.
								if (sttsAutoGen) playback.preloadMessage(warm.first, warm.second)
								onInbound?.invoke(t, ms)
								// Hands-free: queue every arriving message in order. The queue
								// speaks the first immediately and the rest as each terminal
								// lands, so a burst is heard whole instead of only its last.
								if (autoTier != null) {
									for ((msg, owner) in queueable) {
									playback.enqueueForPlay(owner, msg.at, autoTier, announceRun = true)
								}
								}
							}
						} else {
							onInbound?.invoke(team, msgs)
						}
					}
					mailboxSync.commit(adv.next)
					// Idle pushback: decide() (the loop tail, below) can release the wakelock right after
					// this pass in a deep tier. Join the launched notification/STTS work first so it can
					// never get cut off mid-flight - most passes have an empty burst and skip this
					// entirely; the rare pass with real content is the one worth joining on. Bounded: a
					// stalled synth leaks that one coroutine rather than wedging every future pass - see
					// BURST_JOIN_TIMEOUT_MS.
					withTimeoutOrNull(BURST_JOIN_TIMEOUT_MS) { burstJobs.joinAll() }
					// This pass's own drain (just committed) is the "first completed pass" the resume
					// flag exists to cover; the NEXT pass's rows tag by live visibility again.
					resumeBacklogPending = false
					// Off the drain, never inside it: the rows are durable and on screen at this point,
					// so their bytes can take as long as they take. Also the heal for a fetch that a
					// process death cut short, since it re-derives what is outstanding every pass.
					fetchPendingAttachments()
					pollFails = 0
					if (_state.value.error != null || _state.value.pollFailStreak != 0) {
						_state.update { it.copy(error = null, pollFailStreak = 0, connected = true, enrollingSince = 0L) }
					}
					// Flush buffered debug lines to the ingest endpoint once per cycle.
					DebugLog.flushToIngest()
				} catch (e: Exception) {
					// MUST be the first statement: cancellable transport (executeCancellable) throws
					// CancellationException on teardown, and JVM CancellationException extends
					// Exception - classifyConnError must never see one, and a swallowed cancel here
					// would fall through to pushback.decide(..., lastPassFailed = true) and can
					// re-acquire an already-released wakelock.
					e.rethrowIfCancellation()
					if (hold > 0 && e.message?.startsWith("HTTP 504") == true) {
						// A relay-timeout during a hold is an empty long-poll, not an
						// outage: an evie still on the shorter hold (upgrade window) or
						// a transient gateway drop mid-hold. Back off, do not alarm.
						DebugLog.log("Poll", "hold timeout (504) treated as empty long-poll")
						heldEmpty = true
					} else {
						// Name the SPECIFIC cause instead of a blanket "Connection issue". A
						// TERMINAL cause (not enrolled, bridge not deployed, bad creds) cannot
						// clear by retrying, so surface it on the first failure; a TRANSIENT blip
						// waits for a second failure so one hiccup never alarms; an ENROLLING
						// sync-lag shows the calm "Finishing up enrollment..." at once and the
						// poll loop's own retry clears it the moment an op succeeds.
						val (cause, kind) = classifyConnError(e)
						DebugLog.log("Poll", "error streak=${ pollFails + 1 } [$kind]: ${e.message?.take(120)}")
						failed = true
						pollFails++
						_state.update { s ->
							when (kind) {
								ConnKind.ENROLLING -> {
									val (override, since) = enrollFold(s.enrollingSince)
									s.copy(pollFailStreak = pollFails, error = override ?: cause, enrollingSince = since)
								}
								ConnKind.TERMINAL -> s.copy(pollFailStreak = pollFails, error = cause, enrollingSince = 0L)
								ConnKind.TRANSIENT ->
									s.copy(pollFailStreak = pollFails, error = if (pollFails >= 2) cause else s.error, enrollingSince = 0L)
							}
						}
					}
					DebugLog.flushToIngest()
				}
				// The wait tier (and its alarm/wakelock side effects) comes from the silence ladder.
				// A foreground kick interrupts any wait so the user never stares at stale state;
				// visible long-polls chain back-to-back, failures and ignored holds back off to 5s.
				when (val wait = pushback.decide(System.currentTimeMillis(), visible, failed)) {
					PollWait.Chain -> if (failed || heldEmpty) withTimeoutOrNull(POLL_INTERVAL_MS) { kick.receive() }
					is PollWait.Delay -> withTimeoutOrNull(wait.ms) { kick.receive() }
					// The alarm (or a foreground/forget kick) is the real wakeup - the timeout below
					// is only a backstop against a lost alarm. Floored at 0 so a pass finishing near
					// the mark never hands withTimeoutOrNull a negative duration.
					is PollWait.Alarm ->
						withTimeoutOrNull((wait.atMillis - System.currentTimeMillis() + PARK_SLACK_MS).coerceAtLeast(0)) { kick.receive() }
				}
			}
		}
	}

	/** Re-deliver echoes stranded "pending" (process death, doze-killed socket)
	 * once each, using their original opId: the gateway replays the cached result
	 * if the send actually landed, so this can never double-deliver. A row whose
	 * send never landed re-fails to the tap-to-retry badge. */
	suspend fun reconcilePending() = withContext(Dispatchers.IO) {
		// Board attachment transfers are stranded the same way and recover the same way: the queued
		// action survived, but the coroutine carrying its bytes did not.
		boardOps.resumeBoardUploads()
		// Unlike forgottenUntil's time-based self-expiry, a reconciled key's liveness is tied to
		// its message's own status: once a row leaves "pending" it can never be looked at again
		// (the loop below skips non-pending rows outright), so retaining only currently-pending
		// keys is a correct, unbounded-growth-free eviction - not just an approximation.
		val stillPending = _state.value.threads.flatMapTo(mutableSetOf()) { (team, msgs) ->
			msgs.filter { it.fromMe && it.status == "pending" }.map { "$team:${it.id}" }
		}
		reconciled.retainAll(stillPending)
		for ((team, msgs) in _state.value.threads) {
			for (m in msgs) {
				if (!m.fromMe || m.status != "pending") continue
				val key = "$team:${m.id}"
				if (!reconciled.add(key)) continue
				if (m.opId == null) {
					// Legacy row with no opId: cannot re-send safely; make it retriable.
					setMessageStatus(team, m.id, "error")
					continue
				}
				val (rebuilt, refusedRow) = rebuildFiles(m)
				if (refusedRow != null) {
					setMessageStatus(team, m.id, "error")
					DebugLog.log("Reconcile", "re-send of $key refused: ${refusedRow.reason}")
					continue
				}
				try {
					deliver(team, m.id, m.text, rebuilt, m.opId, false)
				} catch (e: CancellationException) {
					// The row is still genuinely "pending", not attempted-and-failed (the app
					// backgrounded mid-upload) - undo the reconciled mark or this delivery can never
					// be reconciled again, stranding the row for the rest of the process's life.
					reconciled.remove(key)
					throw e
				} catch (e: Throwable) {
					// deliver()'s own catch(Exception) settles every Exception via fail(), so what
					// lands here is an Error. Rethrowing would escape into a Main-dispatched scope as
					// an app-killing crash, and since the row stays "pending", every foreground would
					// repeat it: a crash LOOP from one bad row. Settle it as retriable and move on.
					setMessageStatus(team, m.id, "error")
					DebugLog.log("Reconcile", "re-send of $key failed non-retriably: $e")
				}
			}
		}
	}

	/** Cold-start completeness backstop for the per-forget/per-send file deletes (Attachments.
	 * deleteFiles): removes any attachment bucket no surviving row references. The caller MUST
	 * run this to completion before the poll loop starts (see SwitchboardService.onCreate) -
	 * concurrently with a drain, a bucket this sweep captures as unreferenced could be
	 * re-decoded into by a crash re-drain before the delete lands, which Attachments.
	 * sweepOrphanBuckets's own age/mtime guard alone cannot prevent. A scheduled send's own eagerly-
	 * copied bucket is deliberately not a thread row until it fires, so its fileRefs must join the
	 * referenced set too - otherwise a record waiting out a long alarm (or several service restarts)
	 * looks orphaned and gets swept out from under it, and the eventual fire sends text-only. An open
	 * draft's picked files are the same shape of gap: they never become a thread row until Send, so
	 * they must join the referenced set too, or an open draft left untouched past this sweep's age
	 * floor loses its attachments out from under it. */
	suspend fun sweepOrphanAttachments() = withContext(Dispatchers.IO) {
		val referencedSrcs = _state.value.threads.values.asSequence()
			.flatMap { it.asSequence() }
			.flatMap { it.files.asSequence() }
			.map { it.src }
			.toList() + _state.value.scheduledSends.values.flatMap { it.fileRefs }.map { it.src } +
			_state.value.drafts.values.flatMap { it.files }.map { it.src }
		// A video's frame set lives in its own bucket that no src points at, so it has to be named
		// separately or every restart wipes the sets and re-runs the seeks that filled them.
		val frameBuckets = (
			_state.value.threads.values.asSequence().flatMap { it.asSequence() }.flatMap { it.files.asSequence() } +
				_state.value.drafts.values.asSequence().flatMap { it.files.asSequence() } +
				// Every source referencedSrcs draws from, or a banked send keeps its video and loses the
				// frames for it.
				_state.value.scheduledSends.values.asSequence().flatMap { it.fileRefs.asSequence() }
			)
			.filter { it.mime.startsWith("video/") }
			.mapNotNull { VideoThumbs.keyFor(it) }
			.map { VideoThumbs.bucketFor(it) }
			.toSet()
		// Board buckets are named by their entry rather than pointed at by a src, so they need the keep
		// set: a committed attachment has no queued action left to reference it, and Question 4 says the
		// attaching device holds its copy so the peek stays instant.
		//
		// A board that could not be DECODED answers the empty set, which would turn this into "delete
		// what the live board does not reference" over a board that restored empty - the reclaim shape
		// the gateway explicitly refuses, and here it would take every picture on the device in one
		// pass. Unknown is not empty: skip the board's share of the sweep entirely.
		val keep = frameBuckets + board.attachmentBuckets()
		if (board.boardIsKnown) {
			Attachments.sweepOrphanBuckets(filesDir, referencedSrcs, keep)
		} else {
			Attachments.sweepOrphanBuckets(filesDir, referencedSrcs, keep + boardOps.existingBoardBuckets())
		}
		// The blob store's own residue, on the same cold-start pass. Nothing references a staged blob
		// once its bytes reached a bucket, so age is the only signal available and the only one needed:
		// a live transfer is minutes old, and anything swept can be fetched again by name. Runs
		// strictly before startPolling, same as the bucket sweep, so no in-flight fetch is underfoot.
		val freed = client?.pruneStaleBlobs(STALE_BLOB_MAX_AGE_MS) ?: 0L
		if (freed > 0) DebugLog.log("Attachments", "pruned $freed bytes of transfer residue")
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
			pollScope?.launch(Dispatchers.IO) {
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
		pollScope?.launch(Dispatchers.IO) {
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

	// Per-thread composer state (ChatState.drafts), persisted so a power-management kill (or any
	// process death) never loses a half-typed message or a picked-but-unsent file. Every writer
	// below reads-modifies-writes the SAME _state.drafts map through withDraft and persists via
	// persistence.persistDrafts, so text, files, and the two restore paths (cancelFailedSend,
	// cancelScheduledSendForEdit, both above) can never observe or clobber a stale copy of the map.

	/** Set a team's composer text, replacing whatever text was there; files are untouched. */
	fun setDraftText(team: String, text: String) {
		val next = _state.updateAndGet { s ->
			s.withDraft(team, (s.drafts[team] ?: Draft()).copy(text = text))
		}.drafts
		persistence.persistDrafts(next)
	}

	/** Pick files into a team's draft, eagerly copying them into their own bucket - mirroring
	 * scheduleSend's own eager copy at schedule time, since a transient content:// grant may not
	 * outlive the wait between picking and Send. Each call mints its OWN bucket (never reused
	 * across calls, unlike a row's single out-$opId bucket), so two picks that happen to share a
	 * basename cannot overwrite each other on disk. */
	suspend fun addDraftFiles(team: String, uris: List<Uri>) = withContext(Dispatchers.IO) {
		// Admitted like any other pick: a draft is just a send that has not happened yet, so the
		// same admission bound applies here too.
		val (picked, refused) = admitPicked(uris, "pick-${UUID.randomUUID()}")
		if (refused != null) {
			_state.update { it.copy(error = refused.message()) }
			return@withContext
		}
		if (picked.isEmpty()) return@withContext
		// admitPicked is all-or-nothing, so on success these line up with the uris that produced them
		// and each picked file can be asked where it came from. Read now: the content Uri is gone
		// after this call and nothing downstream can recover it.
		val origins = uris.map { PickedLocation.of(it) }
		val paired = Attachments.storeOutgoingPaired(filesDir, "draft-${UUID.randomUUID()}", picked)
		val copied = paired.map { (_, stored) -> stored }
		val located = paired.mapNotNull { (out, stored) ->
			val src = stored.src ?: return@mapNotNull null
			origins.getOrNull(picked.indexOf(out))?.let { src to it }
		}.toMap()
		val next = _state.updateAndGet { s ->
			val current = s.drafts[team] ?: Draft()
			s.withDraft(team, current.copy(files = current.files + copied, locations = current.locations + located))
		}.drafts
		persistence.persistDrafts(next)
	}

	/** Drop one picked file from a team's draft (the attachment chip's remove) and delete its
	 * now-unreferenced copy. */
	fun removeDraftFile(team: String, src: String) {
		val next = _state.updateAndGet { s ->
			val current = s.drafts[team] ?: return@updateAndGet s
			s.withDraft(
				team,
				current.copy(
					files = current.files.filterNot { it.src == src },
					locations = current.locations - src,
				),
			)
		}.drafts
		persistence.persistDrafts(next)
		scheduleAttachmentDelete(listOf(src))
	}

	/** Append text to a team's composer draft - the plugin seam (e.g. the Designer's "Reference in
	 * chat"). Goes straight through the same drafts map every other writer here uses, so the team
	 * binding is enforced by the call itself rather than incidental on an ambient composable var. */
	fun appendDraftText(team: String, insert: String) {
		val current = _state.value.drafts[team] ?: Draft()
		val spaced = current.text.isEmpty() || current.text.endsWith(" ") || current.text.endsWith("\n")
		setDraftText(team, (if (spaced) current.text else "${current.text} ") + insert)
	}

	/**
	 * Hand a not-yet-sent message's content back to a thread's composer. Files always UNION: a list
	 * has a meaningful merge, so no caller can drop a pick. Text lands only on a blank draft: it has
	 * no merge, so anything already typed wins. Callers may disable their button as UX, but this
	 * write is what makes destroying composer contents unexpressible.
	 */
	fun takeBackIntoDraft(team: String, text: String, files: List<MessageFile>) {
		val next = _state.updateAndGet { s ->
			s.withDraft(team, mergeTakenBackDraft(s.drafts[team] ?: Draft(), text, files))
		}.drafts
		persistence.persistDrafts(next)
	}

	/**
	 * Drop a team's draft. Every caller reaches here right after handing the draft's contents to a
	 * send or a schedule.
	 *
	 * The draft's own copies of its picked files are deliberately NOT deleted. Send does re-bucket
	 * its own copy under `out-$opId`, but it does that on a coroutine, and the Send handler clears
	 * the draft on the tap thread immediately after launching it. So a delete here does not follow
	 * the re-bucket, it races it, and the send loses: it opened a file that had existed a millisecond
	 * earlier, got ENOENT, and dropped the attachment through a `mapNotNull` that raises nothing.
	 * Every attachment sent from this composer was lost that way, with no error anywhere.
	 *
	 * Once the send has stored its own copy the draft's bucket is unreferenced, and the cold-start
	 * `sweepOrphanAttachments` reclaims it. Discarding a single pick before sending stays immediate,
	 * through [removeDraftFile], which races nothing.
	 */
	fun clearDraft(team: String) {
		if (_state.value.drafts[team] == null) return
		val next = _state.updateAndGet { s -> s.copy(drafts = s.drafts - team) }.drafts
		persistence.persistDrafts(next)
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

	/** Best-effort background delete of no-longer-referenced attachment srcs, off the poll
	 * scope's own lifecycle (Dispatchers.IO). A no-op for an empty list. pollScope is null until
	 * startPolling runs, so this is a silent skip (not a defer) in that window - either way the
	 * next cold-start sweepOrphanAttachments heals any bucket left behind. */
	private fun scheduleAttachmentDelete(srcs: List<String>) {
		if (srcs.isEmpty()) return
		pollScope?.launch(Dispatchers.IO) { Attachments.deleteFiles(filesDir, srcs) }
	}

	/**
	 * Fetch the bytes for every attachment whose message has arrived but whose file has not, and
	 * fill in the src that makes it render.
	 *
	 * A message is prose plus references, so delivery never waits on bytes. This is the second half:
	 * it runs off the drain, one file at a time so a thread of large attachments cannot open a dozen
	 * concurrent transfers, and it is safe to call at any time because the work it looks for is
	 * exactly the work still outstanding. That also makes it the recovery path: a fetch cut off by a
	 * process death is simply still pending on the next pass, and resumes from the bytes already on
	 * disk rather than restarting.
	 *
	 * Single-flight, because the caller fires once per poll pass and a transfer routinely outlives
	 * one. Overlapping passes would re-derive the same pending set, re-download the same blobs, and
	 * race each other inside [Attachments.land].
	 */
	private fun fetchPendingAttachments() {
		val client = this.client ?: return
		// Claim the latch only once there is somewhere to run, and hand it back if the dispatch does
		// not happen. Claiming first would strand it forever on a null or already-cancelled scope,
		// because the release lives in the coroutine body and a body that never runs never releases:
		// attachments would then stop arriving for the life of the process, silently, since this
		// singleton outlives every Activity and service restart.
		val scope = pollScope ?: return
		if (!fetchingAttachments.compareAndSet(false, true)) return
		val job = scope.launch(Dispatchers.IO) {
			try {
				// Snapshot the work first: the state can change under a long transfer, and each landing
				// re-reads the live row anyway.
				val pending = _state.value.threads.flatMap { (team, msgs) ->
					msgs.flatMap { m ->
						m.files.filter { it.blobId != null && it.src == null }.map { Triple(team, m, it) }
					}
				}
				for ((team, message, file) in pending) {
					val blobId = file.blobId ?: continue
					if (attachmentFetchFailures.getOrDefault(blobId, 0) >= MAX_ATTACHMENT_FETCH_TRIES) continue
					val source = runCatchingCancellable { client.downloadBlob(blobId, file.blobGateway) }
						.onFailure {
							// Count against the blob, not the row: the same reference on several rows is
							// one unfetchable thing, and a bounded count is what stops a blob no Gateway
							// holds from being re-requested on every pass for the life of the install.
							val tries = attachmentFetchFailures.getOrDefault(blobId, 0) + 1
							attachmentFetchFailures[blobId] = tries
							if (tries >= MAX_ATTACHMENT_FETCH_TRIES) _failedAttachmentFetches.update { s -> s + blobId }
							DebugLog.log("Attachments", "fetch of ${file.name} failed ($tries): $it")
						}
						.getOrNull() ?: continue
					attachmentFetchFailures.remove(blobId)
					_failedAttachmentFetches.update { s -> s - blobId }
					val src =
						Attachments.land(filesDir, Attachments.bucketFor(message.epoch, message.seq), file.name, source)
							?: continue
					landFetchedAttachment(team, message.id, file.name, src)
					// The bytes now live in the attachments bucket, which is the copy the renderer reads
					// and the orphan sweep owns. Keeping the blob as well would hold every attachment
					// twice on the device with the least room for it.
					client.forgetBlob(blobId)
				}
			} finally {
				fetchingAttachments.set(false)
			}
		}
		// A scope cancelled between the claim above and the dispatch creates a job whose body never
		// runs, so its finally never fires. Releasing on completion covers that too, and is a no-op
		// when the body did run and already released.
		job.invokeOnCompletion { fetchingAttachments.set(false) }
	}

	/** Point one already-rendered row's file at its now-present bytes. Matched by name within the
	 * row, the same pairing [Attachments.mergeSentEchoFiles] uses, since both sides derive names
	 * through one safeName/uniqueName chain. */
	private fun landFetchedAttachment(team: String, messageId: Long, name: String, src: String) {
		var changed = false
		val threads = _state.updateAndGet { s ->
			// Re-established on EVERY invocation, not just the matching one: updateAndGet re-runs this
			// lambda on a failed CAS, so a value carried over from a losing attempt would describe work
			// the winning attempt did not do (see the same rule spelled out in reconcileSent).
			changed = false
			val thread = s.threads[team] ?: return@updateAndGet s
			val idx = thread.indexOfFirst { it.id == messageId }
			// The row can be gone (a forget, a replace) by the time the bytes land. Its blob stays in
			// the store for the sweep; nothing here has to unwind.
			if (idx < 0) {
				changed = false
				return@updateAndGet s
			}
			val row = thread[idx]
			val files = row.files.map { if (it.name == name && it.src == null) it.copy(src = src) else it }
			if (files == row.files) {
				changed = false
				return@updateAndGet s
			}
			changed = true
			val next = thread.toMutableList().also { it[idx] = row.copy(files = files) }
			s.copy(threads = s.threads + (team to next))
		}.threads
		if (changed) persistence.persistThreads(threads)
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
		cancelScheduledSend(key)
		// Queue first, cache second. Dropping under the advance mutex stops the player only once the
		// queue no longer points at it, so the stop's own terminal cannot advance into an entry whose
		// audio `purge` is about to delete.
		repoScope.launch {
			playback.dropQueuedFor(key)
			stts.purge(key)
		}
		// Deliberately its OWN unconditional call, not nested in the local-gateway gate below -
		// the files are local no matter where the session lives, unlike the gateway RPC.
		scheduleAttachmentDelete(dropped.flatMap { it.files }.mapNotNull { it.src })
		priorDraft?.let { scheduleAttachmentDelete(it.files.mapNotNull { f -> f.src }) }
		// Also tear the live session down on the gateway (kill tmux + drop the resume record) so it
		// stops listing as available, and dispose of its board work in the same call. Any Gateway this
		// owner's keyring can seal to: a session on another machine has a pane and a board there, and
		// gating this on the route Gateway left its record alive to return when the tombstone expired.
		// Best-effort, the gateway no-ops an absent session.
		val t = runCatching { parseTarget(team, localDomain(), _state.value.localGatewayId) }.getOrNull()
		val reachable = (otherKeyringGateways(localGatewayId) + localGatewayId).toSet()
		if (t is Address && t.domain == localDomain() && t.gateway in reachable) {
			pollScope?.launch(Dispatchers.IO) {
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
		pollJob?.cancelAndJoin()
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
		scheduledSendScheduler?.cancelNext()
	}

	private fun append(team: String, msg: Message): Long {
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
	private fun appendInbound(team: String, msg: Message, beforeCommit: () -> Unit = {}): Boolean {
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
	private fun reconcileSent(team: String, echo: Message) {
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
			scheduleAttachmentDelete(deleteSrcs)
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
		// ConsoleClient's own bound on that call (not an independent literal) so it can never
		// silently fall behind the client's real worst case.
		const val FORGET_TOMBSTONE_MS = ConsoleClient.DEFAULT_RELAY_CALL_TIMEOUT_MS + 5_000L
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
