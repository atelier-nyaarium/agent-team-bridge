package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsolePollResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceKnownVersion
import com.atelier_nyaarium.switchboard.proto.LinkedPeersVersion
import com.atelier_nyaarium.switchboard.proto.PresenceVersion
import com.atelier_nyaarium.switchboard.proto.ReadAnchorsVersion
import com.atelier_nyaarium.switchboard.proto.SessionKey
import com.atelier_nyaarium.switchboard.proto.SyncPollResult
import com.atelier_nyaarium.switchboard.proto.parseStoreKey
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

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

	// Interrupts the currently held poll.
	@Volatile private var pollInterrupt: CompletableDeferred<Unit>? = null

	// Last applied presence versions.
	@Volatile private var knownPresenceVersions: List<PresenceVersion> = emptyList()

	// Last applied linked-peers version.
	@Volatile private var knownLinkedPeersVersion: LinkedPeersVersion? = null

	// Last applied read-anchor version.
	@Volatile private var knownReadAnchorsVersion: ReadAnchorsVersion? = null

	// Per-domain versions. Upsert, never replace.
	@Volatile private var knownCrossDomainPresenceVersions: List<CrossDomainPresenceKnownVersion> = emptyList()

	/** Serialize per-domain version updates. */
	private val crossDomainVersionsMutex = Mutex()
	private val drainMutex = Mutex()

	/** One drain at a time, whichever transport carried the payload. */
	internal suspend fun <T> withDrainMutex(block: suspend () -> T): T = drainMutex.withLock { block() }

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

	/** Interrupt the held poll. */
	fun interrupt() {
		pollInterrupt?.complete(Unit)
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
		knownPresenceVersions = emptyList()
		knownLinkedPeersVersion = null
		knownReadAnchorsVersion = null
		crossDomainVersionsMutex.withLock { knownCrossDomainPresenceVersions = emptyList() }
	}

	/** Prune removed Domain cursors. */
	suspend fun pruneCrossDomainVersions(ownedDomainIds: Set<String>) {
		crossDomainVersionsMutex.withLock {
			knownCrossDomainPresenceVersions = knownCrossDomainPresenceVersions.filter { it.domainId in ownedDomainIds }
		}
	}

	/** Upsert changed Domain cursors. */
	suspend fun upsertCrossDomainVersions(entries: List<CrossDomainPresenceEntry>) {
		crossDomainVersionsMutex.withLock {
			knownCrossDomainPresenceVersions = upsertKnownCrossDomainPresenceVersions(knownCrossDomainPresenceVersions, entries)
		}
	}

	/** Race the held poll against interruption. */
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

	fun start(scope: CoroutineScope) {
		if (pollJob?.isActive == true) return
		pollScope = scope
		pollJob = scope.launch(Dispatchers.IO) {
				// Restore cached roster first.
			runCatching { repo.presence.restoreLastProjection() }
			var lastDiscoveryAt = 0L
			pollLoop@ while (isActive) {
				var failed = false
				var heldEmpty = false
				var hold = 0L
				try {
					// Pull discovery while backgrounded.
					val now = System.currentTimeMillis()
					if (repo.transportCoordinator.plan(repo.isVisible, repo.transportCoordinator.link() == ConsoleLink.SOCKET, false).pullDiscovery && now - lastDiscoveryAt >= ChatRepository.DISCOVERY_REFRESH_MS) {
						lastDiscoveryAt = now
						repo.presence.refreshDiscovery()
						repo.presence.refreshConnectedGateways()
					}
					if (repo.pluginReportPending) repo.reportEnabledPlugins()
					// Visible long-poll; backgrounded plain poll.
					hold = if (repo.isVisible) ChatRepository.LONG_POLL_HOLD_MS else 0L
					val started = System.currentTimeMillis()
					val params = repo.mailboxSync.pollParams()
					val focus = repo.currentFocus
					val presented = knownPresenceVersions
					val presentedLinkedPeers = knownLinkedPeersVersion
					val presentedReadAnchors = knownReadAnchorsVersion
					val presentedCrossDomainPresence = knownCrossDomainPresenceVersions
					val presentedTaskBoard = repo.boardOps.knownBoardVersion
					DebugLog.log("Poll", "firing cursor=${params.cursor} epoch=${params.epoch} hold=${hold}ms focus=${focus.screen}")
					val mb = if (hold > 0) {
						pollRacingFocusChange {
							repo.client().poll(
								params.cursor, params.epoch, hold, presented, focus,
								presentedLinkedPeers, presentedReadAnchors, presentedCrossDomainPresence,
								presentedTaskBoard,
							)
						}
					} else {
						repo.client().poll(
							params.cursor, params.epoch, hold, presented, focus,
							presentedLinkedPeers, presentedReadAnchors, presentedCrossDomainPresence,
							presentedTaskBoard,
						)
					}
					if (mb == null) {
						DebugLog.log("Plane", "poll interrupted by a focus/refresh change - reissuing immediately")
						continue@pollLoop
					}
					// Apply changed keyring snapshot.
					mb.domain?.let { repo.applyDomainSync(it, mb.domainVersion ?: "") }
					// Apply changed presence snapshot.
					if (mb.presence != null || mb.presenceVersions != null) {
						if (mb.presenceVersions != null) knownPresenceVersions = mb.presenceVersions
						mb.presence?.let { rows ->
							val bumpAt = System.currentTimeMillis()
							DebugLog.log("Plane", "presence settled=${mb.settled} rows=${rows.size} serverAt=${started} clientAt=${bumpAt}")
							repo.presence.applyPlanePresence(rows.map { teamInfoToTeam(it, repo.localGatewayId) }, started)
						}
					}
					// Apply changed linked peers.
					if (mb.linkedPeers != null || mb.linkedPeersVersion != null) {
						if (mb.linkedPeersVersion != null) knownLinkedPeersVersion = mb.linkedPeersVersion
						mb.linkedPeers?.let { peers ->
							DebugLog.log("Plane", "linkedPeers settled=${mb.settled} rows=${peers.size}")
							repo.presence.applyLinkedPeers(peers)
						}
					}
					// Apply changed Domains by upsert.
					mb.crossDomainPresence?.let { entries ->
						DebugLog.log("Plane", "crossDomainPresence settled=${mb.settled} rows=${entries.size}")
						repo.presence.applyCrossDomainPresence(entries)
					}
					// Apply read anchors after mailbox entries.
					if (mb.readAnchorsVersion != null) knownReadAnchorsVersion = mb.readAnchorsVersion
					val pendingReadAnchors = mb.readAnchors
					launch { runCatching { repo.boardOps.refreshBoard() } }
					launch { runCatching { repo.boardOps.drainBoard() } }
					repo.boardOps.resumeBoardUploads()
					launch { runCatching { repo.scheduled.replayJournaledSends() } }
					repo.goals.tick()
					// Reapply cached teams for tombstone expiry.
					repo.presence.reapplyCachedTeams()
					// Floor legacy empty-poll cadence.
					heldEmpty = hold > 0 && mb.entries.isEmpty() &&
						System.currentTimeMillis() - started < ChatRepository.INSTANT_EMPTY_THRESHOLD_MS
					// Commit cursor after rendering and persistence.
					val adv = repo.mailboxSync.advance(
						SyncPollResult(mb.entries.map { Drained(it) }, mb.cursor, mb.epoch, mb.dropped),
					)
					if (mb.entries.isEmpty()) {
						DebugLog.log("Poll", "empty (held=$heldEmpty epoch=${mb.epoch} cursor=${mb.cursor} dropped=${mb.dropped})")
					} else {
						DebugLog.log("Poll", "${adv.fresh.size}/${mb.entries.size} fresh epoch=${mb.epoch} cursor=${mb.cursor} dropped=${mb.dropped}")
					}
					repo._state.update { it.copy(gap = adv.gap) }
					// Fresh entries reset idle pushback.
					if (adv.fresh.isNotEmpty()) repo.pushback.onCommsActivity(System.currentTimeMillis(), repo.isVisible)
					val burst = mutableMapOf<String, MutableList<Message>>()
					val deviceAddr = repo.thisDeviceAddress()
					for (d in adv.fresh) {
						val e = d.entry
						// Resolve the canonical thread key.
						val team: String? = if (e.kind == "notice") {
							// Prefer the origin-qualified sender.
							(parseStoreKey(e.session_id) as? SessionKey.Notice)?.sender?.canonical
								?: e.from?.let { repo.fromCanonical(it) }
						} else {
							when (val sk = parseStoreKey(e.session_id)) {
								is SessionKey.Conv ->
									if (deviceAddr != null && sk.address == deviceAddr) {
										// Own-session pushes use the sender thread.
										e.from?.let { repo.fromCanonical(it) } ?: sk.address.canonical
									} else {
										sk.address.canonical
									}
								else -> e.from?.let { repo.fromCanonical(it) }
							}
						}
						if (team == null) {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} from=${e.from} -> DROPPED (unresolvable team)")
							continue
						}
						val files = Attachments.decode(e.files)
						// Keep status-only entries.
						val bodyText = e.body.orEmpty()
						val snippet = bodyText.replace(Regex("\\s+"), " ").trim().take(80)
						if (e.kind == "sent") {
							DebugLog.log("Drain", "seq=${e.seq} kind=sent session=${e.session_id} -> thread=$team (own mirror) opId=${e.opId} \"$snippet\"")
							val echo = Message(true, bodyText, e.at, files = files, status = null, opId = e.opId, epoch = mb.epoch, seq = e.seq)
							repo.reconcileSent(team, echo)
							continue
						}
						if (e.kind == "plugin_action") {
							// Plugin actions are not chat messages.
							val pluginId = e.pluginId
							val actionType = e.actionType
							if (pluginId != null && actionType != null) {
								DebugLog.log("Drain", "seq=${e.seq} kind=plugin_action session=${e.session_id} -> thread=$team $pluginId:$actionType")
								pluginActionSubscribers.forEach { sub ->
									runCatching { sub.onAction(team, pluginId, actionType, e.payload) }
										.onFailure { DebugLog.log("Drain", "plugin action subscriber threw: $it") }
								}
							} else {
								DebugLog.log("Drain", "seq=${e.seq} kind=plugin_action -> DROPPED (missing plugin id or action type)")
							}
							continue
						}
						if (bodyText.isNotEmpty() || files.isNotEmpty() || e.status != null) {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} -> thread=$team status=${e.status} files=${files.size} \"$snippet\"")
							val attribution = resolveMessageAttribution(e.kind, e.from, e.to, team, repo::fromCanonical)
							val msg = Message(
								false, bodyText, e.at, files = files, status = e.status,
								title = e.title.tierOrNull(), summary = e.summary.tierOrNull(), fullSpoken = e.fullSpoken.tierOrNull(),
								epoch = mb.epoch, seq = e.seq, from = attribution.from, to = attribution.to, isPeer = attribution.isPeer,
								arrivedVisible = repo.isVisible && !resumeBacklogPending,
							)
							// Subscribers run synchronously before commit.
							if (
								repo.appendInbound(team, msg) {
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
					// Apply anchors after mailbox entries.
					pendingReadAnchors?.let { entries ->
						DebugLog.log("Plane", "readAnchors settled=${mb.settled} rows=${entries.size}")
						repo.presence.applyReadAnchors(entries)
					}
					// Report local read advances.
					repo.presence.reportLocalReadAdvances()
					val burstJobs = mutableListOf<Job>()
					val autoPlayedPeerPairs = mutableSetOf<String>()
					for ((team, msgs) in burst) {
						val lastAgent = msgs.lastOrNull { !it.fromMe }
						// Preload followed threads only.
						val followed = team in repo._state.value.openTabs
						val scope = pollScope
						// Pre-generation and auto-play are independent.
						val autoTier = repo.playback.autoPlayTier(repo.sttsAutoPlay)
						val eligible =
							scope != null && lastAgent != null && repo.sttsReady() && followed && (repo.sttsAutoGen || autoTier != null)
						// Queue messages by their owning thread.
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
							// Warm the first message.
							val warm = agentMsgs.firstOrNull()?.let { (m, owner) -> owner to m.at } ?: (t to at)
							burstJobs += scope.launch(Dispatchers.IO) {
								if (repo.sttsAutoGen) repo.playback.preloadMessage(warm.first, warm.second)
								repo.onInbound?.invoke(t, ms)
								// Queue the full burst for hands-free playback.
								if (autoTier != null) {
									for ((msg, owner) in queueable) {
										repo.playback.enqueueForPlay(owner, msg.at, autoTier, announceRun = true)
									}
								}
							}
						} else {
							repo.onInbound?.invoke(team, msgs)
						}
					}
					repo.mailboxSync.commit(adv.next)
					// Join burst work before idle pushback.
					withTimeoutOrNull(BURST_JOIN_TIMEOUT_MS) { burstJobs.joinAll() }
					// Clear the resume backlog after this pass.
					resumeBacklogPending = false
					repo.attachments.fetchPendingAttachments()
					pollFails = 0
					if (repo._state.value.error != null || repo._state.value.pollFailStreak != 0) {
						repo._state.update { it.copy(error = null, pollFailStreak = 0, connected = true, enrollingSince = 0L) }
					}
					DebugLog.flushToIngest()
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
