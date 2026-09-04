package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter
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
	internal val federation = FederationManager(store)
	internal val identity = PhoneIdentity(store, federation)
	internal val ambient = PhoneAmbient.system()
	internal val bootState: StateFlow<BootState> get() = identity.bootState
	private var ownerOpsBoot: PhoneBootstrap? = null
	private var ownerOpsValue: OwnerOps? = null
	private var keyDeliveryBoot: PhoneBootstrap? = null
	private var keyDeliveryValue: KeyDeliveryOps? = null
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

	// Address helpers.

	/** Local Domain id for address parsing. */
	internal fun localDomain(): String = provisioningHost.localDomain()

	internal fun transport(): ConsoleRouterTransport = provisioningHost.transport()

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

	internal val provisioningHost: RepositoryProvisioningHost = ChatRepositoryProvisioningHost(this)
	internal val attachmentHost: AttachmentHost = ChatRepositoryAttachmentHost(this)
	internal var client: ConsoleClient?
		get() = provisioningHost.client
		set(value) { provisioningHost.client = value }
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

	/** Board sealing context. */
	internal fun boardSealing() = provisioningHost.boardSealing()

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
					// The welcome carries versions only; fetch the payloads.
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

	private suspend fun reportConsumerCapabilities() {
		val plugins = enabledPlugins?.invoke() ?: return
		val op = buildJsonObject {
			put("kind", "capabilities_report")
			put("clientVersion", "${BuildConfig.VERSION_NAME}+${BuildConfig.BUILD_SHA}")
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
				Protocol.Wire.KeyOpKind.KEY_REQUEST -> runCatching {
					keyDelivery.onKeyRequest(wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.KeyRequest.serializer(), row.body))
				}.onFailure { DebugLog.log("KeyDelivery", "row parse failed kind=${Protocol.Wire.KeyOpKind.KEY_REQUEST}") }
				Protocol.Wire.KeyOpKind.KEY_GRANT -> runCatching {
					keyDelivery.onKeyGrant(wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.KeyGrant.serializer(), row.body))
				}.onFailure { DebugLog.log("KeyDelivery", "row parse failed kind=${Protocol.Wire.KeyOpKind.KEY_GRANT}") }
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
			if (row.envelope.kind == Protocol.Wire.OWNER_OP_OP_RESULT) {
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
					val completed = transportCoordinator.completeOpResult(row.envelope.opKey.opId, result)
					// An unopened result, an absent waiter, or a refusal each strand the caller.
					val failure = (result as? kotlinx.serialization.json.JsonObject)?.takeIf { it["ok"]?.toString() == "false" }
					if (result == null || !completed || failure != null) {
						DebugLog.log(
							"Inbox",
							"op_result opId=${row.envelope.opKey.opId} opened=${result != null} waiter=$completed error=${failure?.get("error")?.toString()?.take(120)}",
						)
					}
					continue
				}
				if (row.envelope.kind == Protocol.Wire.KeyOpKind.KEY_REQUEST || row.envelope.kind == Protocol.Wire.KeyOpKind.KEY_GRANT) {
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
				put("kind", JsonPrimitive(Protocol.Wire.OWNER_OP_BLOB_FETCH))
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

	init {
		repoScope.launch {
			identity.bootState.collect { boot ->
				val domainId = (boot as? BootState.Ready)?.boot?.domainId
				if (_state.value.domainId != domainId) _state.update { it.copy(domainId = domainId) }
			}
		}
	}

	// Domain trust anchor.

	/** Apply the keyring snapshot. */
	internal fun applyDomainSync(snapshot: com.atelier_nyaarium.switchboard.proto.DomainSnapshot, version: String) =
		provisioningHost.applyDomainSync(snapshot, version)

	/** Refresh admitted Gateways. */
	internal fun refreshAdmittedGateways() = provisioningHost.refreshAdmittedGateways()
	internal val ownerFacts = OwnerFacts(this)
	internal val gatewayEnroll = GatewayEnrollment(this)
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
			ambient = ambient,
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
				val signed = ownerOps.sign(composeReportRead(team, anchor, System.currentTimeMillis()))
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
	internal val drainGate = DrainGate()
	internal val drainHost: DrainHost = ChatRepositoryDrainHost(this)
	internal val presenceHost: PresenceHost = ChatRepositoryPresenceHost(this)
	internal val presence = PresenceOps(presenceHost)
	internal val sessions = SessionOps(ChatRepositorySessionHost(this))
	internal val renameOps = RenameOps(ChatRepositoryRenameHost(this))
	// Keep staged invite secrets in memory only.
	internal val enrollInvites = java.util.concurrent.ConcurrentHashMap<String, EnrollInvite>()
	internal val approvalNonces = mutableMapOf<String, String>()
	@Volatile internal var sttsClient: SttsClient? = null

	// Re-provision wipe.
	/** State holders cleared by [clearAll]. */
	internal val clearedOnReprovision: List<ClearsOnReprovision>
		get() = listOf(this, board, presence, trust, drain, playback)

	/** Clear this class's state. */
	override suspend fun clearInMemory() {
		client = null
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
	// Rows reconciled once per process.
	internal val reconciled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	internal var currentFocus: FocusIntent
		get() = focusHost.currentFocus
		set(value) { focusHost.currentFocus = value }

	/** Poll loop and mailbox drain. */
	internal val drain = PollDrain(drainHost)

	// The held roster, before the first poll or welcome. Without it a restart shows nothing until the
	// Router's presence version moves, and an unchanged version is skipped as stale.
	init {
		repoScope.launch(Dispatchers.IO) { presence.restoreLastProjection() }
	}

	/** Armed session goals. */
	internal val ports = ChatRepositoryPorts(this)
	private val ceremonyCollaborators = ChatRepositoryEnrollCeremonyCollaborators(this)
	private val deviceApprovalCollaborators = ChatRepositoryDeviceApprovalCollaborators(this)
	private val domainAdminCollaborators = ChatRepositoryDomainAdminCollaborators(this)
	private val goalCollaborators = ChatRepositoryGoalCollaborators(this)
	private val scheduledSendCollaborators = ChatRepositoryScheduledSendCollaborators(this)
	private val attachmentCollaborators = ChatRepositoryAttachmentCollaborators(this)
	private val boardCollaborators = ChatRepositoryBoardCollaborators(this)
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

	/** Inbound message callback. */
	var onInbound: ((team: String, messages: List<Message>) -> Unit)? = null

	/** Enter foreground polling. */
	fun onForeground() = focusHost.onForeground()

	fun onBackground() = focusHost.onBackground()

	fun kickPoll() = focusHost.kickPoll()

	/** Declare current UI focus. */
	internal fun declareFocus(focus: FocusIntent) = focusHost.declareFocus(focus)

	internal fun client(): ConsoleClient = provisioningHost.client()

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

	/** Seed emulator state only. */
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
