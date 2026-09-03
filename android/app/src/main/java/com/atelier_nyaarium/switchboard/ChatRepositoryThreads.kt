package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.Target
import com.atelier_nyaarium.switchboard.proto.parseTarget
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch

internal fun Target.isCloseTabTarget(): Boolean = this is Address

////////////////////////////////
//  Threads, tabs and labels
//
//  Extensions rather than members: the anchors, the open tabs and the label overrides all live in
//  ChatState and persist through ChatPersistence, so none of this holds state of its own.

/** Mark a team fully read without opening it (swipe-away on its notification reads the burst).
 * Advances the persisted anchor to the thread's tail - not just the volatile `unread` count -
 * so a deliberate dismiss survives a process restart instead of resurrecting. */
fun ChatRepository.markRead(team: String) {
	var anchorChanged = false
	val next = _state.updateAndGet { s ->
		val thread = s.threads[team].orEmpty()
		val candidate = lastInboundAnchor(thread)
		val withAnchor = if (candidate != null && isAnchorAdvance(thread, s.readAnchors[team], candidate)) {
			anchorChanged = true
			s.copy(readAnchors = s.readAnchors + (team to candidate))
		} else {
			anchorChanged = false
			s
		}
		withAnchor.recomputeUnread(team, thread)
	}
	if (anchorChanged) persistence.persistReadAnchors(next.readAnchors)
}

/** Open (or focus) a thread's tab, deduped by canonical key. The spawn dialog opens a local
 * `spawn.session` while the board and inbound replies use the full canonical address, so
 * canonicalize before adding or the same session lands as two tabs. Returns the canonical key so
 * the caller can point its active-tab pointer at the same value. Does NOT clear unread - reading
 * a thread is what clears it now (the scroll-driven receipt model), not the act of opening it. */
fun ChatRepository.openThread(team: String): String {
	val key = canonicalTarget(team)
	_state.update { s ->
		s.copy(
			openTabs = if (key in s.openTabs) s.openTabs else s.openTabs + key,
			// Reopening un-mutes: a previously-closed team goes back to full notification treatment.
			closedTeams = s.closedTeams - key,
		)
	}
	return key
}

/** Replace the open-tabs order wholesale (drag-to-reorder in the tab row). Only applied when
 * `newOrder` is still a permutation of the CURRENT tabs: a drag that resolves after a tab closed
 * or opened elsewhere (e.g. a notification landing mid-drag) must not resurrect a dropped tab or
 * silently drop the new one, so a stale commit is a no-op rather than corrupting the set. */
fun ChatRepository.reorderTabs(newOrder: List<String>) {
	_state.update { s -> if (newOrder.toSet() == s.openTabs.toSet()) s.copy(openTabs = newOrder) else s }
}

/** The current first-unread row id and the pointer-region ids (rows still counting toward
 * unread) for `team`, derived from the live anchor. Used by the reveal trigger - always AFTER
 * flushing any pending debounced receipt, so this reflects what was just read rather than a
 * stale pre-flush anchor. */
fun ChatRepository.unreadBoundary(team: String): Pair<Long?, List<Long>> {
	val s = _state.value
	val thread = s.threads[team].orEmpty()
	val anchor = s.readAnchors[team]
	return firstUnreadId(thread, anchor) to unreadRows(thread, anchor).map { it.id }
}

/** A scroll-driven read receipt: the highest row the reader has scrolled past, reported by id
 * with its `at` (guards against a forget-freed id being reused by a later append before this
 * debounced report lands). Resolves to the nearest inbound row at-or-before the report, and
 * only advances the anchor when that resolves to a genuinely later position - so a stale or
 * duplicate report is a harmless no-op. */
fun ChatRepository.readUpTo(team: String, rowId: Long, at: Long) {
	var changed = false
	val next = _state.updateAndGet { s ->
		val thread = s.threads[team].orEmpty()
		val candidate = resolveReportedAnchor(thread, rowId, at)
		if (candidate != null && isAnchorAdvance(thread, s.readAnchors[team], candidate)) {
			changed = true
			s.copy(readAnchors = s.readAnchors + (team to candidate)).recomputeUnread(team, thread)
		} else {
			changed = false
			s
		}
	}
	if (changed) persistence.persistReadAnchors(next.readAnchors)
}

