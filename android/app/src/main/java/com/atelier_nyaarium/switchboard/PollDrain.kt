package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.SessionKey
import com.atelier_nyaarium.switchboard.proto.SyncPollResult
import com.atelier_nyaarium.switchboard.proto.parseStoreKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonPrimitive

internal data class TickOutcome(
	val rowsDrained: Int,
	val planesApplied: Int,
	val inboxAdvanceSent: Boolean,
	val known: Map<String, Long>,
	val cursorStale: Boolean = false,
)

internal suspend fun drainTick(
	client: ConsoleClient,
	coordinator: ConsoleTransportCoordinator,
	known: Map<String, Long>,
	onRows: suspend (List<com.atelier_nyaarium.switchboard.proto.InboxRow>) -> Unit,
	onPlane: suspend (String, Long, kotlinx.serialization.json.JsonElement?) -> Boolean,
): TickOutcome {
	var rowsDrained = 0
	var inboxAdvanceSent = false
	if (!coordinator.mayPoll()) {
		// #region debug: poll skipped
		DebugLog.log("Poll", "tick skipped link=${coordinator.link()} translating=${coordinator.awaitingTranslation()}")
		// #endregion
		return TickOutcome(0, 0, false, known)
	}
	coordinator.pendingAdvance()?.let { pending ->
		val advance = client.inboxAdvance(pending.cursor, pending.cursorEpoch)
		inboxAdvanceSent = true
		when (advanceOutcome(advance)) {
			"ok" -> coordinator.clearPendingAdvance()
			"cursor_stale" -> {
				coordinator.clearPendingAdvance()
				coordinator.adoptFloor(advanceFloor(advance, coordinator.cursor()))
				return TickOutcome(0, 0, true, known, true)
			}
		}
	}
	val answer = client.inboxRead(coordinator.cursor() + 1, coordinator.cursorEpoch())
	// #region debug: inbox read
	DebugLog.log(
		"Poll",
		"inbox_read from=${coordinator.cursor() + 1} epoch=${coordinator.cursorEpoch()} -> " +
			if (answer is JsonArray) "rows=${answer.size}" else answer?.toString()?.take(160) ?: "null",
	)
	// #endregion
	if (answer is JsonArray) {
		val rows = answer.mapNotNull { element ->
			val decoded = runCatching {
				wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.InboxRow.serializer(), element)
			}.getOrNull()
			if (decoded != null) return@mapNotNull decoded
			val objectValue = element as? JsonObject
			val primitive = fun(name: String): String? = runCatching {
				objectValue?.get(name)?.jsonPrimitive?.content
			}.getOrNull()
			val seq = primitive("seq")?.toLongOrNull()
			DebugLog.log("Poll", "inbox row decode failed seq=${seq ?: "unknown"}")
			val envelope = objectValue?.get("envelope")?.let { value ->
				runCatching {
					wireJson.decodeFromJsonElement(com.atelier_nyaarium.switchboard.proto.RowEnvelope.serializer(), value)
				}.getOrNull()
			}
			if (objectValue == null || envelope == null) return@mapNotNull null
			com.atelier_nyaarium.switchboard.proto.InboxRow(
				envelope = envelope,
				producerSig = primitive("producerSig") ?: "",
				body = objectValue["body"] ?: JsonNull,
				seq = seq ?: 0L,
				acceptedAt = primitive("acceptedAt")?.toLongOrNull() ?: 0L,
				size = primitive("size")?.toLongOrNull() ?: 0L,
			)
		}
		if (rows.isNotEmpty()) {
			onRows(rows)
			rowsDrained = rows.size
			val cursor = rows.maxOf { it.seq }
			val epoch = coordinator.cursorEpoch()
			if (coordinator.polled(cursor, epoch)) {
				val advance = client.inboxAdvance(cursor, epoch)
				inboxAdvanceSent = true
				// #region debug: inbox advance
				DebugLog.log("Poll", "inbox_advance cursor=$cursor epoch=$epoch -> ${advanceOutcome(advance) ?: advance?.toString()?.take(120)}")
				// #endregion
				when (advanceOutcome(advance)) {
					"ok" -> coordinator.clearPendingAdvance()
					"cursor_stale" -> {
						coordinator.clearPendingAdvance()
						coordinator.adoptFloor(advanceFloor(advance, coordinator.cursor()))
						return TickOutcome(rowsDrained, 0, true, known, true)
					}
					else -> coordinator.recordPendingAdvance(cursor, epoch)
				}
			}
		}
	} else if (answer is JsonObject && answer["outcome"]?.jsonPrimitive?.content == "cursor_stale") {
		coordinator.adoptFloor(answer["floor"]?.jsonPrimitive?.content?.toLongOrNull() ?: coordinator.cursor())
		return TickOutcome(0, 0, false, known, true)
	}
	var nextKnown = known
	var planesApplied = 0
	val knownJson = buildJsonObject { nextKnown.forEach { (name, version) -> put(name, version) } }
	val planes = client.planesRead(knownJson)?.planes
	// #region debug: planes read
	DebugLog.log("Poll", "planes_read known=${nextKnown} -> ${planes?.joinToString(",") { "${it.name}:${it.version}:${it.payload != null}" } ?: "none"}")
	// #endregion
	planes?.forEach { plane ->
		if (plane.version > (nextKnown[plane.name] ?: 0L) && onPlane(plane.name, plane.version, plane.payload)) {
			nextKnown = nextKnown + (plane.name to plane.version)
			planesApplied++
		}
	}
	return TickOutcome(rowsDrained, planesApplied, inboxAdvanceSent, nextKnown)
}

