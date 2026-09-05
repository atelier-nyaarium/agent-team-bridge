package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.parseTarget
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal class SessionOps(
	private val host: SessionHost,
	private val presence: PresencePort,
	private val journal: MutationJournal,
) {
	private fun refreshAfterAction() {
		// Actions refresh presence asynchronously and never wait on the roster.
		host.launchInBackground { presence.refreshAfterAction() }
	}

	suspend fun peekTerminal(team: String, sinceHash: String?): Result<com.atelier_nyaarium.switchboard.proto.ConsolePeekResult> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable { host.peekTerminal(team, sinceHash) }
		}
				.onFailure { DebugLog.log("Peek", "team=$team failed: ${it.message?.take(160)}") }
			.onSuccess { it.ansi?.let { a -> noteScreen(team, a) } }

	fun noteScreen(team: String, ansi: String) {
		if (ansi.isEmpty()) return
		host.state.update {
			it.copy(
				sessionWorking = it.sessionWorking + (team to AgentScreen.isWorking(ansi)),
				sessionNeedsLogin = it.sessionNeedsLogin + (team to AgentScreen.isLoggedOut(ansi)),
			)
		}
	}

	// Retries reuse the opId within the retry window.
	private val recentSpawnOpIds = mutableMapOf<Pair<String, String>, Pair<String, Long>>()

	private fun rememberProject(target: String) {
		host.rememberProject(target)
	}

	suspend fun spawnSession(target: String, label: String, workdir: String? = null) = coroutineScope {
		val key = target to label
		val before = host.state.getAndUpdate { s ->
			if (key in s.pendingSpawns) s else s.copy(pendingSpawns = s.pendingSpawns + key)
		}
		if (key in before.pendingSpawns) return@coroutineScope
		rememberProject(target)
		val now = System.currentTimeMillis()
		recentSpawnOpIds.entries.removeAll { now - it.value.second >= host.spawnRetryWindowMs }
		val opId = recentSpawnOpIds[key]?.first ?: UUID.randomUUID().toString()
		recentSpawnOpIds[key] = opId to now
		try {
			runCatchingCancellable {
				withContext(Dispatchers.IO) { host.createSession(target, displayLabel = label, workdir = workdir, opId = opId) }
			}
				.onSuccess { result ->
					recentSpawnOpIds.remove(key)
					host.state.update {
						it.copy(
							transientMessages = if (result.labelSanitized == true) {
								it.transientMessages + "\"$label\" has unsupported characters; the session was created using its id as the name instead"
							} else it.transientMessages,
						)
					}
					refreshAfterAction()
				}
				.onFailure { e ->
					val reason = e.message ?: "Failed to create \"$label\""
					host.state.update { it.copy(transientMessages = it.transientMessages + reason) }
				}
		} finally {
			// Clear the pending claim after create settles, including cancellation.
			host.state.update { it.copy(pendingSpawns = it.pendingSpawns - key) }
		}
	}

	fun consumeTransientMessage(): String? {
		var msg: String? = null
		host.state.update { state ->
			msg = state.transientMessages.firstOrNull()
			state.copy(transientMessages = if (msg == null) state.transientMessages else state.transientMessages.drop(1))
		}
		return msg
	}

	suspend fun tmuxSend(team: String, text: String? = null, key: String? = null, submit: Boolean = true) =
		withContext(Dispatchers.IO) { host.tmuxSend(team, text, key, submit) }

	/** Sends the dialog choice, resume text, and Enter separately. */
	suspend fun resumeAfterLimit(team: String) = withContext(Dispatchers.IO) {
		tmuxSend(team, text = "1", submit = false)
		tmuxSend(team, text = "resume", submit = false)
		tmuxSend(team, key = "Enter")
	}

	/** `hostTarget` selects the machine whose filesystem is listed. */
	suspend fun listDirs(path: String, hostTarget: String, spawn: String): DirListing = withContext(Dispatchers.IO) {
		host.sandboxDirs?.let { return@withContext DirListing(it[path].orEmpty()) }
		runCatchingCancellable {
			val listed = host.listDirs(path, hostTarget, spawn)
			DirListing(listed.entries, path = listed.path)
		}
			.getOrElse { DirListing(emptyList(), error = dirListError(it)) }
	}

	// Keyring gateways include admitted owner machines, never linked friends.
	fun keyringGateways(): List<String> = host.keyringGateways()

	val terminalRefreshMs: Long get() = host.terminalRefreshMs

	fun setTerminalRefreshMs(ms: Long) {
		host.terminalRefreshMs = ms
	}

	// Receipts are local optimistic state, keyed by session and fenced by opId.
	private val receipts = mutableMapOf<String, ActionReceipt>()

	@Synchronized
	fun receiptFor(team: String, now: Long): ActionReceipt? {
		val r = receipts[team] ?: return null
		if (!r.live(now)) {
			receipts.remove(team)
			return null
		}
		return r
	}

	@Synchronized
	private fun noteReceipt(team: String, r: ActionReceipt) {
		receipts[team] = r
	}

	/** Settles only the receipt matching this operation. */
	@Synchronized
	private fun settleReceipt(team: String, opId: String, outcome: ActionReceipt.Outcome) {
		val r = receipts[team] ?: return
		if (r.opId != opId) return
		if (outcome == ActionReceipt.Outcome.FAILED) receipts.remove(team) else receipts[team] = r.copy(outcome = outcome)
	}

	@Synchronized
	fun clearReceipt(team: String) {
		receipts.remove(team)
	}

	fun wakeSession(team: String) {
		val target = wakeTargetOf(team, host.localDomain, host.state.value.homeGatewayId) ?: return
		val opId = UUID.randomUUID().toString()
		noteReceipt(team, ActionReceipt(opId, System.currentTimeMillis()))
		// Republish cached teams immediately so the receipt appears on this frame.
		host.launchInBackground { presence.reapplyCachedTeams() }
		host.launchInBackground {
			runCatchingCancellable { host.wake(target, opId) }
				.onSuccess {
					settleReceipt(team, opId, ActionReceipt.Outcome.ACCEPTED)
					refreshAfterAction()
				}
				.onFailure { e ->
					DebugLog.log("Wake", "wake $team failed: ${e.javaClass.simpleName}: ${e.message?.take(160)}")
					settleReceipt(team, opId, ActionReceipt.Outcome.FAILED)
					presence.reapplyCachedTeams()
					host.state.update { it.copy(transientMessages = it.transientMessages + (e.message ?: "wake failed")) }
				}
		}
	}

	suspend fun relaunchSession(team: String) {
		withContext(Dispatchers.IO) {
			val t = runCatching { parseTarget(team, host.localDomain, host.state.value.homeGatewayId) }.getOrNull()
			if (t !is Address) error("not an addressable session")
			val opId = UUID.randomUUID().toString()
			// Keep one receipt across close and create while the roster reports asleep.
			noteReceipt(team, ActionReceipt(opId, System.currentTimeMillis()))
			presence.reapplyCachedTeams()
			try {
				host.closeSession(team)
				host.createSession(
					// Route creation to the session's qualified Gateway.
					target = SpawnPoint.of(t.domain, t.gateway, t.spawn).canonical,
					sessionName = t.session,
					opId = UUID.randomUUID().toString(),
				)
			} catch (e: Throwable) {
				e.rethrowIfCancellation()
				settleReceipt(team, opId, ActionReceipt.Outcome.FAILED)
				presence.reapplyCachedTeams()
				throw e
			}
			settleReceipt(team, opId, ActionReceipt.Outcome.ACCEPTED)
			refreshAfterAction()
		}
	}

	fun forget(team: String, boardDisposition: String? = null, onForgotten: (() -> Unit)? = null) {
		val key = host.canonicalTarget(team)
		val t = runCatching { parseTarget(team, host.localDomain, host.state.value.homeGatewayId) }.getOrNull()
		val pending = if (t is Address && t.isLocalTo(host.localDomain, keyringGateways().toSet())) journalForget(key, boardDisposition) else null
		host.forgottenUntil[key] = if (pending?.journaled == true) FORGET_HELD else System.currentTimeMillis() + host.forgetTombstoneMs
		var dropped: List<Message> = emptyList()
		val priorDraft = host.state.value.drafts[key]
		// Persist threads and read anchors from the same state transition.
		val next = host.state.updateAndGet { s ->
			val afterForget = threadsAfterForget(s.threads, key)
			dropped = afterForget.dropped
			val newThreads = afterForget.threads
			val newAnchors = (s.readAnchors - key).mapValues { (t, anchor) ->
				reanchorAfterForget(newThreads[t].orEmpty(), anchor) ?: anchor
			}
			host.forgetReadAnchor(key)
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
		host.persistThreads(next.threads, next.readAnchors)
		host.persistLabels(next.labels)
		host.persistDrafts(next.drafts)
		host.cancelScheduled(key)
		host.cancelGoal(key)
		// Remove playback queue entries before cached audio.
		host.dropPlayback(key)
		host.scheduleAttachmentDelete(dropped.flatMap { it.files }.mapNotNull { it.src })
		priorDraft?.let { host.scheduleAttachmentDelete(it.files.mapNotNull { f -> f.src }) }
		if (pending != null) {
			forgetsInFlight.add(pending.opId)
			host.launchInBackground {
				try {
					deliverForget(pending, announce = true, onForgotten)
				} finally {
					forgetsInFlight.remove(pending.opId)
				}
			}
		} else {
			DebugLog.log("Forget", "team=$team dropped locally; no Gateway to send it to")
			onForgotten?.invoke()
		}
	}

	private data class PendingForget(val opId: String, val team: String, val boardDisposition: String?, val journaled: Boolean = true)

	private val forgetsInFlight = java.util.Collections.synchronizedSet(mutableSetOf<String>())
	private val forgetRetryArmed = AtomicBoolean(false)

	/** Journal before local deletion. */
	private fun journalForget(team: String, boardDisposition: String?): PendingForget {
		val opId = UUID.randomUUID().toString()
		val journaled = runCatching {
			journal.append(opId, FORGET_JOURNAL_KIND, JSONObject().put("team", team).putOpt("boardDisposition", boardDisposition))
		}
			.onFailure { DebugLog.log("Forget", "journal append failed for $team: ${it.message?.take(160)}") }
			.isSuccess
		return PendingForget(opId, team, boardDisposition, journaled)
	}

	private fun pendingForgets(): List<PendingForget> =
		journal.entries(FORGET_JOURNAL_KIND).map {
			PendingForget(it.opId, it.payload.getString("team"), it.payload.optString("boardDisposition").ifEmpty { null })
		}

	fun armPendingForgetTombstones() {
		for (p in pendingForgets()) host.forgottenUntil[p.team] = FORGET_HELD
	}

	suspend fun replayPendingForgets() {
		for (p in pendingForgets()) {
			if (!forgetsInFlight.add(p.opId)) continue
			try {
				host.forgottenUntil[p.team] = FORGET_HELD
				deliverForget(p, announce = false)
			} finally {
				forgetsInFlight.remove(p.opId)
			}
		}
	}

	private fun scheduleForgetRetry() {
		if (!forgetRetryArmed.compareAndSet(false, true)) return
		host.launchInBackground {
			try {
				delay(host.forgetRetryMs)
			} finally {
				forgetRetryArmed.set(false)
			}
			replayPendingForgets()
		}
	}

	private suspend fun deliverForget(p: PendingForget, announce: Boolean, onForgotten: (() -> Unit)? = null) {
		val applied = runCatchingCancellable { host.forget(p.team, p.boardDisposition, p.opId) }
			.getOrElse { e ->
				DebugLog.log("Forget", "team=${p.team} failed: ${e.message?.take(160)}")
				if (announce) host.state.update { it.copy(transientMessages = it.transientMessages + (e.message ?: "Forget failed")) }
				scheduleForgetRetry()
				return
			}
		runCatching { journal.remove(p.opId) }
		host.forgottenUntil[p.team] = System.currentTimeMillis() + host.forgetTombstoneMs
		refreshAfterAction()
		if (p.boardDisposition != null && applied != p.boardDisposition) {
			host.state.update {
				it.copy(transientMessages = it.transientMessages + "Gateway needs an update; that session's tasks went back to the backlog.")
			}
		}
		onForgotten?.let { withContext(Dispatchers.Main) { it() } }
	}

	private companion object {
		const val FORGET_JOURNAL_KIND = "forget"
		// Hold the tombstone until Gateway confirmation, then use the race window.
		const val FORGET_HELD = Long.MAX_VALUE
	}
}

internal fun wakeTargetOf(team: String, localDomain: String, homeGatewayId: String): String? =
	(runCatching { parseTarget(team, localDomain, homeGatewayId) }.getOrNull() as? Address)?.canonical
