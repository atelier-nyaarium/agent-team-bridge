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

/** A session's life beyond its transcript: the terminal view, spawn/wake/relaunch, and the forget
 * that ends one. Owns the spawn idempotency map, which is why it is a held delegate rather than
 * extensions the way the voice settings and the drafts are. */
internal class SessionOps(
	private val host: SessionHost,
	private val presence: PresencePort,
	private val journal: MutationJournal,
) {
	/** Fire and forget; a session action never waits on the roster. */
	private fun refreshAfterAction() {
		host.launchInBackground { presence.refreshAfterAction() }
	}

	/** Capture an agent's tmux pane for the terminal view. Returns a Result so the caller can keep
	 * the last frame on a transient failure yet surface the backend's reason (container/host offline)
	 * when the pane never loaded. */
	suspend fun peekTerminal(team: String, sinceHash: String?): Result<com.atelier_nyaarium.switchboard.proto.ConsolePeekResult> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable { host.peekTerminal(team, sinceHash) }
		}
				.onFailure { DebugLog.log("Peek", "team=$team failed: ${it.message?.take(160)}") }
			.onSuccess { it.ansi?.let { a -> noteScreen(team, a) } }

	/** Update a session's working + needs-login flags from a captured pane (the spinner and auth
	 * footer markers are the truth). */
	fun noteScreen(team: String, ansi: String) {
		if (ansi.isEmpty()) return
		host.state.update {
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
	 * its own transient message rather than silently losing the typed name. A call for a (target,
	 * label) still pending from an earlier, unresolved call is a silent no-op (see pendingSpawns)
	 * rather than a second, ambiguous create. Runs on the caller's scope (the Activity's), so a tap
	 * always fires even before the poll loop's scope exists.
	 *
	 * `target` is a spawn point, bare for this Gateway and QUALIFIED (`domain.gateway.spawn`) for
	 * another of the owner's machines - `targetGatewayOf` reads the gateway out of it and seals there,
	 * so naming the machine in the target is the whole of remote spawn. It is also what the pending
	 * and retry maps key on, rather than the bare project: the same project name exists on every
	 * machine, so keying on it would make a create on one machine suppress a create on another. */
	/** Record which project this Gateway was last spawned on, so the create dialog can suggest it.
	 *
	 * Both halves are read out of the TARGET rather than passed alongside it: a caller supplying them
	 * separately could disagree with the target it actually sent. `spawnTargetKey` owns that reading,
	 * including the rule that a bare target means the home Gateway; a target it cannot place is not
	 * remembered at all, since a suggestion is never worth guessing at. */
	private fun rememberProject(target: String) {
		host.rememberProject(target)
	}

	suspend fun spawnSession(target: String, label: String, workdir: String? = null) = coroutineScope {
		val key = target to label
		// Atomic claim.
		val before = host.state.getAndUpdate { s ->
			if (key in s.pendingSpawns) s else s.copy(pendingSpawns = s.pendingSpawns + key)
		}
		if (key in before.pendingSpawns) return@coroutineScope
		// Remembered on attempt, not on success.
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
			// The removal point: cleared once createSession itself settles (success or failure), or on
			// cancellation, so a retry within the window can reuse this opId (see recentSpawnOpIds)
			// rather than racing a still-claimed key.
			host.state.update { it.copy(pendingSpawns = it.pendingSpawns - key) }
		}
	}

	/** Take and clear the one-shot transient message, so a recomposition never re-shows it. */
	fun consumeTransientMessage(): String? {
		var msg: String? = null
		host.state.update { state ->
			msg = state.transientMessages.firstOrNull()
			state.copy(transientMessages = if (msg == null) state.transientMessages else state.transientMessages.drop(1))
		}
		return msg
	}

	/** Send text (submitted with Enter) or a named control key to an agent's tmux pane. */
	suspend fun tmuxSend(team: String, text: String? = null, key: String? = null, submit: Boolean = true) =
		withContext(Dispatchers.IO) { host.tmuxSend(team, text, key, submit) }

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

	/**
	 * The directory picker's type-ahead read: subdirectories of one host dir.
	 *
	 * `hostTarget` names WHICH machine to read, so a workdir picked for a session on another Gateway
	 * comes from that machine's filesystem. Required, with no bare default: a bare target resolves to
	 * this device's home Gateway, so an omitted one would list the wrong machine and say nothing.
	 *
	 * Reports WHY there is no listing rather than collapsing to an empty one. An unreachable machine,
	 * a Gateway with no host daemon and a folder with no subdirectories all produced the same blank
	 * picker, which is how a switched-off machine read as a broken feature.
	 */
	suspend fun listDirs(path: String, hostTarget: String, spawn: String): DirListing = withContext(Dispatchers.IO) {
		// Canned listings exist only when seedSandbox installed them (emulator build), keeping the
		// picker inspectable with no gateway behind it.
		host.sandboxDirs?.let { return@withContext DirListing(it[path].orEmpty()) }
		runCatchingCancellable {
			val listed = host.listDirs(path, hostTarget, spawn)
			DirListing(listed.entries, path = listed.path)
		}
			.getOrElse { DirListing(emptyList(), error = dirListError(it)) }
	}

	/** This owner's admitted Gateways, the route one included. Keyring-derived, so a Gateway with no
	 * sessions in the roster is still named, and a linked friend's never is. */
	// internal (not private): ChatRepository.refreshAdmittedGateways publishes this into ChatState, so
	// the sessions board draws a machine it can seal to even before that machine has any sessions.
	fun keyringGateways(): List<String> = host.keyringGateways()

	val terminalRefreshMs: Long get() = host.terminalRefreshMs

	fun setTerminalRefreshMs(ms: Long) {
		host.terminalRefreshMs = ms
	}

	// This device's own outstanding requests, keyed by team. The freshest fact this device holds
	// about a session, and before it existed the wake below threw it away and then waited to be TOLD
	// why waking another machine showed a blank terminal. Scoped by opId so an overlapping wake and
	// relaunch cannot retire each other's; see ActionReceipt.
	private val receipts = mutableMapOf<String, ActionReceipt>()

	/** The receipt outstanding for a team, dropping one that has aged out or already failed. Read on
	 * every roster rebuild, so an expiry needs no timer of its own. */
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

	/** Settle a receipt, but ONLY if it is still the one this call opened. A wake and a relaunch that
	 * overlap would otherwise let the first one's answer retire the second one's request, putting the
	 * session straight back to reading as asleep while it is still coming up. */
	@Synchronized
	private fun settleReceipt(team: String, opId: String, outcome: ActionReceipt.Outcome) {
		val r = receipts[team] ?: return
		if (r.opId != opId) return
		if (outcome == ActionReceipt.Outcome.FAILED) receipts.remove(team) else receipts[team] = r.copy(outcome = outcome)
	}

	/** Evidence beats a request: any Gateway reporting the session up retires the receipt outright,
	 * which is what stops an optimistic "waking" from outliving the thing it was predicting. */
	@Synchronized
	fun clearReceipt(team: String) {
		receipts.remove(team)
	}

	/** Wake an asleep session (the terminal-view Wake button): the session's own Gateway reattaches
	 * its record and brings its container/tmux back up, so an existing record resumes rather than a
	 * duplicate being minted. Best-effort; a failure surfaces as a transient message. */
	fun wakeSession(team: String) {
		val target = wakeTargetOf(team, host.localDomain, host.state.value.homeGatewayId) ?: return
		val opId = UUID.randomUUID().toString()
		noteReceipt(team, ActionReceipt(opId, System.currentTimeMillis()))
		// Republish immediately so the terminal's gate sees the receipt on THIS frame rather than on
		// the next poll.
		host.launchInBackground { presence.reapplyCachedTeams() }
		host.launchInBackground {
			runCatchingCancellable { host.wake(target, opId) }
				.onSuccess {
					settleReceipt(team, opId, ActionReceipt.Outcome.ACCEPTED)
					refreshAfterAction()
				}
				.onFailure { e ->
					DebugLog.log("Wake", "wake $team failed: ${e.javaClass.simpleName}: ${e.message?.take(160)}")
					// FAILED retires the receipt rather than letting it run out its TTL: the surface
					// must stop saying "waking" the moment we know nothing is coming, and the reason
					// is already on its way to the user as a transient message.
					settleReceipt(team, opId, ActionReceipt.Outcome.FAILED)
					presence.reapplyCachedTeams()
					host.state.update { it.copy(transientMessages = it.transientMessages + (e.message ?: "wake failed")) }
				}
		}
	}

	/** Relaunch claude inside team's still-existing pane (the terminal palette's Wake up button):
	 * close_session (kill the tmux, KEEP the record) then create_session (fresh launch, resuming the
	 * record's transcript). Composed from those two existing ops because a bare create cannot do
	 * this - the daemon's ensureSession no-ops whenever the tmux session still exists, whether or
	 * not claude is still running inside it (a Ctrl-C-killed pane is exactly that state). Throws on
	 * failure so the terminal surfaces it inline (tmuxSend's contract). */
	suspend fun relaunchSession(team: String) {
		withContext(Dispatchers.IO) {
			val t = runCatching { parseTarget(team, host.localDomain, host.state.value.homeGatewayId) }.getOrNull()
			if (t !is Address) error("not an addressable session")
			// Its own receipt, its own opId. A relaunch CLOSES the session first, so the roster
			// correctly drops to asleep mid-sequence; without a receipt covering the whole chain the
			// terminal would stop peeking exactly while the replacement is coming up.
			val opId = UUID.randomUUID().toString()
			noteReceipt(team, ActionReceipt(opId, System.currentTimeMillis()))
			presence.reapplyCachedTeams()
			try {
				host.closeSession(team)
				// Qualified, matching closeSession's own routing - a bare spawn re-created the session on
				host.createSession(
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

	/** Drop a peer from this device: its thread, unread, tab, label, any cached TTS audio, and any
	 * peer-mirror row elsewhere that names it as a real party (see threadsAfterForget). Threads AND
	 * read anchors change in this ONE transition (the peer sweep can orphan a sibling thread's
	 * anchor row, re-anchored below), so both persist in a single batch - a process kill between
	 * two separate writes could otherwise strand a sibling's anchor against its already-updated
	 * (shrunk) thread. `unread` is recomputed for every team, not just the forgotten one: the sweep
	 * can remove rows another thread was counting, so its count must be re-derived too. Also drops
	 * the team from the board tile list immediately (see ChatRepository.forgottenUntil for why that
	 * needs a tombstone rather than a bare filter). */
	fun forget(team: String, boardDisposition: String? = null, onForgotten: (() -> Unit)? = null) {
		// Canonicalize once and key every field removal by it (matching openThread's own key), so
		// a non-canonical spelling can't leave a field's entry behind while the others clear.
		val key = host.canonicalTarget(team)
		// Any Gateway this owner's keyring can seal to; the pane and the board live there.
		val t = runCatching { parseTarget(team, host.localDomain, host.state.value.homeGatewayId) }.getOrNull()
		val pending = if (t is Address && t.isLocalTo(host.localDomain, keyringGateways().toSet())) journalForget(key, boardDisposition) else null
		// Held until the Gateway confirms. A journal write that failed gets the plain window.
		host.forgottenUntil[key] = if (pending?.journaled == true) FORGET_HELD else System.currentTimeMillis() + host.forgetTombstoneMs
		var dropped: List<Message> = emptyList()
		val priorDraft = host.state.value.drafts[key]
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
		// Nothing left to send it into - clears the record, re-arms the alarm, and drops its bucket.
		host.cancelScheduled(key)
		// Same, for a goal waiting on a pane about to be killed.
		host.cancelGoal(key)
		// Queue first, cache second. Dropping under the advance mutex stops the player only once the
		// queue no longer points at it, so the stop's own terminal cannot advance into an entry whose
		// audio `purge` is about to delete.
		host.dropPlayback(key)
		// Deliberately its OWN unconditional call, not nested in the local-gateway gate below -
		// the files are local no matter where the session lives, unlike the gateway RPC.
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
			// The pane and the record outlive the row otherwise; nothing to send it to.
			DebugLog.log("Forget", "team=$team dropped locally; no Gateway to send it to")
			onForgotten?.invoke()
		}
	}

	/** A forget the Gateway has not confirmed. */
	private data class PendingForget(val opId: String, val team: String, val boardDisposition: String?, val journaled: Boolean = true)

	// OpIds with a send outstanding; a replay skips them.
	private val forgetsInFlight = java.util.Collections.synchronizedSet(mutableSetOf<String>())
	private val forgetRetryArmed = AtomicBoolean(false)

	/** Journaled before anything local goes, so a death here loses nothing the Gateway still holds. */
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

	/** Hide every journaled forget's row before the first roster lands. */
	fun armPendingForgetTombstones() {
		for (p in pendingForgets()) host.forgottenUntil[p.team] = FORGET_HELD
	}

	/** Re-send every forget the Gateway never confirmed. Idempotent per opId at the Gateway. */
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

	/** One retry timer at a time. */
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

	/** Kill the pane, drop the resume record, and dispose of the board work in one call. Confirmed, the
	 * journal entry goes and the tombstone shrinks to the snapshot-race window. */
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
		// The record drop bumps the presence plane server-side, which wakes this device's held poll.
		refreshAfterAction()
		// A Gateway that predates the field released work the owner asked to cancel.
		if (p.boardDisposition != null && applied != p.boardDisposition) {
			host.state.update {
				it.copy(transientMessages = it.transientMessages + "Gateway needs an update; that session's tasks went back to the backlog.")
			}
		}
		onForgotten?.let { withContext(Dispatchers.Main) { it() } }
	}

	private companion object {
		const val FORGET_JOURNAL_KIND = "forget"
		// Never expires; a confirmed forget replaces it with the window.
		const val FORGET_HELD = Long.MAX_VALUE
	}
}

/** The QUALIFIED session address a Wake is sent to, so the op routes to the session's own Gateway.
 * Null for anything that is not a session: a spawn point has no pane to wake. */
internal fun wakeTargetOf(team: String, localDomain: String, homeGatewayId: String): String? =
	(runCatching { parseTarget(team, localDomain, homeGatewayId) }.getOrNull() as? Address)?.canonical
