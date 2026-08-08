package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.crypto.ownerKeyId
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalJoin
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalOp
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeOp
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.EnrollParty
import com.atelier_nyaarium.switchboard.proto.EnrollResult
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.BoardAttachment
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsolePollResult
import com.atelier_nyaarium.switchboard.proto.FocusIntent
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceKnownVersion
import com.atelier_nyaarium.switchboard.proto.LinkedPeersVersion
import com.atelier_nyaarium.switchboard.proto.PresenceVersion
import com.atelier_nyaarium.switchboard.proto.ReadAnchorsVersion
import com.atelier_nyaarium.switchboard.proto.SasCrypto
import com.atelier_nyaarium.switchboard.proto.TrustHandshakeOp
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SessionKey
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapFrame
import com.atelier_nyaarium.switchboard.proto.GatewayTransport
import com.atelier_nyaarium.switchboard.proto.SyncEntry
import com.atelier_nyaarium.switchboard.proto.SyncPollResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.parseStoreKey
import com.atelier_nyaarium.switchboard.proto.parseTarget
import java.io.File
import java.time.ZoneId
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
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
import org.json.JSONArray
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
	private val store: AppStateStore,
	private val filesDir: File,
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

	/** What autoplay still has to speak. The repository owns it and advances it; [SttsPlayer] stays a
	 * one-shot engine that knows nothing about what comes next. */
	private val queue = PlaybackQueue()

	/** Serializes every advance. A player terminal and a user gesture can arrive together, and both
	 * read the head before mutating it; `scheduledSendFireMutex` guards the same shape for sends. */
	private val advanceMutex = Mutex()

	// Declared before _state, which snapshots it. Kotlin initializes fields in declaration order.
	@Volatile private var localGatewayId: String = store.loadGatewayId()

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

	private val _state = MutableStateFlow(
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
	@Volatile private var client: ConsoleClient? = null
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
	// the exact double-fire shape Phase 1's DurableOpStore exists to close for send/respond, applied
	// here at the client layer instead. Ordinary schedule/cancel/edit mutations do NOT take this
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
	private val repoScope = CoroutineScope(
		SupervisorJob() + Dispatchers.IO +
			CoroutineExceptionHandler { _, e ->
				DebugLog.log("Repo", "uncaught in repo scope: ${e.javaClass.simpleName}: ${e.message}")
				// An Error (OOM on an oversized encode, a torn write) would otherwise reach the
				// thread's uncaught handler and kill the app. Surfaced as a red banner instead.
				_state.update { it.copy(error = "Something went wrong: ${e.javaClass.simpleName}") }
			},
	)

	// The queue advances off terminals, so it subscribes for the process's lifetime rather than with a
	// screen: a backgrounded burst has no UI listening and must still walk forward. Declared after
	// repoScope because it uses it.
	init {
		stts.addListener { event ->
			if (event is SttsPlayer.Event.Ended) {
				val entry = QueueEntry(event.team, event.at, event.tier)
				// `gen` is carried, not dropped: it is the only field that says WHICH request ended,
				// and a marker's entry key is shared by every run of the same session.
				repoScope.launch { onPlaybackEnded(entry, event.outcome, event.gen, event.reason) }
			}
		}
	}

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
	private val federation = FederationManager(store)
	// RECEIVER link state: the requester-minted pin learned from a listen-state poll, keyed by the
	// receiver's listening token. The receiver needs it to confirm its pairing (the gateway resolves
	// the window by the pin), but the wizard only holds the token, so the poll stashes it here.
	private val receiverPin = mutableMapOf<String, String>()
	// ADMIN-side enroll-invite secrets (handshakeId + pin) minted per staged tenant when the invite
	// blob is built, reused to drive the admin's leg of the in-person compare. Transient like the link
	// ceremony's linkNonce: the in-person flow keeps the detail screen open, and regenerating the
	// invite mints fresh secrets (abandoning the old QR's window).
	private val enrollInvites = java.util.concurrent.ConcurrentHashMap<String, EnrollInvite>()
	private var pollFails = 0
	private var pollJob: Job? = null
	// The poll loop's scope, reused to launch auto-TTS preloads that gate the
	// notification (so the audio is cached before the user is pinged).
	private var pollScope: CoroutineScope? = null

	@Volatile private var sttsClient: SttsClient? = null

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

	private fun client(): ConsoleClient {
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
	private fun sttsClient(): SttsClient? {
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
	private fun currentProvider(): com.atelier_nyaarium.switchboard.proto.SttsProvider? {
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

	/**
	 * Speak one message tier (notification action or thread button). The whole
	 * resolution (credential decrypt, message lookup, text prep) hops to the
	 * player's control lane so a broadcast receiver's main thread does zero
	 * disk or crypto work. Cache and single-flight live in SttsPlayer, so
	 * impatient multi-taps synthesize once; tapping an entry that is already
	 * claimed cancels it. No-op when unconfigured or the message is gone.
	 */
	fun playMessage(team: String, at: Long, tier: SttsPlayer.Tier) {
		stts.post { startPlayback(team, at, tier) }
	}

	/** Whether the engine TOOK this message, which is the same as whether a terminal is now owed for
	 * it. Every reason to give up returns false here rather than returning silently, because a queue
	 * waiting on a terminal that will never come waits forever. */
	private fun startPlayback(
		team: String,
		at: Long,
		tier: SttsPlayer.Tier,
		yielding: Boolean = false,
		// A run announces its speaker with a sentinel; a single message played by hand has no marker,
		// so it carries its own attribution instead.
		attributed: Boolean = true,
		// Null when it started; otherwise WHY it did not. Four quite different problems - no key, no
		// provider, a message that has since gone, and a row with nothing speakable in it - used to
		// collapse into one `false`, and the alert could only shrug at all of them. The no-key case is
		// the likeliest cause of a whole burst failing at once, which is exactly when a user needs to
		// be told which of their problems this is.
	): String? {
		val client = sttsClient() ?: return "no voice key set"
		val provider = currentProvider() ?: return "no voice provider set"
		val msg = _state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe }
			?: return "message is no longer here"
		val text = ttsTextFramed(_state.value, msg, tier, attributed)
		if (text.isBlank()) return "nothing to read aloud"
		val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		val taken = stts.play(client, provider, voice, team, at, tier, text, sttsVolume, yielding)
		return if (taken) null else "already speaking"
	}

	/**
	 * What each of one team's messages is doing: "playing" for the audible one, "loading" for the one
	 * handed to the engine but not yet sounding, "queued" for the rest. A message not named is idle.
	 *
	 * A QUERY rather than something a consumer accumulates from events. Every subscriber that rebuilt
	 * this from the stream would have to get the same reconstruction right, and the glyph listener -
	 * the only one that ever tried - got it wrong twice.
	 */
	fun playStatesFor(team: String): Map<Long, String> {
		val states = mutableMapOf<Long, String>()
		for (entry in queue.queued()) {
			if (entry.team != team) continue
			states[entry.at] = when {
				stts.isPlayingMessage(entry.team, entry.at) -> "playing"
				entry == queue.playing() -> "loading"
				else -> "queued"
			}
		}
		return states
	}

	fun isMessagePlaying(team: String, at: Long): Boolean = stts.isPlayingMessage(team, at)

	fun stopMessage(team: String, at: Long) = stts.stopMessage(team, at)

	/**
	 * The markers still owed before the current entry's body may speak, in order.
	 *
	 * A marker is an ordinary request with its own terminal, so the sequence advances the same way the
	 * queue does - on a terminal - rather than through a second mechanism. Held here rather than on
	 * [QueueEntry] because what an entry CONSISTS of is not the queue's business; the queue answers
	 * what plays next.
	 */
	private val pendingMarkers = ArrayDeque<Marker>()

	/** The entry [pendingMarkers] were staged for. A marker announces a specific session, so a queue
	 * that moved on while one was in flight must not let the leftovers introduce the wrong one. */
	private var markersFor: QueueEntry? = null

	/** The marker handed to the engine, by its own entry key. CLAIMED rather than sounding: a marker
	 * spends its whole synthesis owning nothing audible, and a teardown in that window still has to
	 * reach it. A terminal that does not match belongs to a run that has already ended. */
	private var markerInFlight: Long? = null

	private sealed interface Marker {
		data object Chime : Marker

		data class Spoken(val text: String) : Marker
	}

	/**
	 * Queue one message and speak it if nothing is speaking.
	 *
	 * `announceRun` is false for a tap: a chime marks a run that began on its own, and a person who
	 * pressed a button already knows they started it. The sentinel still plays, because which session
	 * is speaking is not something the tap tells them.
	 */
	suspend fun enqueueForPlay(
		team: String,
		at: Long,
		tier: SttsPlayer.Tier,
		announceRun: Boolean,
		// Autoplay only speaks followed threads. A person asking for a specific message has already
		// decided, and a notification can name a thread that is not open - refusing there would be a
		// button that does nothing and says nothing.
		requireFollowed: Boolean = true,
	) {
		val entry = QueueEntry(team, at, tier)
		advanceMutex.withLock {
			// Re-checked under the lock, not just at the drain. A burst job runs on its own coroutine
			// and can land after a close or forget has already swept this team, putting an entry back
			// into a queue the teardown believed it had emptied.
			if (requireFollowed && team !in _state.value.openTabs) return
			// Asked BEFORE the enqueue: mid-run the queue is never idle, so the chime marks the run
			// rather than every message in it.
			val beginsRun = queue.isIdle()
			if (!queue.enqueue(entry)) return
			if (beginsRun) queueMarkers(entry, chime = announceRun)
			resumeIfSilent()
		}
		transportChanged()
	}

	/** Stage the markers that precede one entry's body. A manual tap never chimes; it is not a run. */
	private fun queueMarkers(entry: QueueEntry, chime: Boolean) {
		pendingMarkers.clear()
		markersFor = entry
		if (chime) pendingMarkers.addLast(Marker.Chime)
		val msg = _state.value.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe } ?: return
		pendingMarkers.addLast(Marker.Spoken(sentinelText(_state.value, msg, entry.team)))
	}

	private fun clearMarkers() {
		pendingMarkers.clear()
		markersFor = null
		markerInFlight = null
	}

	/** Play the next owed marker, or report that the body may now speak. Records WHICH marker is in
	 * flight, so a terminal can be matched to it: without that, a marker from a run that has already
	 * been torn down drives the current run's sequence and swallows its message. */
	private fun nextMarkerStarted(): Boolean {
		while (pendingMarkers.isNotEmpty()) {
			val started = when (val marker = pendingMarkers.removeFirst()) {
				is Marker.Chime -> chimeSource?.invoke()?.let { stts.playChime(it, sttsChimeVolume) }
				is Marker.Spoken -> speakMarker(marker.text)
			}
			// A marker that will not play is skipped rather than allowed to stall the body behind it:
			// losing a boundary is a smaller harm than losing the message.
			if (started != null) {
				markerInFlight = started
				return true
			}
		}
		markerInFlight = null
		return false
	}

	private fun speakMarker(text: String): Long? {
		val client = sttsClient() ?: return null
		val provider = currentProvider() ?: return null
		val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		return stts.playMarker(client, provider, voice, text, sttsVolume)
	}

	/**
	 * Resolves the chime to a file the player can open. Set by the app layer, because reading a raw
	 * resource or a user-chosen content URI needs a Context and this class deliberately holds none -
	 * the same seam the alarm scheduler uses.
	 *
	 * Unset or failing means no chime, and the sequence carries on to the sentinel. A boundary marker
	 * that cannot load must not hold up the message behind it.
	 */
	@Volatile
	var chimeSource: (() -> File?)? = null

	/** Retire the entry that just ended and speak whatever follows. Every terminal routes here, so the
	 * outcome alone decides whether the queue moves: a decode failure must not retire an entry as
	 * though it had been heard, and a user stop must not walk forward. */
	/** `gen` names the request that ended. Zero means "no request at all" - a terminal this class
	 * synthesized because the engine declined the entry, which is never a marker. Generations start at
	 * one, so it cannot collide with a real one. */
	private suspend fun onPlaybackEnded(
		entry: QueueEntry,
		outcome: SttsPlayer.Outcome,
		gen: Long = 0L,
		reason: String? = null,
	) {
		try {
			advanceEnded(entry, outcome, gen, reason)
		} finally {
			// After the advance, not on the event: the queue is only correct once this has run.
			transportChanged()
		}
	}

	private suspend fun advanceEnded(entry: QueueEntry, outcome: SttsPlayer.Outcome, gen: Long, reason: String?) {
		advanceMutex.withLock {
			// A marker finishing means the sequence moves on, never that the queue does: the body it
			// precedes has not been spoken yet, and advancing here would skip the message entirely.
			if (entry.team == SttsPlayer.MARKER_TEAM) {
				// Matched to the marker that was actually started. A terminal from a torn-down run
				// otherwise looks indistinguishable from this run's own, and drives it a step forward
				// while its message has not been spoken.
				if (gen != markerInFlight) return
				markerInFlight = null
				val head = queue.playing()
				// The run these markers belonged to is gone, either torn down or moved on. Nothing else
				// will report a terminal for it, so drop the leftovers and pick the queue back up
				// rather than leaving the backlog waiting on a message that may never arrive.
				if (head == null || markersFor != head) {
					clearMarkers()
					resumeIfSilent()
					return
				}
				// Gapped, so each marker reads as a boundary rather than running into what follows. The
				// owner is captured HERE, not re-read when the gap expires: by then the run may have
				// been torn down and a new one staged, and a stale callback that re-bound to whatever
				// was current would drive the new entry's sequence and drop its body unspoken.
				val owner = head
				stts.afterGap {
					repoScope.launch {
						advanceMutex.withLock {
							if (markersFor != owner || queue.playing() != owner) return@withLock
							if (nextMarkerStarted()) return@withLock
							clearMarkers()
							speakBody(owner)
						}
					}
				}
				return
			}
			val step = queue.advance(entry, outcome, reason)
			step.failed?.let { DebugLog.log("Stts", "giving up on ${it.team} @${it.at} after a retry") }
			if (step.next != null) {
				// Spoken unconditionally. `advance` has already installed this as the head, so refusing
				// here would strand an entry the engine was never given and no terminal will ever
				// retire. It is safe to hand over even while the user is listening to something else:
				// the request yields at the player and reports its own terminal.
				speak(step.next)
				return
			}
			// The head just gave the sound to something else. An empty head reads exactly like an idle
			// queue, so without this the resume below would speak straight over what displaced it.
			if (step.standDown) return
			// A terminal for something the queue does not own. If that freed the sound, pick the run
			// back up rather than stalling until the next message arrives.
			resumeIfSilent()
		}
	}

	/** Drop everything queued for a team and stop it if it was the one speaking, then carry on with
	 * whatever other teams still have waiting. Ordered drop-then-stop on purpose: the stop's own
	 * terminal would otherwise advance into an entry this same call is removing. Cache deletion is a
	 * separate step, so closing a tab the user may reopen keeps its audio. */
	suspend fun dropQueuedFor(team: String) {
		advanceMutex.withLock {
			// Tearing the thread down is not a pause. Swept across the whole TEAM rather than the entry
			// handed back: a pause parks its message in pending, so the one entry that actually holds an
			// offset is never the head, and the head is all a teardown is told about.
			queue.dropTeam(team)?.let { stts.abandon(it.team, it.at, it.tier, remember = false) }
			stts.forgetTeamPositions(team)
			// A marker lives under its own reserved team, so dropping the message's team cannot reach
			// one already handed to the engine. Abandoned by its own identity rather than by stopping
			// whatever is audible: the marker may still be synthesizing and hold no sound yet, and
			// what IS audible may belong to a team nobody asked to silence.
			if (markersFor?.team == team) {
				markerInFlight?.let { stts.abandonGeneration(it) }
				clearMarkers()
			}
			resumeIfSilent()
		}
		// A teardown changes what there is to show as surely as a terminal does. Without this, closing
		// a thread mid-run left the lockscreen holding a transport for a run that no longer exists.
		transportChanged()
	}

	/** Start the next entry only while nothing is audible. "The queue has no head" is not the same
	 * question: the queue is headless the instant it stands down, and answering the wrong one is how it
	 * ends up speaking over the playback it just yielded to. Callers hold [advanceMutex]. */
	/** Whether a transport control has held the run. Distinct from an empty queue: paused means there
	 * is something to come back to, which is why nothing auto-resumes past it. */
	@Volatile
	/**
	 * Whether the run is held. Read through an accessor that CANNOT report a pause over an idle queue.
	 *
	 * A pause describes a run, so it cannot outlive one - and three separate rounds each found a new
	 * way for a run to end without passing through whichever single place was normalizing the flag at
	 * the time (a thread torn down, an entry trashed, the last entry skipped). Each fix was correct
	 * where it landed and none of them held, because the rule lived at the writers rather than at the
	 * value. A stranded flag refuses autoplay on every team afterwards, with no enabled control left
	 * on screen to clear it.
	 *
	 * Normalizing in the GETTER is what makes the bad state unobservable rather than merely unreached:
	 * a new way to empty the queue cannot reintroduce it, because there is no longer a reader that
	 * could see it.
	 */
	private var pausedFlag = false
	private var transportPaused: Boolean
		get() {
			if (pausedFlag && queue.isIdle()) pausedFlag = false
			return pausedFlag
		}
		set(value) {
			pausedFlag = value
		}

	/**
	 * Called after the run's state has SETTLED, never from a raw playback event.
	 *
	 * A transport surface asks what the queue is doing, and an event fires before the queue has been
	 * advanced for it - so a listener reading on the event sees the entry that just ended still
	 * installed. Mid-run that self-corrects on the next start; at the last terminal there is no next
	 * start, and the surface stays showing a run that is over.
	 */
	@Volatile
	var onTransportChanged: (() -> Unit)? = null

	/**
	 * Bumped whenever the settled queue state changes. What the sheet re-reads on.
	 *
	 * A counter rather than a second callback slot: [onTransportChanged] is one slot the service owns,
	 * and a UI that took it would silently unhook the lockscreen. A counter has no owner, so any number
	 * of surfaces can watch it, and it carries no state of its own to drift - it only says "ask again".
	 */
	val queueRevision: kotlinx.coroutines.flow.StateFlow<Int> get() = _queueRevision
	private val _queueRevision = kotlinx.coroutines.flow.MutableStateFlow(0)

	private fun transportChanged() {
		_queueRevision.value = _queueRevision.value + 1
		warmQueued()
		runCatching { onTransportChanged?.invoke() }
	}

	/**
	 * Get every queued entry's audio made before its turn comes.
	 *
	 * Driven off the settled queue rather than off message arrival, so it follows what will ACTUALLY
	 * be spoken - the old pre-generate warmed on delivery, behind a settings toggle, and knew nothing
	 * about the queue. Warming is idempotent per entry, so calling it on every change is free.
	 *
	 * Deliberately keeps going while the run is PAUSED. A pause means the person is busy, not that the
	 * work should stop; having the backlog ready is most of the value of pausing at all.
	 */
	private fun warmQueued() {
		val client = sttsClient() ?: return
		val provider = currentProvider() ?: return
		val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		val state = _state.value
		for (entry in queue.queued()) {
			val tier = entry.tier ?: continue
			val msg = state.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe } ?: continue
			// The words the RUN will speak, not the attributed form a hand-play uses - the cache is keyed
			// on the text, so warming the other one would fill the cache and still synthesize live.
			val text = ttsTextFramed(state, msg, tier, attributed = false)
			if (text.isNotBlank()) stts.warm(client, provider, voice, entry.team, entry.at, tier, text)
		}
	}

	private fun resumeIfSilent() {
		if (transportPaused || queue.playing() != null || stts.isSounding()) return
		queue.startNext()?.let { speak(it) }
	}

	/** Hold the run where it is. PREEMPTED already means "stand down and wait" rather than "advance",
	 * so a pause is that plus a flag stopping the next terminal from picking the run back up. */
	suspend fun pausePlayback() {
		advanceMutex.withLock {
			// Nothing to pause means nothing to resume. Setting the flag here would stick: an idle
			// queue mints no terminal, so no event would ever arrive to clear it, and every later run
			// - autoplay AND the in-thread button, which share this start path - would be refused.
			if (queue.isIdle()) return@withLock
			transportPaused = true
			markerInFlight?.let { stts.abandonGeneration(it) }
			clearMarkers()
			val head = queue.playing()
			if (head != null) {
				// Requeued at the FRONT, then retired. Stopping audio would only reach a body that is
				// already sounding - during a marker, or while the body is still synthesizing, there is
				// nothing audible to stop, and the head would stay installed AND be waiting in pending:
				// stuck, and then spoken twice when the synthesis it never cancelled finally landed.
				// A pause KEEPS where it got to - that is what separates it from a skip. Which sound's
				// position that is stays the engine's to answer: during the chime or the sentinel the
				// audible thing is a marker, and a marker is never resumable, so a pause landing there
				// files nothing rather than cutting the opening off the body.
				queue.requeueFront(head)
				stts.abandon(head.team, head.at, head.tier, remember = true)
				queue.advance(head, SttsPlayer.Outcome.PREEMPTED)
			}
		}
		transportChanged()
	}

	suspend fun resumePlayback() {
		advanceMutex.withLock {
			transportPaused = false
			resumeIfSilent()
		}
		transportChanged()
	}

	/** Give up on what is speaking and move to the next entry. Distinct from a pause: this one is a
	 * decision about THIS message, so the run continues. */
	suspend fun skipPlayback() {
		// try/finally, because a bare return inside `withLock` leaves the whole function - the surfaces
		// would keep showing the state from before the skip until some later terminal happened to
		// correct them.
		try {
			advanceMutex.withLock {
				// A pause retires the head and parks the message at the FRONT of the queue, so after one
				// there is no head to skip - the thing being skipped is that parked entry. Promoting it
				// first means Skip discards it, rather than resuming the very message it was asked to
				// move past.
				val head = queue.playing() ?: queue.startNext() ?: return@withLock
				retireHead(head)
			}
		} finally {
			transportChanged()
		}
	}

	/** What a transport surface should show: whether anything is queued at all, and whether it is
	 * currently held. */
	fun transportState(): Pair<Boolean, Boolean> = Pair(!queue.isIdle(), transportPaused)

	/**
	 * The queue as the sheet renders it, in speaking order, current entry first.
	 *
	 * Built here rather than in the UI so the sheet holds no state of its own - it is the fourth
	 * surface reporting this run, and the ones that kept their own copy are the ones that drifted.
	 */
	fun queueRows(): List<QueueRow> {
		val head = queue.playing()
		// Read once rather than per row: it is the same answer for all of them, and asking inside the
		// loop would let the current entry change mid-list.
		val current = playbackPosition()
		// Only the HEAD can be mid-synthesis, and only until its audio starts. Everything behind it is
		// waiting its turn, which is a different thing and must not draw as work in progress.
		val generating = head != null && !stts.isPlayingMessage(head.team, head.at)
		return queue.queued().distinct().map { entry ->
			row(
				entry,
				isCurrent = entry == head,
				// The live player for the one that is sounding; otherwise whatever warming measured. A
				// queued entry knows its own length as soon as its audio exists, which is the point of
				// making it early.
				durationMs = current?.takeIf { it.entry == entry }?.durationMs
					?: stts.warmedDuration(entry.team, entry.at, entry.tier),
				generating = generating && entry == head,
			)
		}
	}

	/** The entries that gave up, for the alert's list. Separate from [queueRows] because these are no
	 * longer a run: nothing will speak them, and the only things offered are a jump and a dismissal. */
	fun failedRows(): List<QueueRow> =
		queue.remembered().map {
			row(it, isCurrent = false, durationMs = null, gaveUp = true, reason = shortCause(queue.reasonFor(it)))
		}

	/**
	 * A cause a person can read, from whatever the provider said.
	 *
	 * The raw string is an HTTP body: it can run to paragraphs, name internal endpoints, and echo
	 * request content back. A tile is not the place for it - what a user needs is which of their
	 * problems this is, and only the first line of it.
	 */
	private fun shortCause(reason: String?): String {
		val raw = reason?.trim().orEmpty()
		return when {
			raw.isEmpty() -> "not spoken"
			raw.contains("401") || raw.contains("403", true) -> "voice key rejected"
			raw.contains("429") -> "voice service busy"
			raw.contains("timeout", true) || raw.contains("timed out", true) -> "voice service timed out"
			raw.contains("playback failed", true) -> "audio would not play"
			// Already a phrase written for a person - the decline paths mint these themselves.
			raw.length <= 60 && !raw.contains('{') && !raw.contains('<') -> raw
			else -> raw.lineSequence().first().take(60)
		}
	}

	private fun row(
		entry: QueueEntry,
		isCurrent: Boolean,
		durationMs: Long?,
		generating: Boolean = false,
		gaveUp: Boolean = false,
		reason: String? = null,
	): QueueRow {
		val msg = _state.value.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe }
		return QueueRow(
			entry = entry,
			sessionLabel = _state.value.label(entry.team),
			title = msg?.let { SttsPlayer.ttsText(it, SttsPlayer.Tier.TITLE) }.orEmpty(),
			durationMs = durationMs,
			isCurrent = isCurrent,
			generating = generating,
			gaveUp = gaveUp,
			reason = reason,
		)
	}

	/**
	 * Take one entry out of the queue. The tile's trash, and the same action as a swipe on the bubble.
	 *
	 * Routed through skip when it is the HEAD, rather than reaching into the queue: the head is
	 * installed in the engine, so removing it without retiring the request would leave a playback whose
	 * terminal has nothing to advance, and the run would stop there.
	 */
	suspend fun dropFromQueue(entry: QueueEntry) {
		// ONE critical section, and it names the entry throughout. Deciding head-vs-not under the lock
		// and then acting outside it still let the head advance in between, so the trash discarded
		// whatever had become current rather than the tile that was tapped - the same "re-derive it
		// later from something coarser" shape this subsystem keeps producing.
		try {
			advanceMutex.withLock {
				if (queue.playing() == entry) {
					retireHead(entry)
					return@withLock
				}
				queue.drop(entry)
				// Giving up on a message gives up on where it had got to, exactly as a skip does - which
				// the abandon is told outright rather than left to work out from the outcome.
				stts.abandon(entry.team, entry.at, entry.tier, remember = false)
				stts.forgetPosition(entry.team, entry.at, entry.tier)
				// A way to EMPTY the queue has to be a way to release a pause. Trashing the entry a pause
				// parked otherwise leaves the flag set over an idle queue, refusing every later run on
				// every team with no enabled control left to clear it.
				resumeIfSilent()
			}
		} finally {
			transportChanged()
		}
	}

	/** Retire a NAMED head and start whatever follows it. The shared body of skip and of trashing the
	 * tile that is speaking, so the two cannot drift; both must already hold [advanceMutex]. */
	private fun retireHead(head: QueueEntry) {
		markerInFlight?.let { stts.abandonGeneration(it) }
		clearMarkers()
		stts.forgetPosition(head.team, head.at, head.tier)
		stts.abandon(head.team, head.at, head.tier, remember = false)
		// STOPPED, not COMPLETED. The queue advances on both, but only COMPLETED means "heard" - and a
		// skip that claimed it did cleared the message out of the failures list, telling the user they
		// had heard the very thing they had just given up on.
		val next = queue.advance(head, SttsPlayer.Outcome.STOPPED).next ?: return
		// Skip means "move past this one", NEVER "start playing". Clearing the pause here made the
		// lockscreen's own next button start the phone talking out loud from a state the user had
		// deliberately silenced - and every media app on the platform advances without sounding.
		//
		// The promoted entry has to be parked rather than left alone, because `advance` installs it as
		// the head BEFORE handing it back: declining to speak it would strand an entry the engine never
		// received and no terminal will ever retire. PREEMPTED puts it back at the front, which is
		// exactly where a resume should find it.
		if (transportPaused) {
			queue.advance(next, SttsPlayer.Outcome.PREEMPTED)
		} else {
			speak(next)
		}
	}

	/** Acknowledge one failure. "Seen", not "resolved" - the message was never spoken and this does not
	 * pretend otherwise; it only stops the alert asking again. */
	suspend fun acknowledgeFailure(entry: QueueEntry) {
		advanceMutex.withLock { queue.forgetFailure(entry) }
		transportChanged()
	}

	/**
	 * Where the current BODY is and how long it is, for the sheet's one bar. Null when nothing is
	 * playing, which the bar shows as disabled rather than as zero.
	 *
	 * Scoped to the head, so the bar is null through the chime and the sentinel rather than sweeping
	 * them. The plan is explicit that neither marker gets a timeline, and a bar that ran over one would
	 * invite a seek into audio there is nowhere useful to land in.
	 */
	fun playbackPosition(): SttsPlayer.Position? =
		stts.positionSnapshot()?.takeIf { it.entry == queue.playing() }

	/** Where the run would pick up while it is held. A pause has no player, so the live snapshot is
	 * null and the sheet showed nothing at all - blanking the timeline at precisely the moment the
	 * preserved position is the thing worth seeing. Duration stays unknown until audio exists again. */
	fun heldPosition(): Long? {
		if (!transportPaused) return null
		val parked = queue.queued().firstOrNull() ?: return null
		return stts.heldPosition(parked.team, parked.at, parked.tier)
	}

	/** Move the current body. Named, so a bar built a moment ago cannot seek whatever took the sound
	 * since - a marker, or the next message. */
	fun seekPlayback(ms: Long) {
		val snap = playbackPosition() ?: return
		stts.seekTo(snap.owner, ms)
	}

	/** Open the thread a queue entry belongs to, returning the CANONICAL key its tab is filed under so
	 * the caller can point the active tab at the same value. Revealing the message itself is the
	 * caller's half: only the view layer can scroll, and this class holds no view. */
	fun jumpTo(entry: QueueEntry): String = openThread(entry.team)

	/** What the bubble draws: how many are still to speak, whether the current one is still being
	 * generated, and how many gave up. The failure count outlives a drained queue, which is why it is
	 * reported separately rather than folded into the total. */
	fun queueCounts(): Triple<Int, Boolean, Int> {
		val queued = queue.queued()
		val head = queue.playing()
		val generating = head != null && !stts.isPlayingMessage(head.team, head.at)
		return Triple(queued.size, generating, queue.remembered().size)
	}

	/** Hand an entry to the engine, and synthesise its terminal ourselves if the engine would not take
	 * it. Without that, an entry the engine silently declines leaves the head un-retired and every
	 * message behind it unspoken for the life of the process. */
	private fun speak(entry: QueueEntry) {
		// Markers first when this entry is owed any. Their terminals chain the body behind them, so
		// this returns having started the boundary rather than the message. Markers staged for a
		// DIFFERENT entry are discarded: they name a session, and announcing the wrong one is worse
		// than announcing none.
		if (markersFor != entry) queueMarkers(entry, chime = false)
		if (nextMarkerStarted()) return
		speakBody(entry)
	}

	private fun speakBody(entry: QueueEntry) {
		val tier = entry.tier
		if (tier == null) {
			repoScope.launch { onPlaybackEnded(entry, SttsPlayer.Outcome.SYNTH_ERROR, reason = "no tier to speak") }
			return
		}
		// Yielding: by the time this reaches the player the user may have started something of their
		// own, and autoplay stands down rather than talking over it.
		stts.post {
			startPlayback(entry.team, entry.at, tier, yielding = true, attributed = false)?.let { why ->
				repoScope.launch { onPlaybackEnded(entry, SttsPlayer.Outcome.SYNTH_ERROR, reason = why) }
			}
		}
	}

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

	/** Map the autoPlay pref string to its tier, or null for "off"/unknown. */
	private fun autoPlayTier(value: String): SttsPlayer.Tier? = when (value) {
		"title" -> SttsPlayer.Tier.TITLE
		"summary" -> SttsPlayer.Tier.SUMMARY
		"full" -> SttsPlayer.Tier.FULL
		else -> null
	}

	/** Pre-synthesize every tier of a message into the cache so a later Play is
	 * instant. Blocking; runs off the poll loop on an IO thread. Silent on any
	 * failure - the notification fires regardless and Play falls back to live
	 * synthesis. No-op when unconfigured or the message is gone. */
	private fun preloadMessage(team: String, at: Long) {
		val client = sttsClient() ?: return
		val provider = currentProvider() ?: return
		val msg = _state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe } ?: return
		val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		stts.preloadTiers(
			client,
			provider,
			voice,
			team,
			at,
			ttsTextFramed(_state.value, msg, SttsPlayer.Tier.TITLE),
			ttsTextFramed(_state.value, msg, SttsPlayer.Tier.SUMMARY),
			ttsTextFramed(_state.value, msg, SttsPlayer.Tier.FULL),
		)
	}

	/** Settings voice preview with the current provider/voice. */
	fun playSttsSample() {
		stts.post {
			val client = sttsClient() ?: return@post
			val provider = currentProvider() ?: return@post
			val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
			stts.playSample(client, provider, voice, "This is your switchboard voice.", sttsVolume)
		}
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
			if (!firstRootIfPending()) return@withContext
			// Reflect the first-root latch into the UI state now, so if the steps below fail with the
			// no-gateway cause (a freshly-rooted friend has no host yet) the empty board shows the
			// "set up, now bring up a host" guidance rather than the admin Add-a-Gateway CTA.
			if (store.firstRooted && !_state.value.firstRooted) _state.update { it.copy(firstRooted = true) }
			// Submit this Console's own admission before the sealed register, so the Gateway
			// has an owner-signed reason to trust its sealed ops. Bearer-gated, so it lands
			// even though the Console is not admitted yet. A THROW here (e.g. the Keystore-backed
			// store is unavailable, so the member identity cannot be persisted) is the REAL cause;
			// surface it instead of falling through to register()'s generic "not enrolled".
			runCatchingCancellable { submitConsoleAdmission() }.onFailure { e ->
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

	/** First-root a pending friend Domain if the imported blob carries one (and it is not yet
	 * rooted). Builds a FirstRoot over this device's silent owner key + the invite nonce, self-signs
	 * it (FederationManager), and POSTs it to evie's console-bridge firstRoot intake. Returns true to
	 * let connect() proceed (nothing pending, already rooted, or a fresh root just succeeded), false
	 * to abort connect after surfacing a terminal reject (an expired / already-claimed invite, which
	 * does not self-heal). Idempotent: the firstRooted latch skips the round-trip on later connects. */
	private suspend fun firstRootIfPending(): Boolean {
		val prov = runCatching { store.load()?.let { Provisioning.parse(it) } }.getOrNull() ?: return true
		return when (val decision = FriendOnboarding.decide(prov, store.firstRooted)) {
			is FirstRootDecision.NotPending -> true
			is FirstRootDecision.Root -> {
				DebugLog.log("FirstRoot", "pending domain=${decision.domainId}; rooting at owner key ${federation.ownerSas()}")
				val signed = federation.signFirstRoot(decision.domainId, decision.nonce, System.currentTimeMillis())
				val result = runCatchingCancellable { client().firstRoot(signed) }.getOrElse {
					// A transport failure here is NOT terminal: the root was not decided, only
					// unreachable. Surface a transient cause and let the poll loop retry.
					val (cause, _) = classifyConnError(it)
					_state.update { s -> s.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L) }
					return false
				}
				if (result.ok) {
					store.firstRooted = true
					DebugLog.log("FirstRoot", "rooted ok domain=${decision.domainId}")
					true
				} else {
					// A transient evie reject (clock skew, CAS persist contention) leaves the latch
					// false and the poll loop re-attempts, so it surfaces as "connecting" (auto-retry),
					// not a terminal "error" that the user reads as a dead end.
					val reject = FriendOnboarding.classifyFirstRootError(result.error)
					DebugLog.log("FirstRoot", "rejected (transient=${reject.transient}): ${result.error?.take(120)}")
					_state.update {
						it.copy(
							status = if (reject.transient) "connecting" else "error",
							error = reject.message,
							connected = false,
							enrollingSince = 0L,
						)
					}
					false
				}
			}
		}
	}

	/** The owner key fingerprint the admin confirms when rooting the Domain on the
	 * host. Reading it mints the owner + console identities on first call. */
	fun ownerSas(): String = federation.ownerSas()

	fun ownerSignPub(): String = federation.ownerSignPub()

	fun ownerBoxPub(): String = federation.ownerBoxPub()

	/** Owner public material for the settings cards, or null when the stored owner key is
	 * corrupt. Non-throwing so a corrupt key renders a restore prompt rather than crashing the
	 * card; an absent key still mints (the silent first-gen). */
	fun ownerKeysForDisplay(): OwnerKeysView? = federation.ownerKeysForDisplay()

	/** This owner's display name, falling back to the local Domain id
	 * before discovery has stamped a name. Shown as "YOU" on the Users surface. */
	fun displayName(): String = state.value.displayName.ifEmpty { confirmedDomainId().orEmpty() }

	/** A passphrase-encrypted backup of the owner root key for offline safekeeping. */
	// Runs the scrypt KDF, so it stays off the main thread (the UI dispatches it from a
	// coroutine) - the same posture as importOwnerBackup.
	suspend fun exportOwnerBackup(passphrase: String): String =
		withContext(Dispatchers.IO) { federation.exportOwnerBackup(passphrase) }

	/** Restore the owner root key from a backup blob. The result lets the UI distinguish a
	 * wrong passphrase from a different-owner rejection. */
	suspend fun importOwnerBackup(blob: String, passphrase: String): OwnerRestoreResult =
		withContext(Dispatchers.IO) { federation.importOwnerBackup(blob, passphrase) }

	/** Submit an owner-signed fact to evie and fold it into the local keyring ONLY if evie
	 * accepted it, surfacing the error otherwise. The merge-iff-accepted invariant lives in
	 * this one place so an owner action cannot submit without the matching local merge
	 * (otherwise a revoked member could remain visible on the board). Secondary effects (the
	 * route-gateway pin, the console-admitted gate) stay at the call site after a true return. */
	private suspend fun <T> submitOwnerFact(
		signed: T,
		submit: suspend (T) -> EnrollResult,
		merge: (T) -> Unit,
		failLabel: String,
	): Boolean {
		val result = runCatchingCancellable { submit(signed) }.getOrElse {
			// runCatchingCancellable, not plain runCatching: submit() is the network call for all 6
			// owner-fact callers (submitConsoleAdmission, admitGateway, revokeMember, submitXdomainLink,
			// revokeXdomainLink, approveDevice) - a swallowed cancellation here would convert every one
			// of their cancellations into a normal EnrollResult(ok=false) rejection.
			DebugLog.log("Enroll", "$failLabel: submit threw ${it.javaClass.simpleName}: ${it.message?.take(140)}")
			EnrollResult(ok = false, error = it.message)
		}
		if (!result.ok) {
			DebugLog.log("Enroll", "$failLabel: evie rejected: ${result.error?.take(140) ?: "unknown"}")
			_state.update { it.copy(error = "$failLabel: ${result.error?.take(120) ?: "unknown"}") }
			return false
		}
		merge(signed)
		return true
	}

	/** Submit this Console's own owner-signed admission to evie so a Gateway trusts its
	 * sealed ops. The enroll op is bearer-gated (not sealed), so it lands before the
	 * Console is admitted; gated by a flag so connect does not re-issue it every cycle.
	 * The gateway may still be syncing the admission - the ENROLLING grace covers that. */
	private suspend fun submitConsoleAdmission() {
		if (store.consoleAdmitted) {
			// Distinguishes "the app believes it is already admitted and never POSTs" (which would
			// explain zero enroll ops reaching evie) from "it POSTs and the submit fails".
			DebugLog.log("Enroll", "submit skipped: consoleAdmitted flag already set")
			return
		}
		val signed = federation.consoleAdmission(System.currentTimeMillis())
		DebugLog.log("Enroll", "submitting console admission to evie (owner ${Crypto.fingerprint(signed.ownerSignPub)})")
		// submitOwnerFact surfaces the real cause (e.g. evie rooted at a different owner key)
		// so it does not hide behind the generic "finishing enrollment" the register hits next.
		if (submitOwnerFact(signed, { client().enroll(EnrollOp.SubmitAdmission(it)) }, federation::mergeAdmission, "Console admission rejected")) {
			store.consoleAdmitted = true
		} else {
			DebugLog.log("Federation", "console admission submit failed")
			// Throw so connect() surfaces this SPECIFIC cause and stops; otherwise register() runs
			// next and overwrites it with the generic sync-lag "finishing enrollment", masking it.
			error(_state.value.error ?: "Console admission rejected by the server")
		}
	}

	/** Owner-admit a scanned Gateway: owner-sign its admission, submit it to evie, and
	 * fold it into the local keyring so the Console can seal to it immediately (before
	 * evie's snapshot syncs back). Returns the signed admission for the caller to seal
	 * into the bootstrap bundle, or null on failure. */
	suspend fun admitGateway(gatewayId: String, signPub: String, boxPub: String): SignedAdmission? =
		withContext(Dispatchers.IO) {
			val signed = federation.admitGateway(gatewayId, signPub, boxPub, System.currentTimeMillis())
			if (!submitOwnerFact(signed, { client().enroll(EnrollOp.SubmitAdmission(it)) }, federation::mergeAdmission, "Admit failed")) {
				return@withContext null
			}
			// The first admitted Gateway becomes the route Gateway the Console seals to.
			if (store.loadGatewayId().isEmpty()) {
				store.saveGatewayId(gatewayId)
				localGatewayId = gatewayId
			}
			signed
		}

	/** Owner-revoke a member by its signing key: sign a revocation, submit it to evie,
	 * and drop the member from the local keyring. */
	suspend fun revokeMember(signPub: String) = withContext(Dispatchers.IO) {
		val signed = federation.revoke(signPub, System.currentTimeMillis())
		// The local merge folds the revocation into the keyring on success, so the member
		// drops off the board now instead of waiting for evie to rebroadcast it.
		submitOwnerFact(signed, { client().enroll(EnrollOp.SubmitRevocation(it)) }, federation::mergeRevocation, "Revoke failed")
	}

	/** Owner-sign a cross-Domain link edge (this Domain -> a linked friend Domain) and submit
	 * it to evie so its relay-affinity gate permits the cross-Domain crosstalk. Called on a
	 * link-handshake confirm. Returns true iff evie accepted it. There is no local keyring
	 * merge: the edge lives only in evie's edge set (the cross-Domain peer + its keys are
	 * written by the handshake confirm, not by this edge). */
	suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String, edgeNonce: String? = null): Boolean =
		withContext(Dispatchers.IO) {
			val signed = federation.signXdomainLinkEdge(srcDomainId, dstDomainId, System.currentTimeMillis(), edgeNonce)
			submitOwnerFact(signed, { client().enroll(EnrollOp.SubmitXdomainLink(it)) }, {}, "Link failed")
		}

	/** Owner-sign a cross-Domain link-edge revocation and submit it to evie so its
	 * relay-affinity gate refuses the cross-Domain crosstalk again. Called on unlink. Returns
	 * true iff evie accepted it. No local keyring merge, for the same reason as the edge. */
	suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String): Boolean = withContext(Dispatchers.IO) {
		val signed = federation.signXdomainLinkRevocation(srcDomainId, dstDomainId, System.currentTimeMillis())
		submitOwnerFact(signed, { client().enroll(EnrollOp.RevokeXdomainLink(it)) }, {}, "Unlink failed")
	}

	/** The admitted members of the keyring, for the management board. */
	fun admittedMembers(): List<MemberInfo> = federation.members()

	////////////////////////////////
	//  Add a device (USER self-enroll: the owner authorizes their OWN fresh device, no admin)

	/** evie's public device-approval reach for the authorize-console QR, or null when this network has
	 * no public ingress (the Add-a-device entry is then shown disabled). */
	fun deviceApprovalReach(): String? =
		runCatching { store.load()?.let { Provisioning.parse(it) } }.getOrNull()?.deviceApprovalReach?.takeIf { it.isNotEmpty() }

	/** HELD device: arm a one-time approval window and build the authorize-console QR. The QR carries
	 * PUBLIC material only (owner keys + Domain + the reach/token/nonce), never an SA token. Fails when
	 * the network has no public ingress or its Domain is not yet confirmed by a local session. */
	suspend fun armDeviceApproval(): Result<DeviceApprovalArmed> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val reach = deviceApprovalReach() ?: error("This network has no device-approval reach configured.")
			val domainId = confirmedDomainId() ?: error("Your Domain isn't confirmed yet - open a session first.")
			val approvalId = federation.freshApprovalToken()
			val nonce = federation.freshApprovalToken()
			val result = client().postConsoleApproval(ConsoleApprovalOp.Arm(approvalId = approvalId, nonce = nonce))
			if (!result.ok) error(result.error ?: "Couldn't arm the approval window.")
			val qr = JSONObject()
				.put("type", "authorize-console")
				.put("domainId", domainId)
				.put("signPub", federation.ownerSignPub())
				.put("boxPub", federation.ownerBoxPub())
				.put("approvalId", approvalId)
				.put("nonce", nonce)
				.put("reach", reach)
				.toString()
			DeviceApprovalArmed(approvalId, nonce, qr)
		}
	}

	/** HELD device: poll the window for the fresh device's join (its generated console keys). Null
	 * until it joins, so the screen keeps polling. */
	suspend fun pollDeviceApproval(approvalId: String): Result<ConsoleApprovalJoin?> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val result = client().postConsoleApproval(ConsoleApprovalOp.Poll(approvalId = approvalId))
			if (!result.ok) error(result.error ?: "approval window closed")
			result.join
		}
	}

	/** HELD device: approve the joined device. Owner-signs a kind:console admission for its keys and
	 * submits it (the existing submit_admission path), then seals the console transport to its box key
	 * and parks it for the device to fetch. The biometric gate is applied at the UI call site. */
	suspend fun approveDevice(approvalId: String, join: ConsoleApprovalJoin): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val signed = federation.admitConsole(join.newSignPub, join.newBoxPub, System.currentTimeMillis())
			if (!submitOwnerFact(signed, { client().enroll(EnrollOp.SubmitAdmission(it)) }, federation::mergeAdmission, "Approve failed")) {
				error(_state.value.error ?: "The server rejected the new device.")
			}
			val transport = buildConsoleTransport()
			val plain = wireJson.encodeToString(ConsoleTransport.serializer(), transport).toByteArray(Charsets.UTF_8)
			val sealed = federation.sealConsoleTransport(join.newBoxPub, plain)
			val result = client().postConsoleApproval(ConsoleApprovalOp.Approve(approvalId = approvalId, sealed = sealed))
			if (!result.ok) error(result.error ?: "Couldn't deliver the sealed transport.")
			Unit
		}
	}

	/** HELD device: tear down the approval window when the owner leaves the screen (best-effort). */
	suspend fun cancelDeviceApproval(approvalId: String) {
		withContext(Dispatchers.IO) {
			runCatchingCancellable { client().postConsoleApproval(ConsoleApprovalOp.Cancel(approvalId = approvalId)) }
		}
	}

	/** The console transport the held device seals to a new device: its own provisioning creds plus the
	 * owner's synced keyring + route Gateway, so the new device can seal to the Gateway the owner
	 * already admitted without holding the owner key to re-sync the keyring itself. */
	private fun buildConsoleTransport(): ConsoleTransport {
		val prov = Provisioning.parse(store.load() ?: error("not provisioned"))
		return ConsoleTransport(
			apiUrl = prov.apiUrl,
			caPem = prov.caPem,
			saToken = prov.saToken,
			appToken = prov.appToken,
			namespace = prov.namespace,
			service = prov.service,
			port = prov.port.toLong(),
			domainId = confirmedDomainId(),
			gatewayId = localGatewayId.takeIf { it.isNotEmpty() } ?: store.loadGatewayId().takeIf { it.isNotEmpty() },
			domainVersion = store.loadDomainVersion().ifEmpty { null },
			domain = federation.keyring().snapshot,
		)
	}

	/** Parse a scanned authorize-console QR, or null if it is not one. The owner signPub is pinned to
	 * verify the sealed reply; its fingerprint is shown so the human confirms the network. */
	suspend fun parseAuthorizeConsole(scanned: String): ScannedDeviceApproval? = withContext(Dispatchers.IO) {
		runCatching {
			val j = JSONObject(scanned.trim())
			require(j.optString("type") == "authorize-console")
			ScannedDeviceApproval(
				domainId = j.getString("domainId"),
				ownerSignPub = j.getString("signPub"),
				ownerBoxPub = j.getString("boxPub"),
				approvalId = j.getString("approvalId"),
				nonce = j.getString("nonce"),
				reach = j.getString("reach"),
				// N's OWN console key fingerprint - the SAME value the held device renders (it shows
				// fingerprint(newSignPub)) so the human can cross-check the two screens. An attacker who
				// saw the QR and joined first then shows a different code and is caught. The owner key
				// (signPub) is NOT shown here; it is only the unseal pin.
				sas = Crypto.fingerprint(federation.consoleIdentity().sign.pub),
			)
		}.getOrNull()
	}

	/** NEW device: announce this device's freshly-generated console keys to the held device by POSTing a
	 * join to the public ingress (nonce-gated, no creds). consoleIdentity() mints+persists the keys on
	 * first call, so the keys sent here are the SAME ones this device later unseals with. */
	suspend fun newDeviceJoin(scan: ScannedDeviceApproval): Result<Unit> = withContext(Dispatchers.IO) {
		runCatching {
			val id = federation.consoleIdentity()
			val op = ConsoleApprovalOp.Join(
				approvalId = scan.approvalId,
				nonce = scan.nonce,
				newSignPub = id.sign.pub,
				newBoxPub = id.box.pub,
				device = android.os.Build.MODEL,
			)
			val result = ConsoleClient.postPublicApproval(scan.reach, op)
			if (!result.ok) error(result.error ?: "The held device didn't accept this join.")
			Unit
		}
	}

	/** NEW device: poll the public ingress for the held device's sealed reply. Returns true once it
	 * arrives - unseals it (verifying the owner signPub pinned from the QR) and installs the transport;
	 * false while still pending, so the caller keeps polling. */
	suspend fun newDeviceFetch(scan: ScannedDeviceApproval): Result<Boolean> = withContext(Dispatchers.IO) {
		runCatching {
			val op = ConsoleApprovalOp.Fetch(approvalId = scan.approvalId, nonce = scan.nonce)
			val result = ConsoleClient.postPublicApproval(scan.reach, op)
			if (!result.ok) error(result.error ?: "The approval window expired.")
			val sealed = result.sealed ?: return@runCatching false
			val plain = federation.unsealConsoleTransport(sealed, scan.ownerSignPub)
			val transport = wireJson.decodeFromString(ConsoleTransport.serializer(), plain.toString(Charsets.UTF_8))
			installApprovedDevice(transport)
			true
		}
	}

	/** NEW device: install the unsealed transport. Writes the provisioning blob through the EXISTING
	 * provisioning store write, adopts the owner's synced keyring + route Gateway, and marks this device
	 * admitted - the held device already owner-signed + submitted its admission, and this device holds
	 * no owner key, so it must NEVER self-sign. provisioned flips LAST so the poll loop starts only
	 * after consoleAdmitted is set, never racing a self-admission with a throwaway owner key. */
	private fun installApprovedDevice(transport: ConsoleTransport) {
		val prov = com.atelier_nyaarium.switchboard.proto.Provisioning(
			apiUrl = transport.apiUrl,
			caPem = transport.caPem,
			saToken = transport.saToken,
			appToken = transport.appToken,
			namespace = transport.namespace,
			service = transport.service,
			port = transport.port,
		)
		val blob = wireJson.encodeToString(com.atelier_nyaarium.switchboard.proto.Provisioning.serializer(), prov)
		store.save(blob)
		store.consoleAdmitted = true
		store.firstRooted = true
		store.enrollCeremonyDone = true
		transport.domain?.let { snap ->
			store.saveDomain(
				wireJson.encodeToString(com.atelier_nyaarium.switchboard.proto.DomainSnapshot.serializer(), snap),
				transport.domainVersion ?: "",
			)
		}
		transport.gatewayId?.takeIf { it.isNotEmpty() }?.let {
			store.saveGatewayId(it)
			localGatewayId = it
		}
		// This is the ONE path besides a real first-root that sets firstRooted=true - it never
		// calls evie's first-root intake (the held device already rooted), so trace the latch
		// origin explicitly or a stuck-latch investigation cannot tell the two apart.
		DebugLog.log(
			"AddDevice",
			"installed approved-device transport; consoleAdmitted+firstRooted set, " +
				"keyring=${if (transport.domain != null) "adopted" else "absent"} gateway=${transport.gatewayId ?: "none"}",
		)
		client = null
		sttsClient = null
		val parsed = Provisioning.parse(blob)
		_state.update { it.copy(provisioned = true, error = null, deviceName = parsed.device, firstRooted = true) }
	}

	/** Fetch the cross-tenant roster (the Users surface): every member on this evie, by name +
	 * presence. evie-direct + signed-proof scoped; a non-member or auth failure surfaces as a
	 * failure with evie's opaque reason. The rendering surface consumes the rows. */
	suspend fun fetchRoster(): Result<List<com.atelier_nyaarium.switchboard.proto.RosterMember>> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val result = client().roster(federation.signRosterRequest(System.currentTimeMillis()))
				if (!result.ok) error(result.error ?: "roster unavailable")
				result.members ?: emptyList()
			}
		}

	////////////////////////////////
	//  Cross-Domain trust (the link/share/unlink surface the Federation UI drives)

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
	private fun confirmedDomainIdOrThrow(): String =
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

	/** Rename this owner's own display name: owner-sign a SET_ADMIN_NAME op over the admin Domain and
	 * submit it evie-direct. On success cache the new name + reflect it immediately (evie pushes a
	 * domain_update to this owner's gateways, so discovery will confirm it on the next refresh). */
	suspend fun setDisplayName(name: String): Result<Unit> = withContext(Dispatchers.IO) {
		val trimmed = name.trim()
		if (trimmed.isEmpty()) return@withContext Result.failure(IllegalArgumentException("Name cannot be empty"))
		val adminDomain = confirmedDomainId()
			?: return@withContext Result.failure(IllegalStateException("Domain not yet confirmed by a local session"))
		runCatchingCancellable {
			val signed = federation.signSetDisplayName(adminDomain, trimmed, System.currentTimeMillis())
			val result = client().enroll(EnrollOp.SetDisplayName(signed))
			if (!result.ok) error(result.error ?: "rename rejected")
			store.displayName = trimmed
			_state.update { it.copy(displayName = trimmed) }
		}
	}

	/** Revoke and delete this owner's OWN Domain (the app-only path; admins purge via setup.sh).
	 * Owner-sign the deletion FIRST, while the key still exists, then POST it evie-direct and await the
	 * result under a 30s ceiling. A confirmed purge AND an unconfirmed timeout/unreachable both wipe
	 * local state so the device is never left half-deleted; only an explicit evie rejection keeps state
	 * so the owner key survives a retry. The biometric gate (a destructive owner-key action) is at the
	 * call site, mirroring revoke/admit. */
	suspend fun deleteDomain(): DeleteDomainOutcome = withContext(Dispatchers.IO) {
		val domainId = confirmedDomainId()
			?: runCatching { store.load()?.let { Provisioning.parse(it).pendingTenant?.domainId } }.getOrNull()
		// No resolvable Domain id means nothing was ever rooted server-side; just wipe locally.
		if (domainId.isNullOrEmpty()) {
			clearAll()
			return@withContext DeleteDomainOutcome.WipedUnconfirmed
		}
		val signed = federation.signDeleteDomain(domainId, System.currentTimeMillis())
		// enroll() blocks on an OkHttp call (its own read timeout is the real ceiling) and THROWS when the
		// console bridge is unreachable. A reached-but-refused result keeps the owner key for a retry; a
		// throw (offline) falls to the unconfirmed wipe so a hung POST never strands the user mid-delete.
		val attempt = runCatchingCancellable { client().enroll(EnrollOp.DeleteDomain(signed)) }
		val result = attempt.getOrNull()
		when {
			result?.ok == true -> {
				clearAll()
				DeleteDomainOutcome.Deleted
			}
			attempt.isSuccess -> DeleteDomainOutcome.Rejected(result?.error ?: "delete rejected")
			else -> {
				clearAll()
				DeleteDomainOutcome.WipedUnconfirmed
			}
		}
	}

	////////////////////////////////
	//  Networks you host (guest tenants the admin pre-stages)

	/** The guest tenants this owner has staged, each with its discovery-derived state
	 * (awaiting-setup -> offline -> online). The locally-persisted rows supply the label + the
	 * invite nonce (so a row can re-render its QR before the friend's gateway ever appears);
	 * discovery upgrades the state once the friend roots + brings a gateway online. */
	fun hostedTenants(): List<HostedTenant> {
		val stored = loadHostedTenants()
		val teams = _state.value.teams
		return stored.map { it.copy(state = FriendOnboarding.hostedState(it.domainId, teams)) }
	}

	/** Stage a new guest tenant: mint an opaque domainId, owner-sign a provision_tenant op, submit
	 * it evie-direct, and persist the row with the one-time invite nonce evie returns (the QR is
	 * built from it). Returns the new row, or a failure carrying evie's reason. */
	suspend fun provisionTenant(displayName: String): Result<HostedTenant> = withContext(Dispatchers.IO) {
		val label = displayName.trim()
		if (label.isEmpty()) return@withContext Result.failure(IllegalArgumentException("Name cannot be empty"))
		runCatchingCancellable {
			val domainId = federation.newDomainId()
			val signed = federation.signProvisionTenant(domainId, label, System.currentTimeMillis())
			val result = client().provisionTenant(signed)
			val nonce = if (result.ok) result.nonce else null
			if (nonce.isNullOrEmpty()) error(result.error ?: "no invite nonce returned")
			val row = HostedTenant(domainId, label, nonce, HostedTenantState.AWAITING_SETUP)
			upsertHostedTenant(row)
			row
		}
	}

	/** Regenerate a pending tenant's one-time invite: re-submit provision_tenant for the SAME
	 * domainId, which mints a fresh nonce at evie (invalidating the prior one) without a remove +
	 * re-add. Returns the refreshed row. */
	suspend fun regenerateInvite(domainId: String, displayName: String): Result<HostedTenant> =
		withContext(Dispatchers.IO) {
			val label = displayName.trim().ifEmpty { return@withContext Result.failure(IllegalArgumentException("Name cannot be empty")) }
			runCatchingCancellable {
				val signed = federation.signProvisionTenant(domainId, label, System.currentTimeMillis())
				val result = client().provisionTenant(signed)
				val nonce = if (result.ok) result.nonce else null
				if (nonce.isNullOrEmpty()) error(result.error ?: "no invite nonce returned")
				// A regenerated invite is a fresh ceremony: drop the prior handshake secrets so the next
				// buildInviteBlob mints new ones (the old QR's broker window is abandoned with its nonce).
				enrollInvites.remove(domainId)
				val row = HostedTenant(domainId, label, nonce, HostedTenantState.AWAITING_SETUP)
				upsertHostedTenant(row)
				row
			}
		}

	/** Build the invite blob a hosted tenant's QR encodes: the CONSOLE-bridge transport creds the
	 * admin was itself provisioned with (this owner's own blob) plus the pending tenant's
	 * {domainId, nonce}. The friend reaches the SAME shared evie console-bridge as the admin and
	 * first-roots over the console-bridge /relay path; the admin's own console-bridge SA +
	 * CONSOLE_BRIDGE_TOKEN is what authorizes the friend's first_root there. The route Gateway's
	 * bootstrap-transport would instead hand over the gateway-bridge SA + BRIDGE_TOKEN, which the
	 * console-bridge service-proxy RBAC-403s and evie token-401s. The blob omits service/port so the
	 * friend defaults to evie-console-bridge:20004. The JSON is what the paste / file-import path
	 * also accepts. */
	suspend fun buildInviteBlob(tenant: HostedTenant): Result<String> = withContext(Dispatchers.IO) {
		runCatching {
			val blob = store.load() ?: error("This device is not provisioned. Re-import your setup blob first.")
			val prov = Provisioning.parse(blob)
			// Mint (once per tenant) the enroll-handshake secrets that seed the in-person compare and
			// embed them in the QR alongside this admin's owner keys + Domain. The pin rides the QR OUT
			// OF BAND (never sent to evie); the handshakeId keys the broker window the admin's leg polls.
			val invite = enrollInvites.computeIfAbsent(tenant.domainId) {
				EnrollInvite(handshakeId = federation.freshHandshakeId(), pin = federation.freshEnrollPin())
			}
			val adminDomain = confirmedDomainId() ?: error("Domain not yet confirmed by a local session")
			val enrollHandshake = JSONObject()
				.put("adminOwnerSignPub", federation.ownerSignPub())
				.put("adminOwnerBoxPub", federation.ownerBoxPub())
				.put("adminDomainId", adminDomain)
				.put("handshakeId", invite.handshakeId)
				.put("pin", invite.pin)
			val obj = JSONObject()
				.put("apiUrl", prov.apiUrl)
				.put("saToken", prov.saToken)
				.put("caPem", prov.caPem)
				.put("appToken", prov.appToken)
				.put("pendingTenant", JSONObject().put("domainId", tenant.domainId).put("nonce", tenant.nonce))
				.put("enrollHandshake", enrollHandshake)
			obj.toString()
		}
	}

	/** Drop a hosted tenant: owner-sign a remove_tenant op, submit it evie-direct, and forget the
	 * local row. evie deletes the Domain slice (and evicts a live guest gateway). */
	suspend fun removeHostedTenant(domainId: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val signed = federation.signRemoveTenant(domainId, System.currentTimeMillis())
			val result = client().enroll(EnrollOp.RemoveTenant(signed))
			if (!result.ok) error(result.error ?: "remove rejected")
			deleteHostedTenant(domainId)
		}
	}

	private fun upsertHostedTenant(row: HostedTenant) {
		val rows = loadHostedTenants().filterNot { it.domainId == row.domainId } + row
		persistHostedTenants(rows)
	}

	private fun deleteHostedTenant(domainId: String) {
		persistHostedTenants(loadHostedTenants().filterNot { it.domainId == domainId })
	}

	private fun loadHostedTenants(): List<HostedTenant> {
		val json = store.loadHostedTenants() ?: return emptyList()
		// Parse skip-and-keep per row: a single malformed entry (a write tear, a manual edit) must not
		// collapse the whole list to empty, because the next upsert/delete would then persist that loss
		// and permanently discard every other staged tenant. One bad row is dropped; the rest survive.
		val arr = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
		return (0 until arr.length()).mapNotNull { i ->
			runCatching {
				val o = arr.getJSONObject(i)
				HostedTenant(
					domainId = o.getString("domainId"),
					displayName = o.getString("displayName"),
					nonce = o.getString("nonce"),
					state = HostedTenantState.AWAITING_SETUP,
				)
			}.getOrNull()
		}
	}

	private fun persistHostedTenants(rows: List<HostedTenant>) {
		val arr = JSONArray()
		for (r in rows) {
			arr.put(JSONObject().put("domainId", r.domainId).put("displayName", r.displayName).put("nonce", r.nonce))
		}
		runCatching { store.saveHostedTenants(arr.toString()) }
	}

	/** The linked friend Domains. The trust roster comes from the route Gateway's cross-Domain peer
	 * set (pushed on the poll response's linkedPeers plane; see applyLinkedPeers): a peer is listed
	 * the moment it is linked, regardless of whether its gateway is online or has shared anything
	 * back. That set is unioned with the discovery-derived Domains so a just-linked peer is
	 * immediately visible (and its detail reachable to start sharing) before any of its sessions
	 * surface in discovery. Discovery still supplies the session count + presence; a peer present
	 * only in the peer set shows zero sessions / offline. */
	fun linkedDomains(): List<LinkedDomain> {
		val adminDomain = confirmedDomainId() ?: return emptyList()
		return CrossDomainLink.mergeLinkedDomains(_state.value.teams, _state.value.linkedPeerOwners, adminDomain)
	}

	/** Serializes every read-modify-write of knownCrossDomainPresenceVersions: applyLinkedPeers and
	 * applyCrossDomainPresence both merge against its OWN prior value (a filter/upsert, not a plain
	 * replace like the sibling knownPresenceVersions/knownLinkedPeersVersion fields), and refreshTeams()
	 * resets it from a DIFFERENT coroutine (a manual pull-to-refresh, not the poll loop) - both run on
	 * Dispatchers.IO's multi-threaded pool, so an unguarded compound operation could lose the reset
	 * underneath a poll response still applying stale pre-reset data. Mirrors freshTeamsMutex's own
	 * rationale for the identical concurrent-caller pair below. */
	private val crossDomainVersionsMutex = Mutex()

	/** Apply the linked-peers plane's pushed snapshot into state, so linkedDomains() can union it
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

	/** My LOCAL devcontainer/loose sessions, the only kinds shareable to a friend Domain (never the
	 * host-agent, the cli host, or a console). Drives the per-session share checkmarks. */
	fun shareableSessions(): List<Team> {
		val adminDomain = confirmedDomainId() ?: return emptyList()
		val gw = localGatewayId
		val s = _state.value
		return s.teams
			.filter { (it.domainId.isNullOrEmpty() || it.domainId == adminDomain) && (it.gatewayId.isEmpty() || it.gatewayId == gw) }
			.filter { it.kind == "devcontainer" || it.kind == "loose" }
			.sortedBy { s.label(it.name) }
	}

	/** RECEIVER: open a listening window, returning the token to read to the friend + this
	 * Gateway's keys + the expiry. */
	suspend fun crossDomainListen(): Result<com.atelier_nyaarium.switchboard.proto.CrossDomainListenResult> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable { client().crossDomainListen() }
		}

	/** REQUESTER: mint a one-time rendezvous pin, pair against the friend's token, and run the
	 * commit-reveal exchange. Returns the SAS + both sides' keys (and the pin, so confirm can pass
	 * it back). The Gateway uses this owner's admitted owner key, not the advisory value sent. */
	suspend fun crossDomainRequest(listeningToken: String): Result<CrossDomainPairing> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val pin = newRendezvousPin()
				val adminDomain = confirmedDomainId() ?: error("Domain not yet confirmed by a local session")
				val result = client().crossDomainRequest(
					listeningToken = listeningToken.trim(),
					pin = pin,
					requesterOwnerSignPub = federation.ownerSignPub(),
					requesterDomainId = adminDomain,
					requesterGatewayId = localGatewayId,
				)
				CrossDomainPairing(pin = pin, result = result)
			}
		}

	/** RECEIVER: poll the listening window's pairing state. Returns null until a requester pairs;
	 * once the exchange lands, returns the SAS + the friend (requester) keys the receiver
	 * owner-signs its own link over, plus the pin to pass to confirm. The receiver polls this on a
	 * short interval while on the link screen (its only path out of "awaiting request"). */
	suspend fun crossDomainListenState(listeningToken: String): Result<CrossDomainReceiverPairing?> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val state = client().crossDomainListenState(listeningToken)
				if (!state.pairingArrived) {
					return@runCatchingCancellable null
				}
				// pairingArrived implies the SAS + all friend keys + the pin are present (the gateway
				// only sets pairingArrived once round 2 records them); guard so a partial reply fails
				// loudly rather than signing a link over blanks.
				CrossDomainReceiverPairing(
					sas = state.sas ?: error("pairing arrived without a SAS"),
					friendOwnerSignPub = state.friendOwnerSignPub ?: error("pairing arrived without the friend owner key"),
					friendDomainId = state.friendDomainId ?: error("pairing arrived without the friend Domain id"),
					friendGatewayId = state.friendGatewayId ?: error("pairing arrived without the friend Gateway id"),
					friendGatewaySignPub = state.friendGatewaySignPub ?: error("pairing arrived without the friend sign key"),
					friendGatewayBoxPub = state.friendGatewayBoxPub ?: error("pairing arrived without the friend box key"),
				).also { receiverPin[listeningToken] = state.pin ?: error("pairing arrived without the pin") }
			}
		}

	/** REQUESTER confirm: owner-sign this owner's link over the RECEIVER's keys (from the request
	 * pairing the SAS just verified) and submit it. Only this owner's side is sent; the receiver
	 * confirms its own side independently. `linkNonce` is pinned by the wizard so a retry reuses
	 * the same signed link. */
	suspend fun crossDomainConfirmRequester(pairing: CrossDomainPairing, linkNonce: String): Result<ConfirmOutcome> =
		withContext(Dispatchers.IO) {
			val r = pairing.result
			confirmWithMyLink(
				pin = pairing.pin,
				peerOwnerSignPub = r.receiverOwnerSignPub,
				peerDomainId = r.receiverDomainId,
				peerGatewayId = r.receiverGatewayId,
				peerSignPub = r.receiverGatewaySignPub,
				peerBoxPub = r.receiverGatewayBoxPub,
				linkNonce = linkNonce,
			)
		}

	/** RECEIVER confirm: owner-sign this owner's link over the FRIEND (requester) keys learned from
	 * the listen-state poll and submit it. Uses the pin the poll surfaced (the requester minted it;
	 * the gateway resolves this window's pairing by it). Only this owner's side is sent. */
	suspend fun crossDomainConfirmReceiver(
		listeningToken: String,
		friend: CrossDomainReceiverPairing,
		linkNonce: String,
	): Result<ConfirmOutcome> = withContext(Dispatchers.IO) {
		val pin = receiverPin[listeningToken] ?: return@withContext Result.failure(
			IllegalStateException("no pairing pin for this listening window; poll the link state first"),
		)
		confirmWithMyLink(
			pin = pin,
			peerOwnerSignPub = friend.friendOwnerSignPub,
			peerDomainId = friend.friendDomainId,
			peerGatewayId = friend.friendGatewayId,
			peerSignPub = friend.friendGatewaySignPub,
			peerBoxPub = friend.friendGatewayBoxPub,
			linkNonce = linkNonce,
		)
	}

	/** Shared confirm core: owner-sign this owner's link over the friend Gateway's keys, submit it
	 * (the gateway verifies it under this owner's key + writes the cross-Domain peer), then
	 * owner-sign + submit the relay-affinity edge so the Router permits the crosstalk. The local peer
	 * write must succeed (it THROWS otherwise -> Result.failure -> the wizard restarts). The edge
	 * submit RETURNS false (not throws) on a Router rejection: the peer is then linked locally but
	 * cross-Domain sends to it would be DENIED, so the outcome distinguishes the two (RelayEdgeRejected
	 * carries the peer Domain for an edge-only retry) instead of silently reporting a full link. */
	private suspend fun confirmWithMyLink(
		pin: String,
		peerOwnerSignPub: String,
		peerDomainId: String,
		peerGatewayId: String,
		peerSignPub: String,
		peerBoxPub: String,
		linkNonce: String,
	): Result<ConfirmOutcome> = runCatchingCancellable {
		val mySignedLink = federation.signMyLink(
			peerOwnerSignPub = peerOwnerSignPub,
			peerDomainId = peerDomainId,
			peerGatewayId = peerGatewayId,
			peerSignPub = peerSignPub,
			peerBoxPub = peerBoxPub,
			nowMs = System.currentTimeMillis(),
			nonce = linkNonce,
		)
		// Record the OWNER-keyed friend edge (the Users-surface trust) - the SAS confirmed this owner key.
		federation.addTrustedOwner(peerOwnerSignPub)
		client().crossDomainConfirm(pin, mySignedLink)
		// The local peer is now written. The relay-affinity edge is a separate Router submit that
		// returns false on rejection; surface that as RelayEdgeRejected (recoverable by retrying the
		// edge alone) rather than letting the wizard show a false "Linked".
		if (submitXdomainLink(confirmedDomainIdOrThrow(), peerDomainId)) {
			ConfirmOutcome.Linked
		} else {
			ConfirmOutcome.RelayEdgeRejected(peerDomainId)
		}
	}

	/** Re-submit ONLY the relay-affinity edge for an already-linked peer (the local peer write
	 * happened at confirm; only the Router edge failed). Idempotent at evie (it dedups by nonce), so
	 * this needs no unlink+relink. Returns the same outcome shape so the wizard can loop on a repeat
	 * failure or advance to Done. */
	suspend fun retryXdomainLinkEdge(peerDomainId: String): Result<ConfirmOutcome> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			if (submitXdomainLink(confirmedDomainIdOrThrow(), peerDomainId)) {
				ConfirmOutcome.Linked
			} else {
				ConfirmOutcome.RelayEdgeRejected(peerDomainId)
			}
		}
	}

	/** A fresh owner-link nonce, pinned by the wizard for one pairing so a confirm retry reuses
	 * the same signed link bytes. */
	fun freshLinkNonce(): String = federation.freshLinkNonce()

	/** Cancel the pairing windows when the owner leaves the link screen (no passive surface). */
	suspend fun crossDomainCancel(listeningToken: String?, pin: String?) = withContext(Dispatchers.IO) {
		runCatchingCancellable { client().crossDomainCancel(listeningToken, pin) }
	}

	////////////////////////////////
	//  FLOW-1 enroll ceremony (the in-person admin <-> new-user trust compare, brokered by evie)

	/** The ADMIN leg context for a staged tenant's in-person compare: the handshakeId + pin the
	 * invite embedded (minted on buildInviteBlob) plus this owner's party. Null until the admin has
	 * generated the invite (so the QR and the ceremony share one handshake window). */
	fun adminEnrollContext(domainId: String): EnrollCeremonyContext? {
		val invite = enrollInvites[domainId] ?: return null
		val adminDomain = confirmedDomainId() ?: return null
		val myParty = EnrollParty(federation.ownerSignPub(), federation.ownerBoxPub(), adminDomain)
		return EnrollCeremonyContext(EnrollCeremony.ADMIN, invite.handshakeId, invite.pin, myParty, expectedPeer = null)
	}

	/** The ENROLLEE leg context after first-rooting an invited Domain: the handshakeId + pin + admin
	 * party read from the scanned blob, plus this owner's freshly-rooted party. The admin party is
	 * carried as `expectedPeer` so a substituted admin reveal is caught against the in-person QR, not
	 * only at the compare. Null when the blob carries no enroll handshake (an ordinary invite). The
	 * Domain id is taken from the blob's pendingTenant (the EXACT Domain this device just rooted), NOT
	 * confirmedDomainId() - which is null until a local discovery session lands. */
	fun enrolleeEnrollContext(): EnrollCeremonyContext? {
		val prov = runCatching { store.load()?.let { Provisioning.parse(it) } }.getOrNull() ?: return null
		val hs = prov.enrollHandshake ?: return null
		val myDomainId = prov.pendingTenant?.domainId ?: return null
		val myParty = EnrollParty(federation.ownerSignPub(), federation.ownerBoxPub(), myDomainId)
		val adminParty = EnrollParty(hs.adminOwnerSignPub, hs.adminOwnerBoxPub, hs.adminDomainId)
		return EnrollCeremonyContext(EnrollCeremony.ENROLLEE, hs.handshakeId, hs.pin, myParty, expectedPeer = adminParty)
	}

	/** The enrollee leg to run (or re-offer), or null when the blob carries no enroll handshake or the
	 * in-person compare is already done. Drives the post-first-root auto-launch and the board's
	 * "Verify with the admin" prompt - both go quiet once [markEnrolleeCeremonyDone] latches. */
	fun pendingEnrolleeCeremony(): EnrollCeremonyContext? =
		if (store.enrollCeremonyDone) null else enrolleeEnrollContext()

	/** Latch the enrollee compare as complete so it stops being offered (the trust edge is recorded). */
	fun markEnrolleeCeremonyDone() {
		store.enrollCeremonyDone = true
	}

	/** Run the commit-reveal exchange up to the human compare: commit this side, poll the broker for
	 * the peer's commitment, reveal, poll for the peer's reveal, verify the peer's reveal opens to its
	 * commitment (and, on the enrollee side, matches the QR-pinned admin keys), then compute the SAS
	 * locally. evie is a dumb broker throughout - every check here is on the phone. A terminal failure
	 * (broker reject, tamper, timeout) surfaces as Result.failure; cancellation (leaving the screen)
	 * cancels the suspend. */
	suspend fun enrollExchange(ctx: EnrollCeremonyContext): Result<EnrollExchange> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val salt = federation.freshEnrollSalt()
			val myReveal = com.atelier_nyaarium.switchboard.proto.EnrollReveal(
				ctx.myParty.ownerSignPub,
				ctx.myParty.ownerBoxPub,
				ctx.myParty.domainId,
				salt,
			)
			val commitment = SasCrypto.enrollCommitment(ctx.myParty, ctx.role, salt)
			val peerRole = EnrollCeremony.peerRole(ctx.role)

			// Round 1: commit, then poll (re-POSTing the same commit is idempotent) for the peer's.
			val peerCommitment = pollEnroll("commit") {
				val r = client().enrollHandshake(EnrollHandshakeOp.Commit(ctx.handshakeId, ctx.role, commitment))
				if (!r.ok) error(r.error ?: "enroll commit rejected")
				r.peerCommitment
			}
			// Round 2: reveal, then poll for the peer's reveal.
			val peerReveal = pollEnroll("reveal") {
				val r = client().enrollHandshake(EnrollHandshakeOp.Reveal(ctx.handshakeId, ctx.role, myReveal))
				if (!r.ok) error(r.error ?: "enroll reveal rejected")
				r.peerReveal
			}
			val peerParty = EnrollCeremony.partyOf(peerReveal)
			// Commit-reveal binding: the peer's reveal must open to its round-1 commitment.
			if (!EnrollCeremony.verifyPeer(peerCommitment, peerParty, peerRole, peerReveal.salt)) {
				error("The other phone's keys did not match its commitment (the relay tampered with the exchange). Rescan to restart.")
			}
			// Enrollee side: the admin's revealed keys MUST equal the in-person QR (the OOB
			// admin -> user authentication). A mismatch is an evie substitution of the admin reveal.
			ctx.expectedPeer?.let { expected ->
				if (peerParty != expected) {
					error("The admin keys did not match the scanned code (possible tampering). Rescan to restart.")
				}
			}
			EnrollExchange(
				sas = EnrollCeremony.sas(ctx.role, ctx.myParty, peerParty, ctx.pin),
				peerDomainId = peerReveal.domainId,
				peerParty = peerParty,
			)
		}
	}

	/** On a mutual [Yes]: owner-sign + submit this side's cross-Domain link edge (my Domain -> the
	 * peer's CONFIRMED Domain - the EXACT value the SAS bound, never a re-fetch). Mirrors the link
	 * wizard's edge result: Linked, or RelayEdgeRejected (the trust is recorded but the Router refused
	 * the relay edge, retryable). */
	suspend fun enrollConfirm(
		myDomainId: String,
		peerDomainId: String,
		edgeNonce: String,
		peerOwnerSignPub: String,
	): Result<ConfirmOutcome> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				// Record the OWNER-keyed friend edge first (the Users-surface trust): the compare confirmed
				// the peer's owner key, so trust the PERSON even if the relay edge below is rejected (a
				// gateway-less friend still becomes a friend; relay enables later).
				federation.addTrustedOwner(peerOwnerSignPub)
				// Pin the edge nonce so a retry / lost-ack re-submit re-signs the SAME edge (evie dedupes
				// by (src, nonce)) instead of accumulating a duplicate per attempt.
				if (submitXdomainLink(myDomainId, peerDomainId, edgeNonce)) {
					ConfirmOutcome.Linked
				} else {
					ConfirmOutcome.RelayEdgeRejected(peerDomainId)
				}
			}
		}

	////////////////////////////////
	//  Owner-keyed trust (the friend graph the Users surface reads)

	/** True iff this owner has trusted the given owner key (the Users-surface Trusted badge). */
	fun isOwnerTrusted(ownerSignPub: String): Boolean = federation.isTrusted(ownerSignPub)

	/** The set of trusted owner keys (the friend graph). */
	fun trustedOwners(): Set<String> = federation.trustedOwners()

	/** Untrust a person by owner key: drop the local friend edge + sign an owner-keyed untrust
	 * tombstone. The relay-affinity edge teardown (per the peer's Domains) is the gateway-side
	 * follow-up; the friend-graph removal is immediate so the Users surface reflects it now. */
	suspend fun untrustOwner(peerOwnerSignPub: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			// Drop the local friend edge first so the Users surface reflects the untrust immediately.
			federation.removeTrustedOwner(peerOwnerSignPub)
			// Capture the person's Domains BEFORE the local cleanup forgets the peers (a person may run
			// several), so we can revoke each Router-side relay edge. Owner-keyed via the peer set.
			val peerDomains = runCatchingCancellable {
				client().crossDomainListPeers().peers.filter { it.ownerSignPub == peerOwnerSignPub }.map { it.domainId }.toSet()
			}.getOrDefault(emptySet())
			// Tell the gateway to forget every peer + share for this owner across all their Domains
			// (owner-keyed local cleanup). Best-effort: the friend-graph removal already stands even if
			// the gateway is unreachable (a gateway-less owner has no peer state to drop anyway).
			runCatchingCancellable { client().crossDomainUntrust(peerOwnerSignPub) }
			// Router-side: revoke the owner-signed link edge for each of the person's Domains, so evie
			// drops its relay-affinity edge too (the tombstone's relay half, completing the untrust).
			for (d in peerDomains) {
				runCatchingCancellable { revokeXdomainLink(confirmedDomainIdOrThrow(), d) }
			}
			Unit
		}
	}

	/** Cancel this leg of the handshake (a [No], a timeout, or leaving the screen) so the broker tears
	 * the window down rather than leaving a half-formed edge. Best-effort. */
	suspend fun enrollCancel(handshakeId: String, role: String) = withContext(Dispatchers.IO) {
		runCatchingCancellable { client().enrollHandshake(EnrollHandshakeOp.Cancel(handshakeId, role)) }
	}

	////////////////////////////////
	//  FLOW-2 trust rendezvous (roster-initiated user-to-user trust)

	/** The sorted-owner-key role both sides agree on for the SYMMETRIC FLOW-2 SAS: the lower owner key
	 * takes the ADMIN slot, so both phones hash the two parties in the SAME order. Reuses enrollSas /
	 * enrollCommitment - no new SAS scheme (the rendezvousId is the pin). */
	private fun trustRole(myOwner: String, peerOwner: String): String =
		if (myOwner < peerOwner) EnrollCeremony.ADMIN else EnrollCeremony.ENROLLEE

	/** Mint a fresh rendezvous id (the initiator's; also the SAS pin both sides bind). */
	fun mintRendezvousId(): String = federation.freshRendezvousId()

	/** Poll "who armed trust toward me?" (the highlight). Returns the armed initiator rows (owner key
	 * + rendezvousId) so the Users surface highlights them. Best-effort. */
	suspend fun fetchPendingTrust(): Result<List<com.atelier_nyaarium.switchboard.proto.TrustPendingEntry>> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val r = client().trustPending(federation.signTrustPendingRequest(System.currentTimeMillis()))
				if (!r.ok) error(r.error ?: "trust pending unavailable")
				r.pending ?: emptyList()
			}
		}

	/** Run one side of the FLOW-2 commit-reveal compare over the rendezvous. `mySide` is INITIATOR (I
	 * armed) or TARGET (I joined a highlighted arm). Mirrors `enrollExchange`: commit (arm/join) ->
	 * poll peerCommit -> reveal -> poll peerReveal -> verify the commit-reveal binding + that the peer
	 * revealed the OWNER the rendezvous named -> compute the SAS. The result's `peerParty`/`peerDomainId`
	 * feed `enrollConfirm` (shared trust-confirm) on a [Yes]. */
	suspend fun trustExchange(
		rendezvousId: String,
		mySide: String,
		peerOwnerSignPub: String,
	): Result<EnrollExchange> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val myParty = federation.trustParty(confirmedDomainIdOrThrow())
				val myRole = trustRole(myParty.ownerSignPub, peerOwnerSignPub)
				val peerRole = EnrollCeremony.peerRole(myRole)
				val salt = federation.freshEnrollSalt()
				val myReveal = com.atelier_nyaarium.switchboard.proto.EnrollReveal(
					myParty.ownerSignPub,
					myParty.ownerBoxPub,
					myParty.domainId,
					salt,
				)
				val commitment = SasCrypto.enrollCommitment(myParty, myRole, salt)

				// Round 1: commit (the initiator ARMs, the target JOINs), then poll for the peer's.
				val peerCommitment = pollEnroll("commit") {
					val op = if (mySide == TRUST_SIDE_INITIATOR) {
						TrustHandshakeOp.Arm(rendezvousId, myParty.ownerSignPub, peerOwnerSignPub, commitment)
					} else {
						TrustHandshakeOp.Join(rendezvousId, myParty.ownerSignPub, commitment)
					}
					val r = client().trustHandshake(op)
					if (!r.ok) error(r.error ?: "trust commit rejected")
					r.peerCommitment
				}
				// Round 2: reveal, then poll for the peer's reveal.
				val peerReveal = pollEnroll("reveal") {
					val r = client().trustHandshake(TrustHandshakeOp.Reveal(rendezvousId, mySide, myReveal))
					if (!r.ok) error(r.error ?: "trust reveal rejected")
					r.peerReveal
				}
				val peerParty = EnrollCeremony.partyOf(peerReveal)
				// Commit-reveal binding: the peer's reveal must open to its round-1 commitment.
				if (!EnrollCeremony.verifyPeer(peerCommitment, peerParty, peerRole, peerReveal.salt)) {
					error("The other phone's keys did not match its commitment (the relay tampered with the exchange). Try again.")
				}
				// Anti-substitution: the peer must reveal the OWNER the rendezvous named (the arm /
				// highlight bound peerOwnerSignPub), so evie cannot splice in a different person.
				if (peerParty.ownerSignPub != peerOwnerSignPub) {
					error("The other person's identity did not match the trust request. Try again.")
				}
				EnrollExchange(
					sas = EnrollCeremony.sas(myRole, myParty, peerParty, rendezvousId),
					peerDomainId = peerReveal.domainId,
					peerParty = peerParty,
				)
			}
		}

	/** Cancel this leg of the trust rendezvous (a [No], timeout, or leaving). Best-effort. */
	suspend fun trustCancel(rendezvousId: String) = withContext(Dispatchers.IO) {
		runCatchingCancellable { client().trustHandshake(TrustHandshakeOp.Cancel(rendezvousId)) }
	}

	/** Poll one handshake step: call [step] (re-POSTing the same frame is idempotent at the broker)
	 * until it returns the peer's frame, with a bounded number of attempts so a vanished peer fails
	 * rather than hangs. [step] throws on a terminal broker reject, which propagates out. */
	private suspend fun <T> pollEnroll(label: String, step: suspend () -> T?): T {
		repeat(ENROLL_POLL_MAX) {
			step()?.let { return it }
			delay(ENROLL_POLL_MS)
		}
		error("Timed out waiting for the other phone ($label). Make sure you are both on this screen, then rescan.")
	}

	/** This owner's current per-session SPECIFIC-Domain shares as (sessionTarget, domainId) pairs, so
	 * the per-peer checkmark UI can render them (everyone-trusted shares are a separate mode). */
	suspend fun crossDomainShares(): Result<Set<Pair<String, String>>> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			client().crossDomainListShares().shares
				.mapNotNull { e ->
					(e.target as? com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain)?.let {
						e.sessionTarget to it.domainId
					}
				}
				.toSet()
		}
	}

	/** How many of MY sessions each TRUSTED person can reach, keyed by their owner key (the Users
	 * row's "N shared sessions"). A person reaches a session shared to one of their Domains OR shared
	 * to everyone-trusted. Joins the peer set (owner -> their Domains) with the share list. */
	suspend fun sharedSessionCounts(): Result<Map<String, Int>> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val ownerDomains = client().crossDomainListPeers().peers
				.filter { it.ownerSignPub.isNotEmpty() }
				.groupBy({ it.ownerSignPub }, { it.domainId })
			val shares = client().crossDomainListShares().shares
			val everyoneSessions = shares
				.filter { it.target is com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted }
				.map { it.sessionTarget }
				.toSet()
			val byDomain = shares
				.mapNotNull { e ->
					(e.target as? com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain)?.let {
						it.domainId to e.sessionTarget
					}
				}
				.groupBy({ it.first }, { it.second })
			ownerDomains.mapValues { (_, domains) ->
				(domains.flatMap { byDomain[it].orEmpty() }.toSet() + everyoneSessions).size
			}
		}
	}

	/** The sessions shared to EVERYONE the owner trusts (the Users-surface share mode). */
	suspend fun sessionsSharedToEveryone(): Result<Set<String>> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			client().crossDomainListShares().shares
				.filter { it.target is com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted }
				.map { it.sessionTarget }
				.toSet()
		}
	}

	/** Toggle a local session's share to a specific friend Domain (the checkmark IS the consent). */
	suspend fun setCrossDomainShare(sessionTarget: String, domainId: String, shared: Boolean): Result<Unit> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val target = com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain(domainId)
				if (shared) client().crossDomainShare(sessionTarget, target) else client().crossDomainUnshare(sessionTarget, target)
				Unit
			}
		}

	/** Toggle a local session's share to EVERYONE the owner trusts (the live-trust-set audience). */
	suspend fun setShareEveryoneTrusted(sessionTarget: String, shared: Boolean): Result<Unit> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val target = com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted
				if (shared) client().crossDomainShare(sessionTarget, target) else client().crossDomainUnshare(sessionTarget, target)
				Unit
			}
		}

	/** Unlink a friend Domain: forget the local trust + shares for it, then owner-sign + submit
	 * the link-edge revocation so the Router drops its relay-affinity edge. crossDomainUnlink's own
	 * server-side removal already bumps the linked-peers plane (see CrossDomainPeers' onChange
	 * hook), which wakes this device's own currently-held poll for free - no client-side action
	 * needed for that half. Mesh-wide discovery has no such push (see refreshDiscovery's own doc),
	 * so an explicit pull is still what makes the unlinked peer's sessions actually disappear from
	 * the board promptly instead of waiting out DISCOVERY_REFRESH_MS. */
	suspend fun unlinkDomain(domainId: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			client().crossDomainUnlink(domainId)
			revokeXdomainLink(confirmedDomainIdOrThrow(), domainId)
			refreshDiscovery()
			Unit
		}
	}

	private fun newRendezvousPin(): String {
		val bytes = ByteArray(18)
		java.security.SecureRandom().nextBytes(bytes)
		return android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
	}

	/** Parse a scanned admit-gateway QR, or null if it is not one. The SAS is the
	 * fingerprint of the Gateway's signing key, confirmed against the Gateway terminal. */
	fun parseAdmitGateway(scanned: String): ScannedGateway? = runCatching {
		val j = org.json.JSONObject(scanned.trim())
		if (j.optString("type") != "admit-gateway") return null
		val signPub = j.getString("signPub")
		val lan = j.optJSONObject("lan")
		ScannedGateway(
			gatewayId = j.getString("gatewayId"),
			signPub = signPub,
			boxPub = j.getString("boxPub"),
			sas = Crypto.fingerprint(signPub),
			lanHost = lan?.optString("host")?.ifEmpty { null },
			lanPort = lan?.optInt("port", 0)?.takeIf { it > 0 },
			nonce = j.optString("nonce").ifEmpty { null },
			certFp = lan?.optString("certFp")?.ifEmpty { null },
		)
	}.getOrNull()

	/** Enroll a scanned Gateway end to end: owner-admit it, then (if it offered LAN delivery)
	 * fetch the bootstrap transport from the route Gateway, seal a bootstrap bundle, and deliver
	 * it over the LAN, falling back to handing the admin the sealed text to paste. A
	 * host-configured Gateway (no LAN, no nonce) just needs the admission, which reaches it
	 * through evie's domain sync. */
	suspend fun enrollGateway(scanned: ScannedGateway): EnrollDelivery = withContext(Dispatchers.IO) {
		val signed = admitGateway(scanned.gatewayId, scanned.signPub, scanned.boxPub)
			// admitGateway sets _state.error to the real cause (e.g. "Admit failed: admission not
			// owner-signed" - this phone's owner key does not match the Domain root). Surface that
			// instead of a generic retry prompt so an owner-key mismatch is visible, not a black box.
			?: return@withContext EnrollDelivery(false, _state.value.error ?: "Couldn't add the Gateway. Try again.", null)
		val nonce = scanned.nonce
			?: return@withContext EnrollDelivery(true, "Added. This Gateway will come online shortly.", null)
		// Pull the gateway-bridge transport (proxy SA token + CA) from evie by proving this owner roots
		// a network. apiUrl + the network id come from the provisioning blob: apiUrl is the SAME external
		// apiserver the console bridge uses, and domainId is the rooted Domain the Gateway adopts.
		val prov = runCatching { store.load()?.let { Provisioning.parse(it) } }.getOrNull()
			?: return@withContext EnrollDelivery(true, "Added, but this device is not provisioned - re-import your setup blob.", null)
		val result = try {
			client().requestGatewayTransport(federation.signTransportRequest(System.currentTimeMillis()))
		} catch (e: Exception) {
			e.rethrowIfCancellation()
			// Surface the REAL transport-fetch cause (reached-but-rejected, an op failure) instead of
			// asserting "couldn't reach" + a re-provision that will not fix an admission/seal mismatch.
			return@withContext EnrollDelivery(
				true,
				"Added, but couldn't finish Gateway setup: ${e.message?.take(120) ?: "unknown error"}",
				null,
			)
		}
		if (!result.ok || result.saToken == null || result.caPem == null) {
			return@withContext EnrollDelivery(
				true,
				"Added, but couldn't finish Gateway setup: ${result.error?.take(120) ?: "transport unavailable"}",
				null,
			)
		}
		// The 4-field GatewayTransport; the Gateway fills namespace/service/port defaults when it
		// installs the bundle, and appToken is omitted (gateway-bridge auth is the SA token + admission).
		val transport = GatewayTransport(apiUrl = prov.apiUrl, saToken = result.saToken, caPem = result.caPem)
		val frame = federation.sealBundle(nonce, transport, signed, scanned.boxPub, prov.pendingTenant?.domainId)
		val frameJson = wireJson.encodeToString(GatewayBootstrapFrame.serializer(), frame)
		if (scanned.lanHost != null && scanned.lanPort != null && scanned.certFp != null && isPrivateLanHost(scanned.lanHost)) {
			val target = "${scanned.lanHost}:${scanned.lanPort}"
			when (val r = postBundle(scanned.lanHost, scanned.lanPort, scanned.certFp, frameJson)) {
				is BundlePost.Ok -> {
					DebugLog.log("Enroll", "LAN delivery ok -> $target")
					return@withContext EnrollDelivery(true, "Sent to the Gateway. It's coming online.", null)
				}
				is BundlePost.Rejected -> {
					DebugLog.log("Enroll", "LAN delivery rejected $target HTTP ${r.code} body=${r.body}")
					return@withContext EnrollDelivery(
						true,
						"The Gateway rejected the bundle (HTTP ${r.code}). Paste it into the Gateway's terminal instead.",
						frameJson,
					)
				}
				is BundlePost.Unreachable -> {
					DebugLog.log("Enroll", "LAN delivery unreachable $target cause=${r.cause}")
					return@withContext EnrollDelivery(
						true,
						"Couldn't reach the Gateway over the LAN. Paste the bundle into its terminal instead.",
						frameJson,
					)
				}
			}
		}
		EnrollDelivery(true, "Added. Copy the bundle to the Gateway's enrollment prompt.", frameJson)
	}

	/** The outcome of a LAN bundle POST, split so a Gateway-side rejection (a 4xx - meaning the bundle
	 * WAS delivered) is never reported as "couldn't reach": the two need very different user fixes. */
	private sealed interface BundlePost {
		object Ok : BundlePost
		data class Rejected(val code: Int, val body: String) : BundlePost
		data class Unreachable(val cause: String) : BundlePost
	}

	/** POST the sealed bundle to the Gateway's arming-only LAN listener over TLS pinned to the leaf
	 * fingerprint from the QR (see EnrollPinning). The bundle is already sealed to the Gateway box key,
	 * so this TLS only satisfies Android's no-cleartext policy without an app-wide permit and keeps the
	 * LAN wire private. Separates a connect failure from a Gateway-side rejection. */
	private fun postBundle(host: String, port: Int, certFp: String, frameJson: String): BundlePost {
		val client = buildLeafFingerprintPinnedClient(certFp)
		val req = Request.Builder()
			.url("https://$host:$port/enroll")
			.post(frameJson.toRequestBody("application/json".toMediaType()))
			.build()
		return try {
			client.newCall(req).execute().use { resp ->
				if (resp.isSuccessful) BundlePost.Ok
				else BundlePost.Rejected(resp.code, resp.body?.string()?.take(200) ?: "")
			}
		} catch (e: Exception) {
			BundlePost.Unreachable("${e.javaClass.simpleName}: ${e.message?.take(160) ?: ""}")
		}
	}

	/** True only for a private / loopback / link-local IP LITERAL. The admit-gateway QR
	 * carries the Gateway's LAN address and we POST the sealed bundle there, so restricting
	 * the target to an actual LAN address stops a tampered QR from redirecting the bundle
	 * (and the console's plaintext identity metadata) to a public attacker host - a non-LAN
	 * value falls through to the paste path instead. Numeric only: a QR-supplied hostname is
	 * never resolved, since that resolution is itself an attacker-chosen network call. */
	private fun isPrivateLanHost(host: String): Boolean = runCatching {
		android.net.InetAddresses.isNumericAddress(host) &&
			java.net.InetAddress.getByName(host).let { it.isLoopbackAddress || it.isSiteLocalAddress || it.isLinkLocalAddress }
	}.getOrDefault(false)

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
	private suspend fun refreshDiscovery() {
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

	/** board_read every NON-route Gateway the presence roster names (the route Gateway's half rides
	 * the plane). Fired on board-tab open, pull-refresh, and entering a non-route session's thread;
	 * a down Gateway just leaves its column stale. Same-Domain only: a linked friend's Gateway is
	 * not this owner's board. */
	fun refreshBoard() {
		repoScope.launch {
			for (gw in otherKeyringGateways(localGatewayId)) runCatchingCancellable { board.read(client(), gw) }
		}
	}

	/** This owner's admitted Gateways other than the route one. Keyring-derived, so a Gateway with
	 * no sessions in the roster is still reached, and a linked friend's is never included. */
	private fun otherKeyringGateways(route: String): List<String> =
		(Keyring.parse(store.loadDomain())?.admittedGatewayIds() ?: emptyList()).filter { it != route }

	/** Sessions an entry may be assigned to: a live session (never a spawn-point, which has no record
	 * for the gateway to resolve) on a Gateway this owner's keyring can seal to. The keyring is the
	 * test rather than the Domain fields, which say nothing about whether a seal would succeed. */
	fun boardAssignTargets(): List<Team> {
		val reachable = (otherKeyringGateways(localGatewayId) + localGatewayId).toSet()
		return _state.value.teams.filter {
			it.kind != "console" && it.kind != "devcontainer" && (it.gatewayId.isEmpty() || it.gatewayId in reachable)
		}
	}

	/** Forget a session that still holds unfinished board work. The disposition is a FIELD of the
	 * forget op, so the session's end and its work's end are one gateway-side mutation, and the
	 * gateway disposes of every entry it holds for that session rather than the subset this device
	 * happens to have polled.
	 *
	 * The pending queue is the other writer to those entries, so its actions for them are DROPPED
	 * first: an absolute write draining afterwards would overwrite the choice the owner just made.
	 * `onForgotten` runs only once the forget has actually landed - a session whose forget never
	 * reached its Gateway still exists, so destroying its design cards and notifications would strand
	 * the session with none of its history. */
	fun forgetWithBoardDisposition(team: String, cancelThem: Boolean, onForgotten: () -> Unit) {
		val asked = if (cancelThem) "cancel" else "release"
		board.dropQueuedForSession(boardGatewayOf(team), team)
		forget(team, asked, onForgotten)
	}

	/** Whether a session's thread belongs to a non-route Gateway (its board half is cadence-fresh
	 * through board_read rather than live on the plane). */
	fun isNonRouteSession(team: String): Boolean {
		val gw = _state.value.teams.firstOrNull { it.name == team }?.gatewayId ?: return false
		return gw.isNotEmpty() && gw != localGatewayId
	}

	/** The Gateway a session's board entries home on: its own, else the route Gateway. Takes a chat's
	 * `Team.name` (the qualified address). */
	fun boardGatewayOf(team: String?): String {
		val gw = team?.let { s -> _state.value.teams.firstOrNull { it.name == s }?.gatewayId }
		return gw?.ifEmpty { null } ?: localGatewayId
	}

	/** The same answer for an entry's stored `sessionId`, which is the bare local field rather than
	 * the address, so it cannot be matched against `Team.name` directly. NULL rather than the route
	 * fallback when nothing matches: the duplicate-id tie-break asks "is this copy homed where its
	 * session lives", and a total function answers yes for a session that is not there at all.  */
	fun boardGatewayOfKey(sessionKey: String): String? {
		if (sessionKey.isEmpty()) return null
		val gw = _state.value.teams.firstOrNull { localFieldOrSelf(it.name) == sessionKey }?.gatewayId
		return gw?.ifEmpty { localGatewayId }
	}

	/** Capture a thought onto the route Gateway's backlog: root level, after the last root. */
	fun boardCapture(title: String, body: String?) {
		val gw = localGatewayId
		val last = board.mergedEntries(gw)
			.filter { it.parent == null && it.trashedAt == null }
			.maxOfOrNull { it.rank }
		val entry = com.atelier_nyaarium.switchboard.proto.BoardEntry(
			id = UUID.randomUUID().toString().replace("-", "").take(32),
			title = title,
			body = body,
			state = "open",
			rank = com.atelier_nyaarium.switchboard.board.BoardRank.between(last, null),
		)
		board.enqueue(ConsoleOp.BoardUpsert(listOf(entry)), gw)
	}

	fun boardSetState(gatewayId: String, id: String, state: String) =
		board.enqueue(ConsoleOp.BoardSetState(id, state), gatewayId)

	fun boardSetTitle(gatewayId: String, id: String, title: String) =
		board.enqueue(ConsoleOp.BoardSetTitle(id, title), gatewayId)

	fun boardSetBody(gatewayId: String, id: String, body: String?) =
		board.enqueue(ConsoleOp.BoardSetBody(id, body), gatewayId)

	fun boardSetTrashed(gatewayId: String, id: String, trashed: Boolean) =
		board.enqueue(ConsoleOp.BoardSetTrashed(id, trashed), gatewayId)

	/**
	 * Set an entry's attachments to exactly this list, staging any newly picked file first.
	 *
	 * Absolute like every other board write: adding and removing are the same call, which is why the
	 * caller passes the whole list rather than a delta. A picked file is COPIED into the entry's own
	 * bucket before anything is queued - `admitPicked` stages a bare File with no src, and the copy is
	 * what mints one, which the gallery thumbnail needs anyway.
	 *
	 * Off the caller's thread, always. This arrives from a Compose click and does three full passes
	 * over a file the wire allows to be 500 MB: the content-resolver stage, the hash, and the copy.
	 * On the main thread that is an ANR on any real attachment.
	 */
	fun boardSetAttachments(gatewayId: String, id: String, keep: List<BoardAttachment>, add: List<Uri>) =
		command { boardSetAttachmentsNow(gatewayId, id, keep, add) }

	private fun boardSetAttachmentsNow(gatewayId: String, id: String, keep: List<BoardAttachment>, add: List<Uri>) {
		val bucket = Attachments.boardBucket(id)
		// Staged somewhere OTHER than the destination bucket: keepBuckets pins that bucket for the
		// entry's whole life, so a staged-N left in it would never be swept.
		val (staged, refused) =
			if (add.isEmpty()) emptyList<OutgoingFile>() to null else admitPicked(add, "pick-${UUID.randomUUID()}")
		if (refused != null) {
			_state.update { it.copy(error = refused.message()) }
			return
		}
		// Count only. Size is NOT bounded here: a board attachment rides the same chunked plane as any
		// other file and may be as large as the wire allows. What size decides is whether a device
		// fetches it unprompted, which is the gallery's business, not the picker's.
		if (keep.size + staged.size > Protocol.BOARD_ATTACHMENTS_MAX) {
			staged.forEach { it.source.delete() }
			_state.update { it.copy(error = "An entry holds at most ${Protocol.BOARD_ATTACHMENTS_MAX} attachments") }
			return
		}
		val sources = mutableMapOf<String, String>()
		val added = staged.mapNotNull { picked ->
			// Landed under its BLOB name, not its display name: a device that downloads this later
			// knows only the blobId, and the owner can pick two files called screenshot.png.
			val blobId = client?.blobIdOf(picked.source) ?: return@mapNotNull null
			val target = Attachments.boardFile(filesDir, id, blobId)
			target.parentFile?.mkdirs()
			picked.source.copyTo(target, overwrite = true)
			picked.source.delete()
			sources[blobId] = target.absolutePath
			BoardAttachment(
				blobId = blobId,
				blobGateway = gatewayId,
				filename = picked.name,
				mime = picked.mime,
				size = picked.size,
			)
		}
		// Every member this device can supply, not just the new picks. The op is absolute, so it
		// re-states the survivors too, and a survivor the Gateway does not hold is unsatisfiable
		// forever otherwise: after a move the destination never ingested it, and a second device
		// editing from a stale list can name one the owner has already removed. The bytes are usually
		// right here, because Question 4 keeps a copy on the device that opened the entry.
		for (a in keep) {
			val local = Attachments.boardFile(filesDir, id, a.blobId)
			if (local.isFile) sources[a.blobId] = local.absolutePath
		}
		// Bytes this entry no longer names, dropped from the device now. The orphan sweep keeps or
		// takes a whole BUCKET, so it can never reclaim one file out of an entry that still holds
		// others - a removed picture would sit there for the entry's whole life.
		// Only files NAMED as a blob: a `.landing` temp belongs to a download still in flight, and
		// deleting it here would tear that transfer's destination out from under it. Those are bounded
		// by the bucket, which goes whole when the entry does.
		val stays = (keep + added).mapTo(mutableSetOf()) { it.blobId }
		Attachments.boardBucketDir(filesDir, id).listFiles()?.forEach {
			if (it.name.startsWith("sha256-") && it.name !in stays) it.delete()
		}

		// `supplied` is a claim about THIS device's disk, nothing more: these are the members whose
		// bytes are here and going up. A member outside it that the Gateway also cannot find exists on
		// no machine, and the Gateway drops it instead of failing the write forever.
		board.enqueue(
			ConsoleOp.BoardSetAttachments(id, keep + added, supplied = sources.keys.toList()),
			gatewayId,
			sources = sources,
		)
		// Outside the drain, which is single-flight: a multi-minute transfer inside it would stall every
		// board write on every Gateway. repoScope so it survives the Activity going away mid-upload.
		// Cheap for a survivor the Gateway already holds - uploadBlob short-circuits on its stat.
		for ((_, source) in sources) kickBoardUpload(source, gatewayId)
	}

	/**
	 * The local file for one attachment, downloading it if this device does not have it yet.
	 *
	 * Question 4's "on open, and keep": the attaching device already holds the bytes, so its own peek
	 * is instant, and a second device or a reinstall pays once. Null while a fetch is running or after
	 * one gave up, which is what lets a tile show three states rather than a spinner that never ends.
	 */
	fun boardAttachmentFile(entryId: String, a: BoardAttachment): File? {
		val landed = Attachments.boardFile(filesDir, entryId, a.blobId)
		if (landed.isFile) return landed
		// Only small ones come down on their own. A large attachment is legitimate - the plane carries
		// it in chunks like anything else - but opening an entry must not spend hundreds of megabytes
		// of someone's data before they have asked for the file.
		if (a.size <= Protocol.BOARD_AUTO_DOWNLOAD_MAX_BYTES) kickBoardDownload(entryId, a)
		return null
	}

	/** The owner asking for a file the gallery would not fetch on its own. */
	fun boardDownloadAttachment(entryId: String, a: BoardAttachment) {
		boardFetchFailures.remove(a.blobId)
		kickBoardDownload(entryId, a)
	}

	/** Which attachments this device is fetching or has given up on, so a tile can say which. Plain
	 * maps rather than snapshot state: this class holds no Compose types, and the board's own
	 * revision is what the tiles already recompose on. */
	private val boardFetchFailures = java.util.Collections.synchronizedMap(mutableMapOf<String, Int>())
	private val boardDownloadsInFlight = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	fun boardAttachmentState(a: BoardAttachment): String = when {
		a.blobId in boardDownloadsInFlight -> "downloading"
		(boardFetchFailures[a.blobId] ?: 0) >= BOARD_FETCH_GIVE_UP -> "failed"
		a.size > Protocol.BOARD_AUTO_DOWNLOAD_MAX_BYTES -> "manual"
		else -> "pending"
	}

	private fun kickBoardDownload(entryId: String, a: BoardAttachment) {
		// A queued move is waiting on these, and nothing else can retire it, so giving up would leave
		// the origin's linked delete holding that Gateway's lane closed forever.
		val waiting = board.pendingFetches().firstOrNull { it.blobId == a.blobId }
		if (waiting == null && (boardFetchFailures[a.blobId] ?: 0) >= BOARD_FETCH_GIVE_UP) return
		if (!boardDownloadsInFlight.add(a.blobId)) return
		// While a move is queued, the RECORD already names the destination, which by construction does
		// not have the bytes yet. The queued action knows where they actually are.
		val holder = waiting?.holder ?: a.blobGateway
		repoScope.launch {
			try {
				val target = Attachments.boardFile(filesDir, entryId, a.blobId)
				val c = client() ?: return@launch
				val staged = c.downloadBlob(a.blobId, holder)
				target.parentFile?.mkdirs()
				// Through a temp and a rename. A direct overwrite deletes the good copy first and leaves
				// a TRUNCATED file if the process dies mid-copy, which nothing would ever correct: the
				// gallery renders the partial bytes forever, and `supplied` would then assert a blobId
				// this device cannot actually produce, putting the write into an unsatisfiable retry.
				val tmp = File(target.parentFile, "${target.name}.landing")
				try {
					staged.copyTo(tmp, overwrite = true)
					if (!tmp.renameTo(target)) error("could not land ${a.filename}")
				} finally {
					// Whatever went wrong, the partial goes with it. The usual trigger is a full disk, so
					// leaking here would consume more of the exact resource whose exhaustion caused the
					// failure, and nothing else collects it: this entry's bucket is kept for its whole life.
					tmp.delete()
				}
				// The blob store is a transfer buffer; holding the landed copy too would keep every
				// attachment twice on the device with the least room for it.
				c.forgetBlob(a.blobId)
				boardFetchFailures.remove(a.blobId)
				board.revision.longValue++
			} catch (e: Exception) {
				e.rethrowIfCancellation()
				// Bounded like a message's own fetch: a picture whose bytes are gone must stop asking.
				boardFetchFailures[a.blobId] = (boardFetchFailures[a.blobId] ?: 0) + 1
				DebugLog.log("Board", "attachment fetch failed: ${e.message?.take(80)}")
				// So the tile repaints as "could not download" rather than sitting on the last state.
				board.revision.longValue++
			} finally {
				boardDownloadsInFlight.remove(a.blobId)
			}
		}
	}

	/** Every board bucket already on disk, for the one case where the board cannot say which are live. */
	private fun existingBoardBuckets(): Set<String> =
		Attachments.root(filesDir).listFiles()
			?.filter { it.isDirectory && it.name.startsWith("board-") }
			?.mapTo(mutableSetOf()) { it.name }
			?: emptySet()

	/** Restart the transfers whose kick died with the process, or with a failure that only logged.
	 * The queued action survived either way, so without this the drain would check forever and the
	 * picture would never go up. Cheap to repeat: an upload resumes from the Gateway's own cursor. */
	private fun resumeBoardUploads() {
		for ((_, source, gatewayId) in board.pendingSources()) kickBoardUpload(source, gatewayId)
		// A move's attach waits on bytes this device may never have held. Its own kick dies with the
		// process, and nothing else would ever start it again, so the action would wait forever and its
		// linked origin delete would hold that Gateway's lane closed behind it.
		for ((entryId, blobId, holder) in board.pendingFetches()) {
			if (Attachments.boardFile(filesDir, entryId, blobId).isFile) continue
			// Everything needed is on the action itself. Searching a cached view for the blobId instead
			// answers nothing once the upsert has retired, and can match the wrong entry when the same
			// picture hangs on two of them. Only blobId and gateway are read downstream; the rest of
			// this record is filler, and kickBoardDownload resolves the holder from the queue anyway.
			kickBoardDownload(entryId, BoardAttachment(blobId, holder, blobId, "application/octet-stream", 0))
		}
	}

	/** One transfer per source at a time. Without the guard the poll cadence would start a second
	 * upload of the same file every pass, each racing the last for the same offsets. */
	private val boardUploadsInFlight = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	private fun kickBoardUpload(source: String, gatewayId: String) {
		if (!boardUploadsInFlight.add(source)) return
		repoScope.launch {
			try {
				client?.uploadBlob(File(source), gatewayId)
			} catch (e: Exception) {
				e.rethrowIfCancellation()
				DebugLog.log("Board", "attachment upload failed: ${e.message?.take(80)}")
			} finally {
				boardUploadsInFlight.remove(source)
			}
		}
	}

	/** Assign an entry (and its subtree, gateway-side) to a session, or null back to the backlog. A
	 * target session homed on ANOTHER Gateway is a MOVE: upsert the subtree there, linked delete
	 * here, and the entry keeps its id so the union collapses the crash-window duplicate. */
	fun boardAssign(fromGateway: String, id: String, team: String?) {
		val target = boardGatewayOf(team)
		// The stored value is the bare local field, never the address the chat tab is keyed by; the
		// optimistic row has to group the same way the gateway will store it.
		val sessionId = team?.let { board.sessionKeyOf(it) }
		if (sessionId == null || target == fromGateway) {
			board.enqueue(ConsoleOp.BoardSetSession(id, sessionId), fromGateway)
			return
		}
		val entries = board.mergedEntries(fromGateway)
		val children = entries.groupBy { it.parent }
		val subtree = mutableListOf<com.atelier_nyaarium.switchboard.proto.BoardEntry>()
		// Visited set, like every other walk over this tree: a self-parent from bad data would
		// otherwise grow the list forever on the main thread.
		val seen = mutableSetOf<String>()
		val stack = ArrayDeque(listOf(id))
		while (stack.isNotEmpty()) {
			val cur = stack.removeLast()
			if (!seen.add(cur)) continue
			val e = entries.firstOrNull { it.id == cur } ?: continue
			subtree.add(e.copy(sessionId = sessionId))
			for (kid in children[cur] ?: emptyList()) stack.addLast(kid.id)
		}
		if (subtree.isEmpty()) return
		// The moved root joins the destination at top level: its old parent stays behind.
		subtree[0] = subtree[0].copy(parent = null)
		// A moved picture lands under the SAME name in the destination's bucket, since the bucket is
		// keyed by entry and the entry keeps its id across a move.
		board.enqueueMove(subtree, fromGateway, target) { entryId, blobId ->
			Attachments.boardFile(filesDir, entryId, blobId).absolutePath
		}
		// Pull anything this device never opened. The queued write retries until the bytes are here,
		// rather than abandoning, because for a move a missing local file is normal.
		for (entry in subtree) {
			for (a in entry.attachments.orEmpty()) {
				if (!Attachments.boardFile(filesDir, entry.id, a.blobId).isFile) kickBoardDownload(entry.id, a)
			}
		}
	}

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
	private fun admitPicked(uris: List<Uri>, bucket: String): Pair<List<OutgoingFile>, Admission.Refused?> {
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

	private fun queryName(uri: Uri): String? = runCatching {
		contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
			if (c.moveToFirst()) c.getString(0) else null
		}
	}.getOrNull()

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
					resumeBoardUploads()
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
						val autoTier = autoPlayTier(sttsAutoPlay)
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
							val at = lastAgent!!.at
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
								if (sttsAutoGen) preloadMessage(warm.first, warm.second)
								onInbound?.invoke(t, ms)
								// Hands-free: queue every arriving message in order. The queue
								// speaks the first immediately and the rest as each terminal
								// lands, so a burst is heard whole instead of only its last.
								if (autoTier != null) {
									for ((msg, owner) in queueable) {
									enqueueForPlay(owner, msg.at, autoTier, announceRun = true)
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
					// re-acquire an already-released wakelock (see console-hardening.md).
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
		resumeBoardUploads()
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
			Attachments.sweepOrphanBuckets(filesDir, referencedSrcs, keep + existingBoardBuckets())
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
		repoScope.launch { dropQueuedFor(key) }
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
		// Admitted like any other pick: a draft is just a send that has not happened yet, and this
		// path previously had no size bound at all.
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
			dropQueuedFor(key)
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
		private const val BOARD_FETCH_GIVE_UP = 3

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