private fun advanceOutcome(answer: kotlinx.serialization.json.JsonElement?): String? =
	(answer as? JsonObject)?.get("outcome")?.jsonPrimitive?.content

private fun advanceFloor(answer: kotlinx.serialization.json.JsonElement?, fallback: Long): Long =
	(answer as? JsonObject)?.get("floor")?.jsonPrimitive?.content?.toLongOrNull() ?: fallback

/** Four plane cursors and drain-gate subscribers. */
internal class PollDrain(private val repo: ChatRepository) : ClearsOnReprovision {
	private var pollFails = 0
	private var pollJob: Job? = null
	// Scope for loop-bound work.
	private var pollScope: CoroutineScope? = null

	/** Loop-bound work scope. */
	val scope: CoroutineScope? get() = pollScope

	// Tags backlog drained after resume.
	@Volatile private var resumeBacklogPending = false

	private val kick = Channel<Unit>(Channel.CONFLATED)

	@Volatile private var knownPlaneVersions: Map<String, Long> = emptyMap()

	private val drainMutex = Mutex()

	/** Marks the coroutine holding the drain mutex. */
	private object DrainHolder : CoroutineContext.Element {
		override val key: CoroutineContext.Key<*> get() = Key

		object Key : CoroutineContext.Key<DrainHolder>
	}

	/** One drain at a time, whichever transport carried the payload; the holder may re-enter. */
	internal suspend fun <T> withDrainMutex(block: suspend () -> T): T =
		if (coroutineContext[DrainHolder.Key] != null) block()
		else drainMutex.withLock { withContext(DrainHolder) { block() } }

	/** Synchronous, pre-commit delivery. */
	private val inboundSubscribers = java.util.concurrent.CopyOnWriteArrayList<InboundSubscriber>()

	/** Register once per process. */
	fun addInboundSubscriber(subscriber: InboundSubscriber) {
		inboundSubscribers.addIfAbsent(subscriber)
	}

	/** Plugin actions are at-least-once. */
	private val pluginActionSubscribers = java.util.concurrent.CopyOnWriteArrayList<PluginActionSubscriber>()

	/** Register once per process. */
	fun addPluginActionSubscriber(subscriber: PluginActionSubscriber) {
		pluginActionSubscribers.addIfAbsent(subscriber)
	}

	/** Wake the poll loop. */
	fun kickPoll() {
		kick.trySend(Unit)
	}