/** Close a tab and its addressable session, keeping the resume record. */
fun ChatRepository.closeTab(team: String) {
	// Canonicalize before touching openTabs/closedTeams (matching openThread's own key), so a
	// non-canonical spelling of an already-open team can't silently miss the removal and mute
	// the wrong (uncanonicalized) key instead.
	val key = canonicalTarget(team)
	// Muted until reopened: full notification treatment (banner + TTS) downgrades to a
	// quiet mailbox/unread-count bump for this team.
	_state.update { it.copy(openTabs = it.openTabs - key, closedTeams = it.closedTeams + key) }
	// Stop speaking a thread the user just closed, but KEEP its cache: a close is reopenable and
	// the audio was already paid for. Only `forget` deletes.
	repoScope.launch { playback.dropQueuedFor(key) }
	val t = runCatching { parseTarget(team, localDomain(), _state.value.homeGatewayId) }.getOrNull()
	if (t?.isCloseTabTarget() == true) {
		drain.scope?.launch(Dispatchers.IO) {
			runCatchingCancellable { client().closeSession(team) }
				.onSuccess { drain.scope?.launch(Dispatchers.IO) { presence.refreshAfterAction() } }
				.onFailure { e -> _state.update { it.copy(transientMessages = it.transientMessages + (e.message ?: "close failed")) } }
		}
	}
}

/** Give a team a local display label (or clear it with a blank name). Local-only: the optimistic
 * cache that shows immediately and the fallback against a gateway with no server label. */
fun ChatRepository.setLabel(team: String, name: String) {
	val labels = _state.updateAndGet { s ->
		val next = if (name.isBlank()) s.labels - team else s.labels + (team to name.trim())
		s.copy(labels = next)
	}.labels
	persistence.persistLabels(labels)
}

/** Rename a session: set it locally for immediate feedback, then push it to the gateway so the
 * label persists server-side, and reconcile the local label to whatever the gateway actually
 * applied (it sanitizes and per-spawn dedups, so "foo" may land as "foo-2"). A blank name clears
 * the local label only, unconditionally - like closeTab's own local-only mutation, clearing never
 * needs the network or an ownership check. On an unreachable/older gateway the optimistic local
 * label stays - the gateway is presumed to apply it eventually. The optimistic non-blank write is
 * withheld for a target that does not resolve to THIS Gateway's own Domain (closeTab permits
 * qualified remote closes; wakeSession routes to the target Gateway).
 * A federated peer's session can coincidentally share this Gateway's id, so this matches the
 * gateway's own rename_session guard, which checks both) -
 * a federated peer's session can otherwise pass the board's own, more permissive Rename-menu gates
 * and flash a label that was never actually applied anywhere; the round trip is still attempted
 * regardless (a second, reactive line of defense - the server's own rejection is the backstop even
 * if this check has a gap). An outright rejection (a successful round trip that still reports
 * renamed:false) reverts the optimistic write, but ONLY if the label still holds exactly what this
 * call wrote - a fresher server value landing via withFreshTeams, or a newer overlapping rename,
 * must never be clobbered by a stale rejection arriving late, and the transient message mirrors that
 * same guard (no revert happened -> nothing to report). A foreign target is always refused server-side
 * as a thrown error (not a clean renamed:false reply - there is no local record to even consider
 * renaming), so it is treated the same as an explicit rejection instead of the quiet
 * presumed-eventually-applied handling a genuinely unreachable LOCAL gateway gets - otherwise that
 * case is a silent no-op indistinguishable from success. */
suspend fun ChatRepository.rename(team: String, name: String) {
	val trimmed = name.trim()
	if (trimmed.isEmpty()) {
		setLabel(team, "")
		return
	}
	val t = runCatching { parseTarget(team, localDomain(), _state.value.homeGatewayId) }.getOrNull()
	val isLocal = t is Address && t.isLocalTo(localDomain(), setOf(_state.value.homeGatewayId))
	val previous = _state.value.labels[team]
	if (isLocal) setLabel(team, trimmed)
	val reply = withContext(Dispatchers.IO) {
		client().renameSession(team, trimmed)
	}
	val applied = reply.takeIf { it.renamed }?.sessionLabel
	if (applied != null && applied != trimmed) {
		// A confirmed, authoritative server value always wins over "nothing was protecting the
		// label to begin with" (isLocal false - no optimistic write was ever made to clobber).
		// When there WAS an optimistic write, only overwrite it while it still holds exactly what
		// this call itself set - never stomp a fresher value a concurrent self-heal or a later
		// rename already landed in the meantime.
		val next = _state.updateAndGet { s ->
			if (!isLocal || s.labels[team] == trimmed) s.copy(labels = s.labels + (team to applied)) else s
		}
		persistence.persistLabels(next.labels)
	} else if (reply.renamed == false) {
		var reverted = true
		if (isLocal) {
			val before = _state.value.labels[team]
			val next = _state.updateAndGet { s ->
				if (s.labels[team] == trimmed) {
					s.copy(labels = if (previous != null) s.labels + (team to previous) else s.labels - team)
				} else {
					s
				}
			}
			persistence.persistLabels(next.labels)
			reverted = next.labels[team] != before
		}
		if (reverted) {
			val message = "Could not rename to \"$trimmed\""
			_state.update { it.copy(transientMessages = it.transientMessages + message) }
		}
	}
	presence.refreshAfterAction()
}
