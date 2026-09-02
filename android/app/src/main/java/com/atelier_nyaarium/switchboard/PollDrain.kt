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

/**
 * The poll loop and mailbox drain (`repo.drain`): owns the loop lifecycle, the four plane version
 * cursors this device presents back to the Gateway, and both drain-gate subscriber lists.
 *
 * The load-bearing invariant lives HERE by construction: inbound subscribers fire inside the drain,
 * before mailboxSync.commit, so they inherit the mailbox cursor's exactly-once and crash-safety.
 * Plane appliers, notification fan-out targets and every other effect stay on the repository; this
 * delegate reaches back into it the way the federation Ops delegates do.
 */
internal class PollDrain(private val repo: ChatRepository) : ClearsOnReprovision {
	private var pollFails = 0
	private var pollJob: Job? = null
	// The poll loop's scope, reused to launch auto-TTS preloads that gate the
	// notification (so the audio is cached before the user is pinged).
	private var pollScope: CoroutineScope? = null

	/** Best-effort launch surface for work that may ride the loop's scope (attachment cleanup). */
	val scope: CoroutineScope? get() = pollScope

	// Set alongside `visible = true`: onForeground front-runs the resume-kicked drain, so every
	// message still sitting in the mailbox at resume would otherwise tag arrivedVisible=true (the
	// user never actually saw it). Cleared once the first poll pass since the transition commits,
	// so only the genuinely-backgrounded backlog is tagged not-visible; a live message the NEXT
	// pass drains while still foregrounded tags normally.
	@Volatile private var resumeBacklogPending = false

	private val kick = Channel<Unit>(Channel.CONFLATED)

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

	/** Serializes every read-modify-write of knownCrossDomainPresenceVersions: applyLinkedPeers and
	 * applyCrossDomainPresence both merge against its OWN prior value (a filter/upsert, not a plain
	 * replace like the sibling knownPresenceVersions/knownLinkedPeersVersion fields), and refreshTeams()
	 * resets it from a DIFFERENT coroutine (a manual pull-to-refresh, not the poll loop) - both run on
	 * Dispatchers.IO's multi-threaded pool, so an unguarded compound operation could lose the reset
	 * underneath a poll response still applying stale pre-reset data. */
	private val crossDomainVersionsMutex = Mutex()
	private val drainMutex = Mutex()

	/** One drain at a time, whichever transport carried the payload. */
	internal suspend fun <T> withDrainMutex(block: suspend () -> T): T = drainMutex.withLock { block() }

	/** Data-plane subscribers, invoked once per genuinely-new inbound message at the drain gate.
	 * Delivery is synchronous and pre-commit, so a subscriber inherits the mailbox cursor's
	 * exactly-once + crash-safety; it must be fast, non-blocking, and idempotent. */
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

	/** Wakes the poll loop immediately, whatever wait tier it is parked in. */
	fun kickPoll() {
		kick.trySend(Unit)
	}

	/** Interrupt the currently-held poll (if any) so the next one fires with fresh focus/versions. */
	fun interrupt() {
		pollInterrupt?.complete(Unit)
	}

	/** Cancel the loop and WAIT for its current pass's non-suspend tail to finish (see clearAll's
	 * own doc for why the join, not a bare cancel, is load-bearing there). */
	suspend fun stopAndJoin() {
		pollJob?.cancelAndJoin()
	}

	/** The Activity came on screen: the first pass since this transition tags its backlog as
	 * arrived-unseen, and the failure streak restarts clean (see onForeground). */
	fun onForegroundResume() {
		resumeBacklogPending = true
		pollFails = 0
	}

	/** A cursor claims what this device already holds, so one carried across a re-provision makes
	 * the new Gateway ship nothing for that plane. */
	override suspend fun clearInMemory() = resetPlaneCursors()