	/** Cancel and join the loop. */
	suspend fun stopAndJoin() {
		pollJob?.cancelAndJoin()
	}

	/** Mark the resume backlog. */
	fun onForegroundResume() {
		resumeBacklogPending = true
		pollFails = 0
	}

	/** Clear in-memory cursors. */
	override suspend fun clearInMemory() = resetPlaneCursors()

	/** Reset cursors for cold boot. */
	suspend fun resetPlaneCursors() {
		knownPlaneVersions = emptyMap()
	}

	internal fun notePlane(name: String, version: Long) {
		knownPlaneVersions = knownPlaneVersions + (name to maxOf(version, knownPlaneVersions[name] ?: 0L))
	}

	/** Planes newer than these are fetched on welcome. */
	internal fun knownPlanesJson(): JsonObject =
		buildJsonObject { knownPlaneVersions.forEach { (name, version) -> put(name, version) } }

	internal fun mayApplyPlane(name: String, version: Long): Boolean = version > (knownPlaneVersions[name] ?: 0L)

	internal suspend fun processEntries(entries: List<MailboxEntry>, cursor: Long, epoch: Long, dropped: Long) {
		val advanced = repo.mailboxSync.advance(SyncPollResult(entries.map { Drained(it) }, cursor, epoch, dropped))
		repo._state.update { it.copy(gap = advanced.gap) }
		if (advanced.fresh.isNotEmpty()) repo.pushback.onCommsActivity(System.currentTimeMillis(), repo.isVisible)
		val burst = mutableMapOf<String, MutableList<Message>>()
		val deviceAddr = repo.thisDeviceAddress()
		for (drained in advanced.fresh) {
			val entry = drained.entry
			val team = if (entry.kind == "notice") {
				(parseStoreKey(entry.session_id) as? SessionKey.Notice)?.sender?.canonical ?: entry.from?.let(repo::fromCanonical)
			} else {
				when (val key = parseStoreKey(entry.session_id)) {
					is SessionKey.Conv -> if (deviceAddr != null && key.address == deviceAddr) {
						entry.from?.let(repo::fromCanonical) ?: key.address.canonical
					} else key.address.canonical
					else -> entry.from?.let(repo::fromCanonical)
				}
			}
			if (team == null) continue
			val files = Attachments.decode(entry.files)
			val body = entry.body.orEmpty()
			if (entry.kind == "sent") {
				repo.reconcileSent(team, Message(true, body, entry.at, files = files, opId = entry.opId, epoch = epoch, seq = entry.seq))
				continue
			}
			if (entry.kind == "plugin_action") {
				if (entry.pluginId != null && entry.actionType != null) {
					pluginActionSubscribers.forEach { subscriber ->
						runCatching { subscriber.onAction(team, entry.pluginId, entry.actionType, entry.payload) }
							.onFailure { DebugLog.log("Drain", "plugin action failed seq=${entry.seq}") }
					}
				}
				continue
			}
			if (body.isEmpty() && files.isEmpty() && entry.status == null) continue
			val attribution = resolveMessageAttribution(entry.kind, entry.from, entry.to, team, repo::fromCanonical)
			val message = Message(
				false, body, entry.at, files = files, status = entry.status,
				title = entry.title.tierOrNull(), summary = entry.summary.tierOrNull(), fullSpoken = entry.fullSpoken.tierOrNull(),
				epoch = epoch, seq = entry.seq, from = attribution.from, to = attribution.to, isPeer = attribution.isPeer,
				arrivedVisible = repo.isVisible && !resumeBacklogPending,
			)
			if (repo.appendInbound(team, message) {
				inboundSubscribers.forEach { subscriber ->
					runCatching { subscriber.onMessage(team, message) }
						.onFailure { DebugLog.log("Drain", "inbound subscriber failed seq=${entry.seq}") }
				}
			}) burst.getOrPut(team) { mutableListOf() }.add(message)
		}
		val burstJobs = mutableListOf<Job>()
		val autoPlayedPeerPairs = mutableSetOf<String>()
		for ((team, messages) in burst) {
			val lastAgent = messages.lastOrNull { !it.fromMe }
			val scope = pollScope
			val autoTier = repo.playback.autoPlayTier(repo.sttsAutoPlay)
			val followed = team in repo._state.value.openTabs
			val eligible = scope != null && lastAgent != null && repo.sttsReady() && followed &&
				(repo.sttsAutoGen || autoTier != null)
			val queueable = if (!eligible) emptyList() else messages.filter { !it.fromMe }
				.filterNot { isDuplicatePeerAutoPlay(it, autoPlayedPeerPairs) }
			if (eligible && queueable.isNotEmpty()) {
				val warm = queueable.first()
				burstJobs += scope!!.launch(Dispatchers.IO) {
					if (repo.sttsAutoGen) repo.playback.preloadMessage(team, warm.at)
					repo.onInbound?.invoke(team, messages)
					if (autoTier != null) queueable.forEach { repo.playback.enqueueForPlay(team, it.at, autoTier, announceRun = true) }
				}
			} else {
				repo.onInbound?.invoke(team, messages)
			}
		}
		repo.mailboxSync.commit(advanced.next)
		withTimeoutOrNull(BURST_JOIN_TIMEOUT_MS) { burstJobs.joinAll() }
		repo.attachments.fetchPendingAttachments()
	}

