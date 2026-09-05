package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter
import com.atelier_nyaarium.switchboard.crypto.ownerKeyId
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.BoardWriteResult
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


internal data class Drained(val entry: MailboxEntry) : SyncEntry {
	override val seq: Long get() = entry.seq
}

internal interface ClearsOnReprovision {
	suspend fun clearInMemory()
}

data class FocusIntent(
	val screen: String,
	val terminalTeam: String? = null,
	val terminalRateMs: Long? = null,
)

class ChatRepository(
	internal val store: AppStateStore,
	internal val filesDir: File,
	internal val contentResolver: ContentResolver,
	internal val sttsCatalog: List<com.atelier_nyaarium.switchboard.proto.SttsProvider> = emptyList(),
) : ClearsOnReprovision {
	internal val federation = FederationManager(store)
	internal val identity = PhoneIdentity(store, federation)
	internal val ambient = PhoneAmbient.system()
	internal val bootState: StateFlow<BootState> get() = identity.bootState
	private var ownerOpsBoot: PhoneBootstrap? = null
	private var ownerOpsValue: OwnerOps? = null
	private var keyDeliveryBoot: PhoneBootstrap? = null
	private var keyDeliveryValue: KeyDeliveryOps? = null
	val stts = SttsPlayer(filesDir)

	val board = com.atelier_nyaarium.switchboard.board.BoardManager(store)

	val vault = com.atelier_nyaarium.switchboard.vault.VaultManager(store)

	@Volatile internal var homeGatewayId: String = store.loadGatewayId()
	@Volatile internal var gapFloor: Long = 0L
	@Volatile internal var gapDropped: Long = 0L
	internal var onScheduledResult: (com.atelier_nyaarium.switchboard.proto.ScheduledResultRow) -> Unit = {}
	internal var onBoardObservation: (com.atelier_nyaarium.switchboard.proto.BoardObservationRow) -> Unit = {}

	internal val persistence = ChatPersistence(store)
	internal val mutationJournal = MutationJournal(filesDir)

	init {
		// Migrate before loading persisted threads.
		if (store.migrateSchemaIfNeeded()) {
			// Purge caches invalidated by schema migration.
			stts.purgeAll()
			Attachments.purgeAll(filesDir)
		}
	}

	internal val sandboxDirs: Map<String, List<String>>? get() = sandboxSeeder.sandboxDirs
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
			homeGatewayId = homeGatewayId,
			displayName = store.displayName,
			firstRooted = store.firstRooted,
			lastProjectByGateway = store.lastProjectByGateway,
			scheduledSends = persistence.loadPersistedScheduledSends(),
			goals = persistence.loadPersistedGoals(),
			drafts = persistence.loadPersistedDrafts(),
		),
	)
	val state: StateFlow<ChatState> = _state


	internal fun localDomain(): String = provisioningHost.localDomain()

	internal fun transport(): ConsoleRouterTransport = provisioningHost.transport()

	internal fun canonicalTarget(team: String): String =
		runCatching { parseTarget(team, localDomain(), homeGatewayId).canonical }.getOrDefault(team)

	internal fun fromCanonical(from: String): String? =
		runCatching { parseTarget(from, localDomain(), homeGatewayId).canonical }.getOrNull()

	internal fun thisDeviceAddress(): Address? =
		runCatching {
			Address.local(localDomain(), homeGatewayId, ownerKeyId(federation.ownerSignPub()), Protocol.DEFAULT_SESSION)
		}.getOrNull()

	internal val provisioningHost: RepositoryProvisioningHost = ChatRepositoryProvisioningHost(this)
	internal val attachmentHost: AttachmentHost = ChatRepositoryAttachmentHost(this)
	internal val mailboxSync = MailboxSync(store)
	val pushback = IdlePushbackManager(store, System.currentTimeMillis()) { ZoneId.systemDefault() }

	internal val transportCoordinator = ConsoleTransportCoordinator(pushback)
	internal lateinit var cursorTranslation: CursorTranslationOps
	internal lateinit var selfMigration: SelfMigration

	internal fun readyOrNull(): PhoneBootstrap? = identity.readyOrNull()

	internal suspend fun ready(): PhoneBootstrap = identity.ready()

	@Synchronized
	internal fun ownerOpsOrNull(): OwnerOps? {
		val boot = readyOrNull() ?: return null
		if (ownerOpsBoot !== boot) {
			ownerOpsBoot = boot
			ownerOpsValue = OwnerOps(boot, ambient)
		}
		return ownerOpsValue
	}

	@Synchronized
	internal fun keyDeliveryOrNull(): KeyDeliveryOps? {
		val boot = readyOrNull() ?: return null
		if (keyDeliveryBoot !== boot) {
			keyDeliveryBoot = boot
			keyDeliveryValue = KeyDeliveryOps(
				boot,
				ambient,
				KeyDeliveryCollaborators(
					signOwnerOp = { op -> ownerOpsOrNull()?.sign(op) },
					sendOwnerOp = { client().postOwnerOp(it) },
					install = { envelope, trust -> identity.installContentKey(boot, envelope, trust) },
					reportError = { message -> _state.update { it.copy(error = message) } },
				),
			)
		}
		return keyDeliveryValue
	}

	internal val ownerOps: OwnerOps get() = ownerOpsOrNull() ?: error("Domain not yet confirmed by a local session")
	internal val keyDelivery: KeyDeliveryOps get() = keyDeliveryOrNull() ?: error("Domain not yet confirmed by a local session")

	internal fun boardSealing() = provisioningHost.boardSealing()

	internal fun vaultSealing() = provisioningHost.vaultSealing()

	init {
		board.sealing = { boardSealing() }
	}

	internal val socket: ConsoleSocketDriver = ConsoleSocketDriver(
		coordinator = transportCoordinator,
		newClient = { listener ->
				ConsoleSocketClient(client().transport, ownerOps, listener, socketMode = ConsoleSocketMode.INBOX)
		},
		onRows = { rows, _ -> repoScope.launch(Dispatchers.IO) { dispatchInboxRows(rows) } },
		drainRows = { rows, cursor, complete ->
			repoScope.launch(Dispatchers.IO) {
				drain.withDrainMutex {
					dispatchInboxRows(rows)
					complete()
				}
			}
		},
		onPlane = { name, version, payload ->
			repoScope.launch(Dispatchers.IO) { drain.applyPlane(name, version, payload) }
		},
		onGapDetailed = { floor, dropped ->
			gapFloor = floor
			gapDropped = dropped
			_state.update { it.copy(gap = true) }
		},
		kick = { drain.kickPoll() },
		onUnreachable = { client().transport.unreachable(client().transport.proxyBase) },
		visible = { isVisible },
		reconnect = { delay -> repoScope.launch {
			kotlinx.coroutines.delay(delay)
			if (isVisible && transportCoordinator.link() != ConsoleLink.SOCKET) runCatching { socket.connect() }
		} },
				onWelcome = { gen, welcome ->
					repoScope.launch(Dispatchers.IO) { drain.applyWelcomePlanes(welcome.versions) }
					val epoch = welcome.migrationEpoch ?: 0L
				if (epoch != 0L) repoScope.launch {
					if (transportCoordinator.awaitingTranslation()) {
						cursorTranslation.onWelcome(gen, epoch, welcome.cursor, welcome.cursorEpoch)
					}
					selfMigration.run(epoch)
				}
			},
			onConsumerWelcome = { _, _ ->
				repoScope.launch {
					client().consumerRegister(transportCoordinator.incarnation())
					reportConsumerCapabilities()
				}
			},
	)

	val boardRouter = BoardRouterWriter(
		board = board,
		signAndPost = { op, opId -> client().postOwnerOp(ownerOps.sign(op, opId) ?: error("cannot sign board op")) ?: error("owner op post failed") },
		decode = { wireJson.decodeFromJsonElement(BoardWriteResult.serializer(), it) },
	)

	val vaultRouter = com.atelier_nyaarium.switchboard.vault.VaultRouterWriter { op, opId ->
		client().postOwnerOp(ownerOps.sign(op, opId)) ?: error("owner op post failed")
	}

	internal val repoScope = CoroutineScope(
		SupervisorJob() + Dispatchers.IO +
			CoroutineExceptionHandler { _, e ->
				DebugLog.log("Repo", "uncaught in repo scope: ${e.javaClass.simpleName}: ${e.message}")
				_state.update { it.copy(error = "Something went wrong: ${e.javaClass.simpleName}") }
			},
	)

	fun command(block: suspend ChatRepository.() -> Unit) {
		repoScope.launch { block() }
	}

	init {
		repoScope.launch {
			identity.bootState.collect { boot ->
				val domainId = (boot as? BootState.Ready)?.boot?.domainId
				if (_state.value.domainId != domainId) _state.update { it.copy(domainId = domainId) }
			}
		}
	}


	internal fun applyDomainSync(snapshot: com.atelier_nyaarium.switchboard.proto.DomainSnapshot, version: String) =
		provisioningHost.applyDomainSync(snapshot, version)

	internal fun refreshAdmittedGateways() = provisioningHost.refreshAdmittedGateways()
	internal val ownerFacts = OwnerFacts(this)
	internal val gatewayEnroll = GatewayEnrollment(this)
	internal val connector = ConnectCoordinator(identity, ::transport, _state, ChatRepositoryConnectHost(this))
	init {
		wireMigration()
	}
	internal val ports = ChatRepositoryPorts(this)
	internal val drainGate = DrainGate()
	internal val drainHost: DrainHost = ChatRepositoryDrainHost(this)
	internal val presenceHost: PresenceHost = ChatRepositoryPresenceHost(this)
	internal val presence = PresenceOps(presenceHost)
	internal val sessions = SessionOps(ChatRepositorySessionHost(this), ports, mutationJournal)
	internal val renameOps = RenameOps(ChatRepositoryRenameHost(this))
	// Staged invite secrets remain memory-only.
	internal val enrollInvites = java.util.concurrent.ConcurrentHashMap<String, EnrollInvite>()
	internal val approvalNonces = mutableMapOf<String, String>()
	@Volatile internal var sttsClient: SttsClient? = null

	internal val clearedOnReprovision: List<ClearsOnReprovision>
		get() = listOf(this, board, vault, presence, trust, drain, playback)

	override suspend fun clearInMemory() {
		invalidateClient()
		sttsClient = null
		ownerOpsBoot = null
		ownerOpsValue = null
		keyDeliveryBoot = null
		keyDeliveryValue = null
		homeGatewayId = ""
		mailboxSync.clearInMemory()
		forgottenUntil.clear()
		reconciled.clear()
		enrollInvites.clear()
		approvalNonces.clear()
	}

	internal val focusHost: RepositoryFocusHost = ChatRepositoryFocusHost(this)
	internal val sandboxSeeder = ChatRepositorySandboxSeeder(this)
	val isVisible: Boolean get() = focusHost.visible
	// Tombstones mask stale team snapshots.
	internal val forgottenUntil = java.util.concurrent.ConcurrentHashMap<String, Long>()
	internal val reconciled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	init {
		sessions.armPendingForgetTombstones()
	}

	internal var currentFocus: FocusIntent
		get() = focusHost.currentFocus
		set(value) { focusHost.currentFocus = value }

	internal val drain = PollDrain(drainHost, ports)

	init {
		// Restore the held roster before the first poll.
		repoScope.launch(Dispatchers.IO) { presence.restoreLastProjection() }
	}

	private val ceremonyCollaborators = ChatRepositoryEnrollCeremonyCollaborators(this)
	private val deviceApprovalCollaborators = ChatRepositoryDeviceApprovalCollaborators(this)
	private val domainAdminCollaborators = ChatRepositoryDomainAdminCollaborators(this)
	private val goalCollaborators = ChatRepositoryGoalCollaborators(this)
	private val scheduledSendCollaborators = ChatRepositoryScheduledSendCollaborators(this)
	private val attachmentCollaborators = ChatRepositoryAttachmentCollaborators(this)
	private val boardCollaborators = ChatRepositoryBoardCollaborators(this)
	private val vaultCollaborators = ChatRepositoryVaultCollaborators(this)
	private val trustCollaborators = ChatRepositoryTrustCollaborators(this)
	private val playbackPort = ChatRepositoryPlaybackPort(this)
	private val playbackCollaborators = ChatRepositoryPlaybackCollaborators(this)
	internal val ceremony = EnrollCeremonyOps(
		store = store,
		identity = ports,
		client = ports,
		collaborators = ceremonyCollaborators,
	)
	internal val devices = DeviceApprovalOps(
		state = _state,
		store = store,
		identity = ports,
		client = ports,
		collaborators = deviceApprovalCollaborators,
	)
	internal val domainAdmin = DomainAdminOps(
		state = _state,
		store = store,
		identity = ports,
		client = ports,
		collaborators = domainAdminCollaborators,
	)
	internal val trust = TrustOps(
		state = _state,
		clientPort = ports,
		identity = ports,
		presence = ports,
		homeGatewayId = { homeGatewayId },
		collaborators = trustCollaborators,
	)
	internal val playback = PlaybackOps(
		state = _state,
		repoScope = repoScope,
		playback = playbackPort,
		collaborators = playbackCollaborators,
	)
	internal val boardOps = BoardOps(
		state = _state,
		repoScope = repoScope,
		filesDir = filesDir,
		homeGatewayId = { homeGatewayId },
		collaborators = boardCollaborators,
	)
	internal val vaultOps = VaultOps(
		state = _state,
		repoScope = repoScope,
		collaborators = vaultCollaborators,
	)
	internal val attachments = AttachmentOps(
		state = _state,
		persistence = persistence,
		client = ports,
		identity = ports,
		filesDir = filesDir,
		scope = { drain.scope },
		collaborators = attachmentCollaborators,
	)
	internal val scheduled = ScheduledSendOps(
		state = _state,
		persistence = persistence,
		filesDir = filesDir,
		repoScope = repoScope,
		mutationJournal = mutationJournal,
		identity = ports,
		pushback = pushback,
		isVisible = { isVisible },
		collaborators = scheduledSendCollaborators,
	)
	internal val goals = GoalOps(
		state = _state,
		persistence = persistence,
		repoScope = repoScope,
		sessions = goalCollaborators,
	)

	var onInbound: ((team: String, messages: List<Message>) -> Unit)? = null

	fun onForeground() = focusHost.onForeground()

	fun onBackground() = focusHost.onBackground()

	fun kickPoll() = focusHost.kickPoll()

	internal fun declareFocus(focus: FocusIntent) = focusHost.declareFocus(focus)

	internal fun client(): ConsoleClient = provisioningHost.client()

	internal fun clientOrNull(): ConsoleClient? = provisioningHost.clientOrNull()

	internal fun invalidateClient() = provisioningHost.invalidateClient()

	@Volatile var enabledPlugins: (() -> List<com.atelier_nyaarium.switchboard.proto.EnabledPlugin>)? = null

	@Volatile internal var pluginReportPending = false

	var saveTreeUri: String
		get() = store.saveTreeUri
		set(value) {
			store.saveTreeUri = value
		}

	internal fun List<Team>.withoutTombstoned(): List<Team> = filterTombstoned(this, forgottenUntil, System.currentTimeMillis())

	fun seedSandbox(
		teams: List<Team>,
		threads: Map<String, List<Message>>,
		dirs: Map<String, List<String>> = emptyMap(),
		drafts: Map<String, Draft> = emptyMap(),
		goals: Map<String, PendingGoal> = emptyMap(),
		admittedGateways: List<String> = emptyList(),
	) = sandboxSeeder.seedSandbox(teams, threads, dirs, drafts, goals, admittedGateways)

	fun setBiometricLock(enabled: Boolean) {
		store.biometricLock = enabled
		_state.update { it.copy(biometricLock = enabled) }
	}

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

	internal fun appendInbound(team: String, msg: Message, beforeCommit: () -> Unit = {}): Boolean {
		if (!msg.isPeer) _state.update { it.copy(wakingTeams = it.wakingTeams - team) }
		if (msg.seq > 0) {
			var folded = false
			val updated = _state.updateAndGet { s ->
				val thread = s.threads[team].orEmpty()
				val idx = thread.indexOfFirst { it.seq == msg.seq && it.epoch == msg.epoch }
				if (idx >= 0) {
					folded = true
					val old = thread[idx]
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

	internal fun reconcileSent(team: String, echo: Message) {
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
				attachments.scheduleAttachmentDelete(deleteSrcs)
		} else {
			append(team, echo)
		}
	}

	internal companion object {
		const val CHIME_SILENT = "silent"

		const val POLL_INTERVAL_MS = 5_000L
		const val LONG_POLL_HOLD_MS = 40_000L
		const val PARK_SLACK_MS = 5_000L
		const val BACKGROUND_TICK_MS = 30_000L
		const val FORGET_TOMBSTONE_MS = ConsoleHttp.DEFAULT_OWNER_OP_TIMEOUT_MS + 5_000L
		internal const val FORGET_RETRY_MS = 30_000L
		const val MAX_OUTGOING_BYTES = Protocol.MAX_BLOB_BYTES

		internal const val MAX_ATTACHMENT_FETCH_TRIES = 5

		internal const val STALE_BLOB_MAX_AGE_MS = 24 * 60 * 60 * 1000L

		internal const val BOARD_FETCH_GIVE_UP = 3

		internal const val BOARD_FETCH_DEAD_AFTER = 3

		internal const val SCHEDULED_SEND_RETRY_DELAY_MS = 5 * 60_000L

		internal const val SCHEDULER_WIRE_WAIT_MS = 5_000L

		internal const val SCHEDULED_SEND_MAX_HORIZON_MS = 30L * 24 * 60 * 60_000L

		internal const val SPAWN_RETRY_WINDOW_MS = 40_000L

		const val INSTANT_EMPTY_THRESHOLD_MS = 3_000L

		init {
			require(INSTANT_EMPTY_THRESHOLD_MS < LONG_POLL_HOLD_MS / 4) {
				"INSTANT_EMPTY_THRESHOLD_MS must stay well below LONG_POLL_HOLD_MS"
			}
		}
	}
}