	/** Forget every presented plane version so the NEXT poll looks like a cold boot and the
	 * Gateway ships current truth for every plane (see refreshTeams). */
	suspend fun resetPlaneCursors() {
		knownPresenceVersions = emptyList()
		knownLinkedPeersVersion = null
		knownReadAnchorsVersion = null
		crossDomainVersionsMutex.withLock { knownCrossDomainPresenceVersions = emptyList() }
	}

	/** Drop cursors for Domains no longer in the linked roster (applyLinkedPeers' prune half). */
	suspend fun pruneCrossDomainVersions(ownedDomainIds: Set<String>) {
		crossDomainVersionsMutex.withLock {
			knownCrossDomainPresenceVersions = knownCrossDomainPresenceVersions.filter { it.domainId in ownedDomainIds }
		}
	}

	/** Fold a poll response's changed-subset versions in per domainId (applyCrossDomainPresence). */
	suspend fun upsertCrossDomainVersions(entries: List<CrossDomainPresenceEntry>) {
		crossDomainVersionsMutex.withLock {
			knownCrossDomainPresenceVersions = upsertKnownCrossDomainPresenceVersions(knownCrossDomainPresenceVersions, entries)
		}
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

	fun start(scope: CoroutineScope) {
		if (pollJob?.isActive == true) return
		pollScope = scope
		pollJob = scope.launch(Dispatchers.IO) {
			var lastDiscoveryAt = 0L
			pollLoop@ while (isActive) {
				var failed = false
				var heldEmpty = false
				var hold = 0L
				try {
					// Backgrounded only: the Router pushes the owner projection over the console socket,
					// which is foreground-only, so the pull remains the sole source while the socket is
					// down. Which gateways the Router can reach rides the same interval, being perishable
					// for the same reason.
					val now = System.currentTimeMillis()
					if (!repo.isVisible && now - lastDiscoveryAt >= ChatRepository.DISCOVERY_REFRESH_MS) {
						lastDiscoveryAt = now
						repo.presence.refreshDiscovery()
						repo.presence.refreshConnectedGateways()
					}
					if (repo.pluginReportPending) repo.reportEnabledPlugins()
					// Visible: long-poll (the hold IS the wait; re-poll immediately).
					// Backgrounded: plain poll (hold=0); the wait after is the idle pushback
					// ladder's decision, not a flat interval - the mailbox batches either way.
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
					// Keyring sync: the route Gateway returns the snapshot only when it changed.
					// Apply it owner-pinned so a revocation made elsewhere reaches this Console.
					mb.domain?.let { repo.applyDomainSync(it, mb.domainVersion ?: "") }
					// Presence plane: the same piggyback shape as domainVersion above, generalized.
					// Present only when at least one source's version differs from what this device
					// presented - an empty presented list (this session's first poll) always ships
					// everything (cold boot).
					if (mb.presence != null || mb.presenceVersions != null) {
						if (mb.presenceVersions != null) knownPresenceVersions = mb.presenceVersions
						mb.presence?.let { rows ->
							val bumpAt = System.currentTimeMillis()
							DebugLog.log("Plane", "presence settled=${mb.settled} rows=${rows.size} serverAt=${started} clientAt=${bumpAt}")
							repo.presence.applyPlanePresence(rows.map { teamInfoToTeam(it, repo.localGatewayId) })
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
							repo.presence.applyLinkedPeers(peers)
						}
					}
					// Cross-Domain-presence plane: unlike every plane above, genuinely N independently-
					// versioned planes (one per linked Domain, see knownCrossDomainPresenceVersions' own
					// doc) - the response carries only the SUBSET of linked Domains whose plane actually
					// changed, applied as a per-domainId upsert (applyCrossDomainPresence), never a
					// wholesale replace.
					mb.crossDomainPresence?.let { entries ->
						DebugLog.log("Plane", "crossDomainPresence settled=${mb.settled} rows=${entries.size}")
						repo.presence.applyCrossDomainPresence(entries)
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
							repo.boardOps.applyBoardSnapshot(
								repo.localGatewayId, entries, mb.taskBoardVersion, mb.taskBoardTruncated == true,
							)
						}
					}
					// Drain the board's pending actions on the poll cadence - the loop already runs at
					// the right rate foreground and follows the pushback ladder backgrounded, and each
					// action is its own relay carrying its own targetGateway.
					launch { runCatching { repo.boardOps.drainBoard() } }
					// On the drain's own cadence, because that is the loop waiting on these bytes. Guarded
					// against a second transfer of the same file, and a no-op when nothing is queued.
					repo.boardOps.resumeBoardUploads()
					// Restarts the wait for a goal armed before this process started, and retires an
					// expired one. A no-op when none is armed.
					repo.goals.tick()
					// Tombstone-expiry self-heal: re-derive `teams` from the cached raw snapshot
					// against the CURRENT tombstone set on every tick, fresh presence or not - see
					// reapplyCachedTeams. A failed or remote forget's tombstone then resurrects the
					// team locally on its own schedule rather than waiting for the next unrelated bump.
					repo.presence.reapplyCachedTeams()
					// An old gateway ignores holdMs and returns empty instantly; floor
					// the cadence so that degradation never becomes a tight spin.
					heldEmpty = hold > 0 && mb.entries.isEmpty() &&
						System.currentTimeMillis() - started < ChatRepository.INSTANT_EMPTY_THRESHOLD_MS
					// Fold the result through the durable cursor: epoch flip, seq dedupe (a
					// lost-ack re-drain), and the dropped-gap DELTA all live in advance(), which
					// returns only genuinely-fresh entries. commit() advances the cursor LAST,
					// after the fresh entries are rendered + persisted (two-phase: a crash
					// re-delivers rather than skips).
					val adv = repo.mailboxSync.advance(
						SyncPollResult(mb.entries.map { Drained(it) }, mb.cursor, mb.epoch, mb.dropped),
					)
					if (mb.entries.isEmpty()) {
						DebugLog.log("Poll", "empty (held=$heldEmpty epoch=${mb.epoch} cursor=${mb.cursor} dropped=${mb.dropped})")
					} else {
						DebugLog.log("Poll", "${adv.fresh.size}/${mb.entries.size} fresh epoch=${mb.epoch} cursor=${mb.cursor} dropped=${mb.dropped}")
					}
					// A gap is a recovery event, not a process-lifetime health state.
					repo._state.update { it.copy(gap = adv.gap) }
					// Idle pushback: any genuinely-fresh entry is comms activity, resetting the silence
					// clock back to the fast cadence.
					if (adv.fresh.isNotEmpty()) repo.pushback.onCommsActivity(System.currentTimeMillis(), repo.isVisible)
					val burst = mutableMapOf<String, MutableList<Message>>()
					val deviceAddr = repo.thisDeviceAddress()
					for (d in adv.fresh) {
						val e = d.entry
						// Resolve the thread key for this entry; null means drop it. Notices thread under
						// the sender's canonical address; conv sessions use the session address, except
						// when that address is THIS device (an agent-initiated push to our own session
						// threads under `from`, the sender, not under ourselves).
						val team: String? = if (e.kind == "notice") {
							// The store key's sender FIRST: it is qualified at the origin, while `from` may be
							// bare (an older gateway), and qualifying a bare name here stamps THIS device's
							// route Gateway onto a notice from another machine.
							(parseStoreKey(e.session_id) as? SessionKey.Notice)?.sender?.canonical
								?: e.from?.let { repo.fromCanonical(it) }
						} else {
							when (val sk = parseStoreKey(e.session_id)) {
								is SessionKey.Conv ->
									if (deviceAddr != null && sk.address == deviceAddr) {
										// Push to our own session: thread under the sender, falling back to our own
										// self-address - a non-address `from` (a raw Device Name) would otherwise become
										// an unsendable ghost-chat key.
										e.from?.let { repo.fromCanonical(it) } ?: sk.address.canonical
									} else {
										sk.address.canonical
									}
								// Not a conv store key; fall back to `from` if present.
								else -> e.from?.let { repo.fromCanonical(it) }
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
							repo.reconcileSent(team, echo)
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
					// Apply the read-anchors piggyback now that this poll's own fresh entries (if any)
					// are already folded into `_state.threads` above - see pendingReadAnchors' own doc.
					pendingReadAnchors?.let { entries ->
						DebugLog.log("Plane", "readAnchors settled=${mb.settled} rows=${entries.size}")
						repo.presence.applyReadAnchors(entries)
					}
					// Report this device's own local read advances (scroll-driven reads since the last
					// cycle) back to the Gateway - the write half of the same plane. Never allowed to
					// fail the poll itself (see reportLocalReadAdvances' own doc).
					repo.presence.reportLocalReadAdvances()
					val burstJobs = mutableListOf<Job>()
					val autoPlayedPeerPairs = mutableSetOf<String>()
					for ((team, msgs) in burst) {
						val lastAgent = msgs.lastOrNull { !it.fromMe }
						// Only spend synthesis on followed threads (open tabs); a
						// never-opened or forgotten session is not in openTabs, so it
						// notifies without preloading.
						val followed = team in repo._state.value.openTabs
						val scope = pollScope
						// Pre-generate and auto-play are independent: enter the launch
						// path when either is active for this followed thread.
						val autoTier = repo.playback.autoPlayTier(repo.sttsAutoPlay)
						val eligible =
							scope != null && lastAgent != null && repo.sttsReady() && followed && (repo.sttsAutoGen || autoTier != null)
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
								if (repo.sttsAutoGen) repo.playback.preloadMessage(warm.first, warm.second)
								repo.onInbound?.invoke(t, ms)
								// Hands-free: queue every arriving message in order. The queue
								// speaks the first immediately and the rest as each terminal
								// lands, so a burst is heard whole instead of only its last.
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
					repo.attachments.fetchPendingAttachments()
					pollFails = 0
					if (repo._state.value.error != null || repo._state.value.pollFailStreak != 0) {
						repo._state.update { it.copy(error = null, pollFailStreak = 0, connected = true, enrollingSince = 0L) }
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
						// outage: the Router still on the shorter hold (upgrade window) or
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
				// The wait tier (and its alarm/wakelock side effects) comes from the silence ladder.
				// A foreground kick interrupts any wait so the user never stares at stale state;
				// visible long-polls chain back-to-back, failures and ignored holds back off to 5s.
				//
				// An open tab is a declaration of interest, and the ladder is otherwise blind to a
				// session working under one: it measures MAIL, and a working session sends none until
				// it finishes. Read through `working`, which is the same presence-first answer the
				// session tiles and the thread chip use, so the cadence cannot disagree with what the
				// owner is being shown.
				val watchedWorking = repo._state.value.let { s -> s.openTabs.any { tab -> s.working(tab) } }
				when (val wait = repo.transportCoordinator.nextWait(repo.isVisible, failed, watchedWorking)) {
					PollWait.Chain -> if (failed || heldEmpty) withTimeoutOrNull(ChatRepository.POLL_INTERVAL_MS) { kick.receive() }
					is PollWait.Delay -> withTimeoutOrNull(wait.ms) { kick.receive() }
					// The alarm (or a foreground/forget kick) is the real wakeup - the timeout below
					// is only a backstop against a lost alarm. Floored at 0 so a pass finishing near
					// the mark never hands withTimeoutOrNull a negative duration.
					is PollWait.Alarm ->
						withTimeoutOrNull((wait.atMillis - System.currentTimeMillis() + ChatRepository.PARK_SLACK_MS).coerceAtLeast(0)) { kick.receive() }
				}
			}
		}
	}
}
