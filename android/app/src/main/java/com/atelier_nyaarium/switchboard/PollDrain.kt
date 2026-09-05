package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.Protocol
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
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
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
	if (!coordinator.mayPoll()) return TickOutcome(0, 0, false, known)
	coordinator.pendingAdvance()?.let { pending ->
		val advance = client.inboxAdvance(pending.cursor, pending.cursorEpoch)
		inboxAdvanceSent = true
		when (advanceOutcome(advance)) {
			"ok" -> coordinator.clearPendingAdvance()
			Protocol.Wire.CONSOLE_REASON_CURSOR_STALE -> {
				coordinator.clearPendingAdvance()
				coordinator.adoptFloor(advanceFloor(advance, coordinator.cursor()))
				return TickOutcome(0, 0, true, known, true)
			}
		}
	}
	val answer = client.inboxRead(coordinator.cursor() + 1, coordinator.cursorEpoch())
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
				when (advanceOutcome(advance)) {
					"ok" -> coordinator.clearPendingAdvance()
					Protocol.Wire.CONSOLE_REASON_CURSOR_STALE -> {
						coordinator.clearPendingAdvance()
						coordinator.adoptFloor(advanceFloor(advance, coordinator.cursor()))
						return TickOutcome(rowsDrained, 0, true, known, true)
					}
					// The Router keeps the older cursor and redelivers until a retry lands.
					else -> {
						DebugLog.log("Poll", "inbox_advance held cursor=$cursor: ${advanceOutcome(advance) ?: "no answer"}")
						coordinator.recordPendingAdvance(cursor, epoch)
					}
				}
			}
		}
	} else if (answer is JsonObject && answer["outcome"]?.jsonPrimitive?.content == Protocol.Wire.CONSOLE_REASON_CURSOR_STALE) {
		coordinator.adoptFloor(answer["floor"]?.jsonPrimitive?.content?.toLongOrNull() ?: coordinator.cursor())
		return TickOutcome(0, 0, false, known, true)
	}
	var nextKnown = known
	var planesApplied = 0
	val knownJson = buildJsonObject { nextKnown.forEach { (name, version) -> put(name, version) } }
	client.planesRead(knownJson)?.planes?.forEach { plane ->
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
internal class PollDrain(private val host: DrainHost, private val presence: PresencePort) : ClearsOnReprovision {
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

	internal suspend fun <T> withDrainMutex(block: suspend () -> T): T = host.drainGate.withDrainMutex(block)

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

	/** Welcome carries versions only. */
	internal suspend fun applyWelcomePlanes(welcome: JsonObject) {
		withDrainMutex {
			val newer = welcome.any { (name, value) -> mayApplyPlane(name, value.jsonPrimitive.content.toLongOrNull() ?: 0L) }
			if (!newer) return@withDrainMutex
			host.readPlanes(knownPlanesJson())?.forEach { plane ->
				if (!mayApplyPlane(plane.name, plane.version)) return@forEach
				if (host.applyPlane(plane.name, plane.version, plane.payload)) notePlane(plane.name, plane.version)
			}
		}
	}

	internal suspend fun applyPlane(name: String, version: Long, payload: JsonElement?) {
		withDrainMutex {
			if (mayApplyPlane(name, version) && host.applyPlane(name, version, payload)) notePlane(name, version)
		}
	}

	internal suspend fun processEntries(entries: List<MailboxEntry>, cursor: Long, epoch: Long, dropped: Long) {
		val advanced = host.advanceMailbox(SyncPollResult(entries.map { Drained(it) }, cursor, epoch, dropped))
		host.setGap(advanced.gap)
		if (advanced.fresh.isNotEmpty()) host.markCommsActivity(System.currentTimeMillis())
		val burst = mutableMapOf<String, MutableList<Message>>()
		val deviceAddr = host.thisDeviceAddress()
		for (drained in advanced.fresh) {
			val entry = drained.entry
			val team = if (entry.kind == "notice") {
				(parseStoreKey(entry.session_id) as? SessionKey.Notice)?.sender?.canonical ?: entry.from?.let(host::fromCanonical)
			} else {
				when (val key = parseStoreKey(entry.session_id)) {
					is SessionKey.Conv -> if (deviceAddr != null && key.address == deviceAddr) {
						entry.from?.let(host::fromCanonical) ?: key.address.canonical
					} else key.address.canonical
					else -> entry.from?.let(host::fromCanonical)
				}
			}
			if (team == null) continue
			val files = host.decodeAttachments(entry.files)
			val body = entry.body.orEmpty()
			if (entry.kind == "sent") {
				val echo = Message(true, body, entry.at, files = files, opId = entry.opId, epoch = epoch, seq = entry.seq)
				host.reconcileSent(team, echo)
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
			val attribution = resolveMessageAttribution(entry.kind, entry.from, entry.to, team, host::fromCanonical)
			val message = Message(
				false, body, entry.at, files = files, status = entry.status,
				title = entry.title.tierOrNull(), summary = entry.summary.tierOrNull(), fullSpoken = entry.fullSpoken.tierOrNull(),
				epoch = epoch, seq = entry.seq, from = attribution.from, to = attribution.to, isPeer = attribution.isPeer,
				arrivedVisible = host.isVisible && !resumeBacklogPending,
			)
			if (host.appendInbound(team, message) {
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
			val autoTier = host.autoPlayTier()
			val followed = team in host.state.value.openTabs
			val eligible = scope != null && lastAgent != null && host.isSttsReady() && followed &&
				(host.autoGenerate || autoTier != null)
			val queueable = if (!eligible) emptyList() else messages.filter { !it.fromMe }
				.filterNot { isDuplicatePeerAutoPlay(it, autoPlayedPeerPairs) }
			if (eligible && queueable.isNotEmpty()) {
				val warm = queueable.first()
				burstJobs += scope!!.launch(Dispatchers.IO) {
					if (host.autoGenerate) host.preloadMessage(team, warm.at)
					host.onInbound(team, messages)
					if (autoTier != null) queueable.forEach { host.enqueueForPlay(team, it.at, autoTier) }
				}
			} else {
				host.onInbound(team, messages)
			}
		}
		host.commitMailbox(advanced.next)
		withTimeoutOrNull(BURST_JOIN_TIMEOUT_MS) { burstJobs.joinAll() }
		host.fetchPendingAttachments()
	}

	private suspend fun drainOwnerInbox() {
		withDrainMutex {
			val outcome = host.poll(knownPlaneVersions)
			knownPlaneVersions = outcome.known
			if (outcome.cursorStale) host.setGap(true)
		}
	}

	fun start(scope: CoroutineScope) {
		if (pollJob?.isActive == true) return
		pollScope = scope
		pollJob = scope.launch(Dispatchers.IO) {
				// Restore cached roster first.
				runCatching { presence.restoreLastProjection() }
			pollLoop@ while (isActive) {
				var failed = false
				var heldEmpty = false
				var hold = 0L
				try {
					if (host.isVisible) {
						withTimeoutOrNull(ChatRepository.POLL_INTERVAL_MS) { kick.receive() }
						continue@pollLoop
					}
					if (!host.isVisible && host.link() == ConsoleLink.POLL) {
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
						host.state.update { s ->
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
				val plan = host.plan(
					host.isVisible,
					host.link() == ConsoleLink.SOCKET,
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