	private suspend fun drainOwnerInbox() {
		withDrainMutex {
			val outcome = drainTick(
				repo.client(),
				repo.transportCoordinator,
				knownPlaneVersions,
				onRows = { repo.dispatchInboxRows(it) },
				onPlane = { name, _, payload -> repo.applyPlane(name, payload) },
			)
			knownPlaneVersions = outcome.known
			if (outcome.cursorStale) repo._state.update { it.copy(gap = true) }
		}
	}

	fun start(scope: CoroutineScope) {
		if (pollJob?.isActive == true) return
		pollScope = scope
		pollJob = scope.launch(Dispatchers.IO) {
				// Restore cached roster first.
				runCatching { repo.presence.restoreLastProjection() }
			pollLoop@ while (isActive) {
				var failed = false
				var heldEmpty = false
				var hold = 0L
				try {
					if (repo.isVisible) {
						withTimeoutOrNull(ChatRepository.POLL_INTERVAL_MS) { kick.receive() }
						continue@pollLoop
					}
					if (!repo.isVisible && repo.transportCoordinator.link() == ConsoleLink.POLL) {
						drainOwnerInbox()
						withTimeoutOrNull(ChatRepository.BACKGROUND_TICK_MS) { kick.receive() }
						continue@pollLoop
					}
					} catch (e: Exception) {
					// Rethrow cancellation before classification.
					e.rethrowIfCancellation()
					if (hold > 0 && e.message?.startsWith("HTTP 504") == true) {
						// Treat held 504 as empty.
						DebugLog.log("Poll", "hold timeout (504) treated as empty long-poll")
						heldEmpty = true
					} else {
						// Classify connection failures.
						val (cause, kind) = classifyConnError(e)
						DebugLog.log("Poll", "error streak=${pollFails + 1} [$kind]: ${e.message?.take(120)}")
						failed = true
						pollFails++
						repo._state.update { s ->
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
				val watchedWorking = repo._state.value.let { s -> s.openTabs.any { tab -> s.working(tab) } }
				val plan = repo.transportCoordinator.plan(
					repo.isVisible,
					repo.transportCoordinator.link() == ConsoleLink.SOCKET,
					failed,
				)
				when (val wait = plan.wait) {
					PollWait.Chain -> if (failed || heldEmpty) withTimeoutOrNull(ChatRepository.POLL_INTERVAL_MS) { kick.receive() }
					is PollWait.Delay -> withTimeoutOrNull(wait.ms) { kick.receive() }
					// Alarm timeout is a backstop.
					is PollWait.Alarm ->
						withTimeoutOrNull((wait.atMillis - System.currentTimeMillis() + ChatRepository.PARK_SLACK_MS).coerceAtLeast(0)) { kick.receive() }
				}
			}
		}
	}
}
