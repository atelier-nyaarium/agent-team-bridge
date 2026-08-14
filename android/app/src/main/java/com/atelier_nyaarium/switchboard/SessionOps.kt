package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.parseTarget
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A session's life beyond its transcript: the terminal view, spawn/wake/relaunch, and the forget
 * that ends one. Owns the spawn idempotency map, which is why it is a held delegate rather than
 * extensions the way the voice settings and the drafts are. */
internal class SessionOps(private val repo: ChatRepository) {
	/** Capture an agent's tmux pane for the terminal view. Returns a Result so the caller can keep
	 * the last frame on a transient failure yet surface the backend's reason (container/host offline)
	 * when the pane never loaded. */
	suspend fun peekTerminal(team: String, sinceHash: String?): Result<com.atelier_nyaarium.switchboard.proto.ConsolePeekResult> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable { repo.client().peek(team, sinceHash) }
		}
			.onSuccess { it.ansi?.let { a -> noteScreen(team, a) } }

	/** Update a session's working + needs-login flags from a captured pane (the spinner and auth
	 * footer markers are the truth). */
	fun noteScreen(team: String, ansi: String) {
		if (ansi.isEmpty()) return
		repo._state.update {
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
	 * its own transient message rather than silently losing the typed name. A call for a (project,
	 * label) still pending from an earlier, unresolved call is a silent no-op (see pendingSpawns)
	 * rather than a second, ambiguous create. Runs on the caller's scope (the Activity's), so a tap
	 * always fires even before the poll loop's scope exists. */
	suspend fun spawnSession(project: String, label: String, workdir: String? = null) = coroutineScope {
		val key = project to label
		// A synchronous check before any suspension point - CreateSessionDialog's own disabled-while-pending
		// state is the primary guard, but it is a Composable snapshot (recomposes asynchronously), not a
		// lock; this is the real one, closing the gap for a caller that races ahead of that recomposition
		// or bypasses the dialog entirely.
		if (key in repo._state.value.pendingSpawns) return@coroutineScope
		val now = System.currentTimeMillis()
		recentSpawnOpIds.entries.removeAll { now - it.value.second >= ChatRepository.SPAWN_RETRY_WINDOW_MS }
		val opId = recentSpawnOpIds[key]?.first ?: UUID.randomUUID().toString()
		recentSpawnOpIds[key] = opId to now
		repo._state.update { it.copy(pendingSpawns = it.pendingSpawns + key) }
		try {
			// The gateway's mint/adopt bumps the presence plane synchronously with the create, so the
			// just-adopted record's tile shows on this device's own NEXT poll with no manual nudge -
			// unlike the pre-plane teams() pull, a fresh presence snapshot needs no explicit trigger.
			runCatchingCancellable {
				withContext(Dispatchers.IO) { repo.client().createSession(project, displayLabel = label, workdir = workdir, opId = opId) }
			}
				.onSuccess { result ->
					recentSpawnOpIds.remove(key)
					repo._state.update {
						it.copy(
							transientMessage = if (result.labelSanitized == true) {
								"\"$label\" has unsupported characters; the session was created using its id as the name instead"
							} else it.transientMessage,
						)
					}
				}
				.onFailure { e ->
					repo._state.update { it.copy(transientMessage = e.message ?: "Failed to create \"$label\"") }
				}
		} finally {
			// The removal point: cleared once createSession itself settles (success or failure), or on
			// cancellation, so a retry within the window can reuse this opId (see recentSpawnOpIds)
			// rather than racing a still-claimed key.
			repo._state.update { it.copy(pendingSpawns = it.pendingSpawns - key) }
		}
	}

	/** Take and clear the one-shot transient message, so a recomposition never re-shows it. */
	fun consumeTransientMessage(): String? {
		val msg = repo._state.value.transientMessage
		if (msg != null) repo._state.update { it.copy(transientMessage = null) }
		return msg
	}

	/** Send text (submitted with Enter) or a named control key to an agent's tmux pane. */
	suspend fun tmuxSend(team: String, text: String? = null, key: String? = null, submit: Boolean = true) =
		withContext(Dispatchers.IO) { repo.client().tmuxSend(team, text, key, submit) }

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

	/** The directory picker's type-ahead read: subdirectories of one host dir. Failures collapse to
	 * an empty list - the picker just shows no suggestions. */
	suspend fun listDirs(path: String): List<String> = withContext(Dispatchers.IO) {
		// Canned listings exist only when seedSandbox installed them (emulator build), keeping the
		// picker inspectable with no gateway behind it.
		repo.sandboxDirs?.let { return@withContext it[path].orEmpty() }
		runCatchingCancellable { repo.client().listDirs(path).entries }.getOrDefault(emptyList())
	}

	/** This owner's admitted Gateways other than the route one. Keyring-derived, so a Gateway with
	 * no sessions in the roster is still reached, and a linked friend's is never included. */
	// internal (not private): BoardOps.refreshBoard and BoardOps.boardAssignTargets fan out to every
	// other Gateway the same way forget and ChatRepository.reportPluginsToOtherGateways do.
	fun otherKeyringGateways(route: String): List<String> =
		(Keyring.parse(repo.store.loadDomain())?.admittedGatewayIds() ?: emptyList()).filter { it != route }

	val terminalRefreshMs: Long get() = repo.store.terminalRefreshMs

	fun setTerminalRefreshMs(ms: Long) {
		repo.store.terminalRefreshMs = ms
	}

	/** Wake an asleep session (the terminal-view Wake button): reattach its record and bring its
	 * container/tmux back up. Reuses create_session's reattach-and-wake path keyed on the session's
	 * own spawn + leaf, so an existing record resumes rather than a duplicate being minted.
	 * Best-effort; a failure surfaces as a transient message. */
	fun wakeSession(team: String) {
		val t = runCatching { parseTarget(team, repo.localDomain(), repo._state.value.localGatewayId) }.getOrNull()
		if (t !is Address || t.gateway != repo._state.value.localGatewayId) return
		repo.drain.scope?.launch(Dispatchers.IO) {
			runCatchingCancellable { repo.client().createSession(target = t.spawn, sessionName = t.session) }
				.onFailure { e ->
					repo._state.update { it.copy(transientMessage = e.message ?: "wake failed") }
				}
		}
	}

	/** Relaunch claude inside team's still-existing pane (the terminal palette's Wake up button):
	 * close_session (kill the tmux, KEEP the record) then create_session (fresh launch, resuming the
	 * record's transcript). Composed from those two existing ops because a bare create cannot do
	 * this - the daemon's ensureSession no-ops whenever the tmux session still exists, whether or
	 * not claude is still running inside it (a Ctrl-C-killed pane is exactly that state). Local
	 * addressable sessions only; throws on failure so the terminal surfaces it inline (tmuxSend's
	 * contract). */
	suspend fun relaunchSession(team: String) {
		withContext(Dispatchers.IO) {
			val t = runCatching { parseTarget(team, repo.localDomain(), repo._state.value.localGatewayId) }.getOrNull()
			if (t !is Address || t.gateway != repo._state.value.localGatewayId) error("not a local session")
			repo.client().closeSession(team)
			repo.client().createSession(target = t.spawn, sessionName = t.session)
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
		val key = repo.canonicalTarget(team)
		repo.forgottenUntil[key] = System.currentTimeMillis() + ChatRepository.FORGET_TOMBSTONE_MS
		var dropped: List<Message> = emptyList()
		val priorDraft = repo._state.value.drafts[key]
		val next = repo._state.updateAndGet { s ->
			val afterForget = threadsAfterForget(s.threads, key)
			dropped = afterForget.dropped
			val newThreads = afterForget.threads
			val newAnchors = (s.readAnchors - key).mapValues { (t, anchor) ->
				reanchorAfterForget(newThreads[t].orEmpty(), anchor) ?: anchor
			}
			repo.presence.lastReportedReadAnchors = repo.presence.lastReportedReadAnchors - key
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
		repo.persistence.persistThreadsAndReadAnchors(next.threads, next.readAnchors)
		repo.persistence.persistLabels(next.labels)
		repo.persistence.persistDrafts(next.drafts)
		// Nothing left to send it into - clears the record, re-arms the alarm, and drops its bucket.
		repo.scheduled.cancelScheduledSend(key)
		// Same, for a goal waiting on a pane about to be killed.
		repo.goals.cancelGoal(key)
		// Queue first, cache second. Dropping under the advance mutex stops the player only once the
		// queue no longer points at it, so the stop's own terminal cannot advance into an entry whose
		// audio `purge` is about to delete.
		repo.repoScope.launch {
			repo.playback.dropQueuedFor(key)
			repo.stts.purge(key)
		}
		// Deliberately its OWN unconditional call, not nested in the local-gateway gate below -
		// the files are local no matter where the session lives, unlike the gateway RPC.
		repo.attachments.scheduleAttachmentDelete(dropped.flatMap { it.files }.mapNotNull { it.src })
		priorDraft?.let { repo.attachments.scheduleAttachmentDelete(it.files.mapNotNull { f -> f.src }) }
		// Also tear the live session down on the gateway (kill tmux + drop the resume record) so it
		// stops listing as available, and dispose of its board work in the same call. Any Gateway this
		// owner's keyring can seal to: a session on another machine has a pane and a board there, and
		// gating this on the route Gateway left its record alive to return when the tombstone expired.
		// Best-effort, the gateway no-ops an absent session.
		val t = runCatching { parseTarget(team, repo.localDomain(), repo._state.value.localGatewayId) }.getOrNull()
		val reachable = (otherKeyringGateways(repo.localGatewayId) + repo.localGatewayId).toSet()
		if (t is Address && t.domain == repo.localDomain() && t.gateway in reachable) {
			repo.drain.scope?.launch(Dispatchers.IO) {
				runCatchingCancellable { repo.client().forget(team, boardDisposition) }
					// The record drop already bumps the presence plane server-side, which wakes this
					// device's own currently-held poll for free (same as closeTab/wakeSession/
					// spawnSession, none of which nudge the poll loop either) - no client-side action
					// needed on success.
					.onSuccess { applied ->
						// A Gateway that predates the field strips the request's copy and answers
						// without one, so it RELEASED work the owner asked to cancel. Say so; the
						// session is gone either way and there is nothing left to retry against.
						if (boardDisposition != null && applied != boardDisposition) {
							repo._state.update {
								it.copy(transientMessage = "Gateway needs an update; that session's tasks went back to the backlog.")
							}
						}
						withContext(Dispatchers.Main) { onForgotten?.invoke() }
					}
					.onFailure { e -> repo._state.update { it.copy(transientMessage = e.message ?: "Forget failed") } }
			}
		} else {
			// Nothing to send it to, so the local drop IS the whole forget.
			onForgotten?.invoke()
		}
	}
}
