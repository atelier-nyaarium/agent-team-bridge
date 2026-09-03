package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter
import com.atelier_nyaarium.switchboard.board.BoardSealing
import com.atelier_nyaarium.switchboard.crypto.openSealedBlobRange
import com.atelier_nyaarium.switchboard.crypto.opResultAadKind
import com.atelier_nyaarium.switchboard.crypto.scheduledBodyAadKind
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import com.atelier_nyaarium.switchboard.crypto.ownerKeyId
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.BoardWriteResult
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
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

/** Mailbox entry with cursor sequence. */

internal data class Drained(val entry: MailboxEntry) : SyncEntry {
	override val seq: Long get() = entry.seq
}

/** In-memory provisioning state. */
internal interface ClearsOnReprovision {
	/** Clear in-memory state. */
	suspend fun clearInMemory()
}

/** Chat state over a ConsoleClient. */
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
	/** TTS playback engine. */
	val stts = SttsPlayer(filesDir)

	/** Task board state. */
	val board = com.atelier_nyaarium.switchboard.board.BoardManager(store)

	@Volatile internal var homeGatewayId: String = store.loadGatewayId()
	@Volatile internal var gapFloor: Long = 0L
	@Volatile internal var gapDropped: Long = 0L
	internal var onScheduledResult: (com.atelier_nyaarium.switchboard.proto.ScheduledResultRow) -> Unit = {}
	internal var onBoardObservation: (com.atelier_nyaarium.switchboard.proto.BoardObservationRow) -> Unit = {}

	/** JSON persistence codec. */
	internal val persistence = ChatPersistence(store)
	internal val mutationJournal = MutationJournal(filesDir)

	// Migrate before loading persisted threads.
	init {
		if (store.migrateSchemaIfNeeded()) {
			// Purge file-backed migration caches.
			stts.purgeAll()
			Attachments.purgeAll(filesDir)
		}
	}

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

	// Address helpers.

	/** Local Domain id for address parsing. */
	internal fun localDomain(): String = confirmedDomainId() ?: ""

	/** Canonicalize a target address. */
	internal fun canonicalTarget(team: String): String =
		runCatching { parseTarget(team, localDomain(), homeGatewayId).canonical }.getOrDefault(team)

	/** Resolve a sender address. */
	internal fun fromCanonical(from: String): String? =
		runCatching { parseTarget(from, localDomain(), homeGatewayId).canonical }.getOrNull()

	/** This device's session address. */
	internal fun thisDeviceAddress(): Address? =
		runCatching {
			Address.local(localDomain(), homeGatewayId, ownerKeyId(federation.ownerSignPub()), Protocol.DEFAULT_SESSION)
		}.getOrNull()

	@Volatile internal var client: ConsoleClient? = null
	internal val mailboxSync = MailboxSync(store)
	val pushback = IdlePushbackManager(store, System.currentTimeMillis()) { ZoneId.systemDefault() }

	internal val transportCoordinator = ConsoleTransportCoordinator(pushback)
	internal lateinit var cursorTranslation: CursorTranslationOps
	internal lateinit var selfMigration: SelfMigration

	/** Signs this console's operations. */
	val ownerOps = OwnerOps(this)

	internal val keyDelivery = KeyDeliveryOps(
		domainId = { ownerOps.domainId() },
		keyring = { federation.keyring() },
		contentKeyring = { federation.contentKeyring() },
		consoleIdentity = { federation.consoleIdentity() },
		signOwnerOp = { ownerOps.sign(it) },
		sendOwnerOp = { client().postOwnerOp(it) },
	)

	/** Board sealing context. */
	fun boardSealing(): BoardSealing? {
		val domain = ownerOps.domainId() ?: return null
		return BoardSealing(federation.contentKeyring(), domain, federation.ownerSignPub()) { epoch ->
			repoScope.launch(Dispatchers.IO) { keyDelivery.requestMissing(epoch) }
		}
	}

	init {
		board.sealing = { boardSealing() }
	}

	/** Foreground Router push channel. */
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
			repoScope.launch(Dispatchers.IO) {
				drain.withDrainMutex {
					if (drain.mayApplyPlane(name, version) && applyPlane(name, payload)) drain.notePlane(name, version)
				}
			}
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
					// The welcome carries versions only; fetch the payloads.
					repoScope.launch(Dispatchers.IO) {
						drain.withDrainMutex {
							client().planesRead(drain.knownPlanesJson())?.planes?.forEach { plane ->
								if (drain.mayApplyPlane(plane.name, plane.version) && applyPlane(plane.name, plane.payload)) {
									drain.notePlane(plane.name, plane.version)
								}
							}
						}
					}
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

	private suspend fun reportConsumerCapabilities() {
		val plugins = enabledPlugins?.invoke() ?: return
		val op = buildJsonObject {
			put("kind", "capabilities_report")
			put("capabilities", wireJson.encodeToJsonElement(kotlinx.serialization.builtins.ListSerializer(com.atelier_nyaarium.switchboard.proto.EnabledPlugin.serializer()), plugins))
		}
		val signed = ownerOps.sign(op) ?: return
		client().postOwnerOp(signed)
	}

	internal suspend fun applyPlane(name: String, payload: kotlinx.serialization.json.JsonElement?): Boolean {
		// Board pushes carry revisions only.
		if (name == "taskBoard") {
			boardOps.refreshBoard()
			return true
		}
		if (name != "presence" || payload == null) return false
		val projection = runCatching {
			wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection.serializer(), payload)
		}.getOrNull() ?: return false
		presence.applyOwnerProjection(projection)
		return true
	}

	private suspend fun dispatchKeyRows(rows: List<com.atelier_nyaarium.switchboard.proto.InboxRow>) {
		for (row in rows) {
			when (row.envelope.kind) {
				"key_request" -> runCatching {
					keyDelivery.onKeyRequest(wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.KeyRequest.serializer(), row.body))
				}.onFailure { DebugLog.log("KeyDelivery", "row parse failed kind=key_request") }
				"key_grant" -> runCatching {
					keyDelivery.onKeyGrant(wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.KeyGrant.serializer(), row.body))
				}.onFailure { DebugLog.log("KeyDelivery", "row parse failed kind=key_grant") }
			}
		}
	}

	private fun unavailableEntry(row: com.atelier_nyaarium.switchboard.proto.InboxRow): MailboxEntry =
		MailboxEntry(
			seq = row.seq,
			at = row.acceptedAt,
			kind = row.envelope.kind,
			session_id = row.envelope.opKey.conversationId,
			body = "Unavailable on this device",
			status = "error",
			title = "Unavailable",
		)

	internal suspend fun dispatchInboxRows(rows: List<com.atelier_nyaarium.switchboard.proto.InboxRow>) {
		val entries = mutableListOf<MailboxEntry>()
		for (row in rows) {
			val epochText = (row.envelope.epoch as? JsonPrimitive)?.content
			if (epochText == "clear" && row.envelope.kind in setOf("scheduled_result", "board_observation")) {
				when (row.envelope.kind) {
					"scheduled_result" -> runCatching {
						wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.ScheduledResultRow.serializer(), row.body)
					}.onSuccess(onScheduledResult).onFailure {
						DebugLog.log("Inbox", "scheduled result parse failed seq=${row.seq}")
						entries += unavailableEntry(row)
					}
					"board_observation" -> runCatching {
						wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.BoardObservationRow.serializer(), row.body)
					}.onSuccess(onBoardObservation).onFailure {
						DebugLog.log("Inbox", "board observation parse failed seq=${row.seq}")
						entries += unavailableEntry(row)
					}
				}
				continue
			}
			if (row.envelope.kind == "op_result") {
				val result = runCatching {
					val body = wireJson.decodeFromJsonElement(
						com.atelier_nyaarium.switchboard.proto.ContentEnvelope.serializer(),
						row.body,
					)
					val epoch = body.epoch.toInt()
					val key = federation.contentKeyring().keyFor(epoch) ?: return@runCatching null
					val plain = com.atelier_nyaarium.switchboard.crypto.Crypto.openContent(
						body,
						key,
						com.atelier_nyaarium.switchboard.crypto.Crypto.ContentAad(
							localDomain(),
							federation.ownerSignPub(),
							epoch,
							opResultAadKind(row.envelope.opKey.conversationId, row.envelope.opKey.opId),
						),
					)
					wireJson.parseToJsonElement(plain.toString(Charsets.UTF_8))
					}.onFailure { DebugLog.log("Inbox", "op_result open failed opId=${row.envelope.opKey.opId}") }.getOrNull()
					transportCoordinator.completeOpResult(row.envelope.opKey.opId, result)
					continue
				}
				if (row.envelope.kind == "key_request" || row.envelope.kind == "key_grant") {
					dispatchKeyRows(listOf(row))
					continue
				}
				val entry = runCatching {
					val envelope = wireJson.decodeFromJsonElement(ContentEnvelope.serializer(), row.body)
					val epoch = envelope.epoch.toInt()
					val key = federation.contentKeyring().keyFor(epoch) ?: run {
						keyDelivery.requestMissing(epoch)
						return@runCatching unavailableEntry(row)
					}
					val plain = com.atelier_nyaarium.switchboard.crypto.Crypto.openContent(
						envelope,
						key,
						com.atelier_nyaarium.switchboard.crypto.Crypto.ContentAad(
							localDomain(),
							federation.ownerSignPub(),
							epoch,
							scheduledBodyAadKind(
								row.envelope.opKey.conversationId,
								row.envelope.opKey.opId,
							),
						),
					)
					wireJson.decodeFromString(MailboxEntry.serializer(), plain.toString(Charsets.UTF_8)).copy(seq = row.seq, kind = row.envelope.kind)
				}.onFailure {
					DebugLog.log("Inbox", "row open failed seq=${row.seq}")
					(row.envelope.epoch as? JsonPrimitive)?.content?.toIntOrNull()?.let { keyDelivery.requestMissing(it) }
					entries += unavailableEntry(row)
				}.getOrNull()
				entry?.let { entries += it }
		}
		val last = rows.maxByOrNull { it.seq } ?: return
		drain.processEntries(entries, last.seq, transportCoordinator.cursorEpoch(), 0L)
	}

	/** Read one opened Router blob chunk. */
	internal suspend fun routerBlobRange(
		domainId: String,
		blobId: String,
		offset: Long,
		originGateway: String? = null,
	): Pair<ByteArray, Boolean>? {
		val op = buildJsonObject {
			put("kind", JsonPrimitive("blob_fetch"))
			put("opId", JsonPrimitive(java.util.UUID.randomUUID().toString()))
			put("blobId", JsonPrimitive(blobId))
			put(
				"range",
				buildJsonObject {
					put("offset", JsonPrimitive(offset))
					put("length", JsonPrimitive(Protocol.BLOB_CHUNK_BYTES))
				},
			)
			// Permit forwarding on cache miss.
			if (originGateway != null) {
				put(
					"origin",
					buildJsonObject {
						put("domainId", JsonPrimitive(domainId))
						put("gatewayId", JsonPrimitive(originGateway))
					},
				)
			}
		}
		val signed = ownerOps.sign(op) ?: return null
		val answer = runCatching { client().postOwnerOp(signed)?.jsonObject }.getOrNull() ?: return null
		if (answer["outcome"]?.jsonPrimitive?.content != "fetched") return null
		val bytes = answer["bytes"]?.jsonPrimitive?.content
			?.let { android.util.Base64.decode(it, android.util.Base64.DEFAULT) } ?: return null
		val eof = answer["eof"]?.jsonPrimitive?.content == "true"
		if (answer["sealed"]?.jsonPrimitive?.content != "true") return bytes to eof
		val epoch = answer["epoch"]?.jsonPrimitive?.content?.toIntOrNull() ?: return null
		val size = answer["size"]?.jsonPrimitive?.content?.toLongOrNull() ?: return null
		val at = answer["offset"]?.jsonPrimitive?.content?.toLongOrNull() ?: return null
		val key = federation.contentKeyring().keyFor(epoch) ?: return null
		return runCatching {
			openSealedBlobRange(
				bytes,
				at,
				size,
				epoch,
				offset,
				Protocol.BLOB_CHUNK_BYTES.toLong(),
				key,
				domainId,
				federation.ownerSignPub(),
				blobId,
			)
		}.getOrNull()
	}

	/** Board Router writer. */
	val boardRouter = BoardRouterWriter(
		board = board,
		signAndPost = { op, opId -> client().postOwnerOp(ownerOps.sign(op, opId) ?: error("cannot sign board op")) ?: error("owner op post failed") },
		decode = { wireJson.decodeFromJsonElement(BoardWriteResult.serializer(), it) },
	)

	// Process-lifetime repository scope.
	internal val repoScope = CoroutineScope(
		SupervisorJob() + Dispatchers.IO +
			CoroutineExceptionHandler { _, e ->
				DebugLog.log("Repo", "uncaught in repo scope: ${e.javaClass.simpleName}: ${e.message}")
				// Surface background failures in state.
				_state.update { it.copy(error = "Something went wrong: ${e.javaClass.simpleName}") }
			},
	)

	/** Run repository work on its scope. */
	fun command(block: suspend ChatRepository.() -> Unit) {
		repoScope.launch { block() }
	}

	// Domain trust anchor.
	internal val federation = FederationManager(store)

	/** Apply the keyring snapshot. */
	internal fun applyDomainSync(snapshot: com.atelier_nyaarium.switchboard.proto.DomainSnapshot, version: String) {
		federation.applyDomainSync(snapshot, version)
		refreshAdmittedGateways()
	}

	/** Refresh admitted Gateways. */
	internal fun refreshAdmittedGateways() {
		val ids = sessions.keyringGateways()
		val nextHome = homeGatewayId.takeIf { it in ids } ?: ids.firstOrNull().orEmpty()
		if (nextHome != homeGatewayId) {
			homeGatewayId = nextHome
			store.saveGatewayId(nextHome)
		}
		if (ids != _state.value.admittedGateways || nextHome != _state.value.homeGatewayId)
			_state.update { it.copy(admittedGateways = ids, homeGatewayId = nextHome) }
		// Remove revoked Gateway columns.
		board.retainGateways(ids)
	}
	internal val ownerFacts = OwnerFacts(this)
	internal val gatewayEnroll = GatewayEnrollment(this)
	internal val ceremony = EnrollCeremonyOps(this)
	internal val devices = DeviceApprovalOps(this)
	internal val domainAdmin = DomainAdminOps(this)
	internal val trust = TrustOps(this)
	internal val playback = PlaybackOps(this)
	internal val boardOps = BoardOps(this)
	internal val attachments = AttachmentOps(this)
	internal val scheduled = ScheduledSendOps(this)
	init {
		cursorTranslation = CursorTranslationOps(
			coordinator = transportCoordinator,
			journal = mutationJournal,
			address = { "owner:${localDomain()}/${federation.ownerSignPub()}" },
			heldCursor = { mailboxSync.pollParams().epoch to mailboxSync.pollParams().cursor },
			sign = { op, opId -> ownerOps.sign(op, opId) },
			send = { client().postOwnerOp(it) },
			reportError = { message -> _state.update { it.copy(error = message) } },
			commit = { gen, cursor, epoch -> socket.commitTranslation(gen, cursor, epoch) },
			)
		selfMigration = SelfMigration(
			records = { _state.value.scheduledSends },
			readAnchors = { _state.value.readAnchors },
			journal = mutationJournal,
			domainId = { localDomain() },
			ownerSignPub = { federation.ownerSignPub() },
			conversationId = { client().transport.prov.conversationId },
			contentKeyring = { federation.contentKeyring() },
			target = { team, _ ->
				val parsed = parseTarget(team, localDomain(), homeGatewayId) as com.atelier_nyaarium.switchboard.proto.Address
				com.atelier_nyaarium.switchboard.proto.ScheduledTarget(parsed.domain, parsed.gateway, parsed.spawn + "." + parsed.session)
			},
			uploadFile = { file -> client().uploadBlob(Attachments.fileFor(filesDir, file.src) ?: error("missing scheduled file")) },
			sign = { op, opId -> ownerOps.sign(op, opId) },
			send = { client().postOwnerOp(it) },
				reportRead = { team, anchor ->
				val op = com.atelier_nyaarium.switchboard.proto.ReportRead(
					team = team, epoch = anchor.epoch, seq = anchor.seq, at = System.currentTimeMillis(),
				)
				val signed = ownerOps.sign(wireJson.encodeToJsonElement(com.atelier_nyaarium.switchboard.proto.ReportRead.serializer(), op).jsonObject)
					if (signed == null) null else client().postOwnerOp(signed)
				},
				reportError = { message -> _state.update { it.copy(error = message) } },
				releaseLocal = { team, opId ->
				scheduled.releaseMigrated(
					team,
					opId,
					{ scheduled.scheduledSendScheduler?.cancelNext() },
					{ target ->
						_state.update { it.copy(scheduledSends = it.scheduledSends - target) }
						persistence.persistScheduledSends(_state.value.scheduledSends)
						scheduled.rearmAfterMigration()
					},
				)
			},
		)
	}
	internal val presenceHost: PresenceHost = ChatRepositoryPresenceHost(this)
	internal val presence = PresenceOps(presenceHost)
	internal val sessions = SessionOps(this)
	// Keep staged invite secrets in memory only.
	internal val enrollInvites = java.util.concurrent.ConcurrentHashMap<String, EnrollInvite>()
	@Volatile internal var sttsClient: SttsClient? = null

	// Re-provision wipe.
	/** State holders cleared by [clearAll]. */
	internal val clearedOnReprovision: List<ClearsOnReprovision>
		get() = listOf(this, board, presence, trust, drain, playback)

	/** Clear this class's state. */
	override suspend fun clearInMemory() {
		client = null
		sttsClient = null
		homeGatewayId = ""
		mailboxSync.clearInMemory()
		forgottenUntil.clear()
		reconciled.clear()
		enrollInvites.clear()
	}

	@Volatile private var visible = false
	val isVisible: Boolean get() = visible
	// Tombstones mask stale team snapshots.
	internal val forgottenUntil = java.util.concurrent.ConcurrentHashMap<String, Long>()
	// Rows reconciled once per process.
	internal val reconciled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	// Current poll focus.
	@Volatile internal var currentFocus: FocusIntent = FocusIntent(screen = "background")

	// Last visible focus.
	@Volatile private var lastVisibleFocus: FocusIntent = FocusIntent(screen = "board")

	/** Poll loop and mailbox drain. */
	internal val drain = PollDrain(this)

	/** Armed session goals. */
	internal val goals = GoalOps(this)

	/** Inbound message callback. */
	var onInbound: ((team: String, messages: List<Message>) -> Unit)? = null

	/** Enter foreground polling. */
	fun onForeground() {
		visible = true
		drain.onForegroundResume()
		_state.update { it.copy(error = null, pollFailStreak = 0, enrollingSince = 0L, foreground = true) }
		declareFocus(lastVisibleFocus)
		drain.kickPoll()
		// Polling remains the fallback.
		if (ownerOps.domainId() != null) runCatching { socket.connect() }
	}

	fun onBackground() {
		visible = false
		socket.onBackground()
		pushback.onBackground(System.currentTimeMillis())
		declareFocus(FocusIntent(screen = "background"))
		_state.update { it.copy(foreground = false) }
	}

	fun kickPoll() {
		drain.kickPoll()
	}

	/** Declare current UI focus. */
	internal fun declareFocus(focus: FocusIntent) {
		val prior = currentFocus
		currentFocus = focus
		if (focus.screen != "background") lastVisibleFocus = focus
		if (prior != focus) drain.kickPoll()
	}

	internal fun client(): ConsoleClient {
		client?.let { return it }
		val blob = store.load() ?: error("not provisioned")
		return ConsoleClient(
			Provisioning.parse(blob),
			store,
			coordinator = transportCoordinator,
			signOwnerOp = { op, opId -> ownerOps.sign(op, opId) },
				domainId = { confirmedDomainId() },
				ownerSignPub = { federation.ownerSignPub() },
			homeGatewayId = { homeGatewayId },
				contentKeyring = { federation.contentKeyring() },
		).also { client = it }
	}

	/** Capabilities reported at register. */
	@Volatile var enabledPlugins: (() -> List<com.atelier_nyaarium.switchboard.proto.EnabledPlugin>)? = null

	// Retry reports missing from the Gateway.
	@Volatile internal var pluginReportPending = false

	/** User-selected SAF tree. */
	var saveTreeUri: String
		get() = store.saveTreeUri
		set(value) {
			store.saveTreeUri = value
		}

	internal fun List<Team>.withoutTombstoned(): List<Team> = filterTombstoned(this, forgottenUntil, System.currentTimeMillis())

	/** Sandbox provisioning blob. */
	private val SANDBOX_PROVISIONING =
		"""{"transport":"direct","routerUrl":"https://router.sandbox.invalid:20001",""" +
			""""routerCertFp":"${"11".repeat(32)}","appToken":"sandbox","conversationId":"sandbox"}"""

	/** Seed emulator state only. */
	fun seedSandbox(
		teams: List<Team>,
		threads: Map<String, List<Message>>,
		dirs: Map<String, List<String>> = emptyMap(),
		drafts: Map<String, Draft> = emptyMap(),
		goals: Map<String, PendingGoal> = emptyMap(),
		admittedGateways: List<String> = emptyList(),
	) {
		if (BuildConfig.BUILD_TYPE != "emulator") return
		teams.firstOrNull()?.name?.split(".")?.getOrNull(1)?.let { homeGatewayId = it }
		if (store.load() == null) store.save(SANDBOX_PROVISIONING)
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
				drafts = drafts,
				goals = goals,
				admittedGateways = admittedGateways,
				homeGatewayId = homeGatewayId,
			)
		}
	}

	fun setBiometricLock(enabled: Boolean) {
		store.biometricLock = enabled
		_state.update { it.copy(biometricLock = enabled) }
	}

	/** Append inbound messages. */
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

	/** Prepare indexes before state commit. */
	internal fun appendInbound(team: String, msg: Message, beforeCommit: () -> Unit = {}): Boolean {
		if (!msg.isPeer) _state.update { it.copy(wakingTeams = it.wakingTeams - team) }
		if (msg.seq > 0) {
			// Deduplicate by mailbox epoch and sequence.
			var folded = false
			val updated = _state.updateAndGet { s ->
				val thread = s.threads[team].orEmpty()
				val idx = thread.indexOfFirst { it.seq == msg.seq && it.epoch == msg.epoch }
				if (idx >= 0) {
					folded = true
					val old = thread[idx]
						val merged = msg.copy(id = old.id, files = Attachments.mergeSentEchoFiles(old.files, msg.files).files)
						// Preserve landed attachment paths.
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

	/** Fold a sent echo. */
	internal fun reconcileSent(team: String, echo: Message) {
		var handled = false
		var deleteSrcs: List<String> = emptyList()
			val threads = _state.updateAndGet { s ->
				// Reset captured values on every CAS attempt.
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
				// Delete orphaned attachment copies.
				attachments.scheduleAttachmentDelete(deleteSrcs)
		} else {
			append(team, echo)
		}
	}

	internal companion object {
		/** Silent mode, distinct from default sound. */
		const val CHIME_SILENT = "silent"

		const val POLL_INTERVAL_MS = 5_000L
		// Server-held poll cadence.
		const val LONG_POLL_HOLD_MS = 40_000L
		// Alarm backstop slack.
		const val PARK_SLACK_MS = 5_000L
		const val BACKGROUND_TICK_MS = 30_000L
		// Outlast one teams request.
		const val FORGET_TOMBSTONE_MS = ConsoleHttp.DEFAULT_OWNER_OP_TIMEOUT_MS + 5_000L
		// Total attachment cap from wire protocol.
		const val MAX_OUTGOING_BYTES = Protocol.MAX_BLOB_BYTES

		// Stop repeated attachment requests.
		internal const val MAX_ATTACHMENT_FETCH_TRIES = 5

		// Retain transfer residue through active uploads.
		internal const val STALE_BLOB_MAX_AGE_MS = 24 * 60 * 60 * 1000L

		/** Board attachment retry limit. */
		internal const val BOARD_FETCH_GIVE_UP = 3

		/** Confirmed-absent threshold. */
		internal const val BOARD_FETCH_DEAD_AFTER = 3

		// Scheduled-send retry delay.
		internal const val SCHEDULED_SEND_RETRY_DELAY_MS = 5 * 60_000L

		// Scheduler wiring wait.
		internal const val SCHEDULER_WIRE_WAIT_MS = 5_000L

		// Bound scheduled-send horizon.
		internal const val SCHEDULED_SEND_MAX_HORIZON_MS = 30L * 24 * 60 * 60_000L

		// Cover cold session creation.
		internal const val SPAWN_RETRY_WINDOW_MS = 40_000L

		// Detect instant empty polls.
		const val INSTANT_EMPTY_THRESHOLD_MS = 3_000L

		init {
			require(INSTANT_EMPTY_THRESHOLD_MS < LONG_POLL_HOLD_MS / 4) {
				"INSTANT_EMPTY_THRESHOLD_MS must stay well below LONG_POLL_HOLD_MS"
			}
		}
	}
}
