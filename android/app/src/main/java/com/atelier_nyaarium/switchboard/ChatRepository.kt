package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import com.atelier_nyaarium.switchboard.crypto.ownerKeyId
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.FocusIntent
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.SyncEntry
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.parseTarget
import java.io.File
import java.time.ZoneId
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch

/** Wraps a drained MailboxEntry as a SyncEntry so the SyncCursor rules can dedupe/advance
 * by seq while the poll loop keeps the full entry to render. */
internal data class Drained(val entry: MailboxEntry) : SyncEntry {
	override val seq: Long get() = entry.seq
}

/** In-memory state belonging to the CURRENT provisioning. A holder states its own wipe beside the
 * fields it clears; the set of holders is [ChatRepository.clearedOnReprovision]. */
internal interface ClearsOnReprovision {
	/** Runs after the durable wipe, so nothing here persists. Suspending: a holder may hold a mutex. */
	suspend fun clearInMemory()
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
) : ClearsOnReprovision {
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
	// internal (not private): SessionOps.listDirs reads them; seedSandbox below is the only writer.
	@Volatile internal var sandboxDirs: Map<String, List<String>>? = null
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
			goals = persistence.loadPersistedGoals(),
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
	// internal (not private): SessionOps and the thread surface (ChatRepositoryThreads.kt) resolve a
	// target against the same Domain.
	internal fun localDomain(): String = confirmedDomainId() ?: ""

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
	// The team roster and the plane snapshots that keep it true, holding the raw-snapshot cache and
	// the read anchors this device last reported (see PresenceOps' own doc).
	internal val presence = PresenceOps(this)
	// A session's life beyond its transcript: terminal view, spawn, wake, forget (see SessionOps'
	// own doc). Both read nothing here while constructing, so both may be declared anywhere.
	internal val sessions = SessionOps(this)
	// ADMIN-side enroll-invite secrets (handshakeId + pin) minted per staged tenant when the invite
	// blob is built, reused to drive the admin's leg of the in-person compare. Transient like the link
	// ceremony's linkNonce: the in-person flow keeps the detail screen open, and regenerating the
	// invite mints fresh secrets (abandoning the old QR's window). internal: shared by EnrollCeremonyOps
	// (adminEnrollContext) and DomainAdminOps (regenerateInvite, buildInviteBlob).
	internal val enrollInvites = java.util.concurrent.ConcurrentHashMap<String, EnrollInvite>()
	@Volatile internal var sttsClient: SttsClient? = null

	////////////////////////////////
	//  Re-provision wipe

	/** [clearAll] wipes exactly this set. A delegate that gains a cache belongs here; one nobody
	 * remembered to reach is how the board went on serving the previous owner's entries. */
	internal val clearedOnReprovision: List<ClearsOnReprovision>
		get() = listOf(this, board, presence, trust, drain)

	/** This class's own share: the connection, the ids and cursor learned from the blob, and the
	 * invite secrets staged against the outgoing Domain. */
	override suspend fun clearInMemory() {
		client = null
		sttsClient = null
		localGatewayId = ""
		mailboxSync.clearInMemory()
		forgottenUntil.clear()
		reconciled.clear()
		enrollInvites.clear()
	}

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
	// internal (not private): SessionOps.forget stamps a tombstone and PresenceOps sweeps them.
	internal val forgottenUntil = java.util.concurrent.ConcurrentHashMap<String, Long>()
	// Rows already given their one reconcile attempt this process. Synchronized:
	// the service's start and the Activity's foreground transition can race here.
	// internal (not private): reconcilePending (ChatRepositorySend.kt) is its only reader.
	internal val reconciled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	// This device's currently-declared focus (what poll() presents as `focus`), read fresh on every
	// poll - see declareFocus. Starts "background": a cold app has not yet observed the board or a
	// terminal, so it should not falsely claim the board's ramped cadence before the UI ever renders.
	@Volatile internal var currentFocus: FocusIntent = FocusIntent(screen = "background")

	/** The poll loop and mailbox drain (see PollDrain.kt): the loop lifecycle, the plane version
	 * cursors and both drain-gate subscriber lists live there; it reaches back into this class the
	 * way the federation Ops delegates do. */
	internal val drain = PollDrain(this)

	/** Goals armed against a session (see GoalOps). */
	internal val goals = GoalOps(this)

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

	/** The SAF tree the user chose to save attachments into. Raw string: whether the grant behind it
	 * is still alive is SaveTarget's question, and a caller must ask it rather than trust this. */
	var saveTreeUri: String
		get() = store.saveTreeUri
		set(value) {
			store.saveTreeUri = value
		}

	// connect()'s own initial fetch stays a direct teams() pull (a cold-boot fetch has no presence
	// version to present yet either way); withoutTombstoned is used only there now, since every
	// OTHER wholesale-apply path routes through PresenceOps.reapplyCachedTeams.
	// internal (not private): connect() (ChatRepositoryDomainLink.kt) is that one caller.
	internal fun List<Team>.withoutTombstoned(): List<Team> = filterTombstoned(this, forgottenUntil, System.currentTimeMillis())

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
		goals: Map<String, PendingGoal> = emptyMap(),
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
				// Seeded rather than armed: arming sends, which a gatewayless sandbox cannot do.
				goals = goals,
			)
		}
	}

	fun setBiometricLock(enabled: Boolean) {
		store.biometricLock = enabled
		_state.update { it.copy(biometricLock = enabled) }
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
