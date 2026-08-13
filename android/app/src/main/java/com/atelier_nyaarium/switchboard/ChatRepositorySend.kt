package com.atelier_nyaarium.switchboard

import android.net.Uri
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.withContext

////////////////////////////////
//  Outbound send pipeline
//
//  Extensions rather than members: every step reads and writes the SAME ChatState threads map and
//  persists through ChatPersistence, so none of it holds state of its own. The one field the
//  pipeline keeps (ChatRepository.reconciled) stays declared on the class, since an extension has no
//  backing field.

suspend fun ChatRepository.send(team: String, text: String, uris: List<Uri> = emptyList()) = withContext(Dispatchers.IO) {
	val (picked, refused) = admitPicked(uris, "pick-${java.util.UUID.randomUUID()}")
	if (refused != null) {
		_state.update { it.copy(error = refused.message()) }
		return@withContext
	}
	// Local echo: persist the picked files so the sent message shows its own thumbnails through
	// the same asset-loader path as inbound files. The echo starts "pending" and resolves to
	// sent (null) or "error" when the op lands. Bucketed by opId (globally unique), not a bare
	// millis timestamp - two sends in the same millisecond would otherwise collide on one
	// bucket dir, and forget()/reconcileSent's per-file delete cannot protect two rows that
	// share the identical src.
	val opId = java.util.UUID.randomUUID().toString()
	val localFiles = Attachments.storeOutgoing(filesDir, "out-$opId", picked)
	val echoId = append(
		team,
		Message(true, text, System.currentTimeMillis(), files = localFiles, status = "pending", opId = opId),
	)
	val wasAvailable = _state.value.teams.firstOrNull { it.name == team }?.status == "available"
	// Cold wake takes minutes with no wire traffic, so say so - as a notice card (ChatState.
	// wakingTeams), not a transcript row. Only the send that RAISES the notice may clear it on
	// failure, so a second send failing while the first is still in flight leaves the wait intact.
	val raisedWakeNotice = wasAvailable && team !in _state.value.wakingTeams
	if (raisedWakeNotice) _state.update { it.copy(wakingTeams = it.wakingTeams + team) }
	deliver(team, echoId, text, picked, opId, raisedWakeNotice)
}

/** Re-send a failed message, rebuilding attachment bytes from their local
 * copies. The error -> pending flip is the atomic claim: a double-tap's second
 * coroutine finds the row already pending and backs off, so the wire send runs
 * once. The original opId is reused so the gateway dedupes a lost-reply retry.
 * `targetDomainOverride` is passed straight through to [deliver] - used by a scheduled send's
 * own bounded retry, whose banked targetDomainId must survive a cold process the same way the
 * original fire itself does (state.teams is empty until connect() completes). */
suspend fun ChatRepository.retrySend(team: String, messageId: Long, targetDomainOverride: String? = null) =
	withContext(Dispatchers.IO) {
		var claimed = false
		_state.update { s ->
			val thread = s.threads[team] ?: return@update s.also { claimed = false }
			val msg = thread.firstOrNull { it.id == messageId }
			if (msg == null || !msg.fromMe || msg.status != "error") {
				claimed = false
				s
			} else {
				claimed = true
				// A retry submits the message NOW, so it belongs at the end of the thread rather than
				// back at its original position: anything that arrived while it sat failed genuinely
				// came first, and leaving it above them would misreport the order of the conversation.
				val retried = msg.copy(status = "pending", at = System.currentTimeMillis())
				s.copy(threads = s.threads + (team to (thread.filterNot { it.id == messageId } + retried)))
			}
		}
		if (!claimed) return@withContext
		val msg = _state.value.threads[team]?.firstOrNull { it.id == messageId } ?: return@withContext
		persistence.persistThreads(_state.value.threads)
		val (files, refused) = rebuildFiles(msg)
		if (refused != null) {
			setMessageStatus(team, messageId, "error")
			_state.update { it.copy(error = refused.message()) }
			return@withContext
		}
		if (msg.text.isBlank() && files.isEmpty()) {
			// Nothing recoverable (attachment copies gone); put the badge back and say why.
			setMessageStatus(team, messageId, "error")
			_state.update { it.copy(error = "Attachments are no longer on this device; cannot retry.") }
			return@withContext
		}
		if (files.size < msg.files.size) {
			_state.update { it.copy(error = "Some attachments are no longer on this device; resending the rest.") }
		}
		deliver(team, messageId, msg.text, files, msg.opId ?: java.util.UUID.randomUUID().toString(), false, targetDomainOverride)
	}

/** Run the wire send and settle the echo row's state from the outcome. On success the cold-wake
 * notice (if this send raised one) MUST survive: the wake itself is what takes minutes, and
 * appendInbound drops the notice when the real reply arrives. On failure or cancellation, nothing
 * is coming to clear it, so it is dropped here. */
// internal (not private): ScheduledSendOps.fireOne delivers a banked send through this same path.
internal suspend fun ChatRepository.deliver(
	team: String,
	echoId: Long,
	text: String,
	picked: List<OutgoingFile>,
	opId: String,
	raisedWakeNotice: Boolean,
	targetDomainOverride: String? = null,
) {
	var succeeded = false
	fun fail(message: String?) {
		_state.update { it.copy(error = message ?: "send failed") }
		setMessageStatus(team, echoId, "error")
	}
	try {
		// A cross-Domain target carries the friend Domain id from its discovery entry, so the
		// gateway resolves the seal target by the full (domainId, gatewayId) pair; a local /
		// same-Domain session resolves to null and keeps the existing routing. A cold scheduled-
		// send fire supplies targetDomainOverride instead: state.teams is empty until connect()
		// completes, so re-deriving here would silently drop a cross-Domain target banked at
		// schedule time (see ScheduledSend.targetDomainId).
		val targetDomain = targetDomainOverride ?: run {
			val adminDomain = confirmedDomainId()
			val canonical = canonicalTarget(team)
			_state.value.teams
				.firstOrNull { it.name == canonical }
				?.domainId
				?.takeIf { it.isNotEmpty() && adminDomain != null && it != adminDomain }
		}
		val r = client().send(team, text, picked, opId, targetDomain)
		when {
			!r.ok -> fail(r.error)
			else -> {
				succeeded = true
				setMessageStatus(team, echoId, null)
			}
		}
	} catch (e: Exception) {
		// MUST be the first statement: classifyConnError must never see a CancellationException
		// (same discipline as the poll loop's own catch), and a swallowed cancel here would
		// mark this row "error" even though nothing actually failed - a cancelled attempt
		// leaves the row "pending" for reconcilePending to retry, not "error".
		e.rethrowIfCancellation()
		// Route through the same classifier the poll loop + connect use, so a send
		// surfaces a legible cause ("Can't reach the server", "Bridge token rejected")
		// instead of a raw "HTTP 401: {json}" exception string.
		val (cause, _) = classifyConnError(e)
		fail(cause)
	} finally {
		// Only on a non-success exit (fail() above, or a cancellation rethrow that skips fail()):
		// "Waking..." is a per-ATTEMPT indicator, so a cancelled cold-wake send must not strand it,
		// while a SUCCEEDED send's notice must be left alone (see the doc above). On the
		// cancellation path this runs while a CancellationException is actively propagating, so
		// nothing here may throw - a throw would replace the propagating cancel and silently defeat
		// reconcilePending's rollback (see its own catch below).
		if (!succeeded && raisedWakeNotice) _state.update { it.copy(wakingTeams = it.wakingTeams - team) }
	}
}

/** Re-admit the local attachment copies stored at first send. Admission stats rather than
 * reads, so a row too large for this device is refused here instead of dying at the encode. */
private fun ChatRepository.rebuildFiles(msg: Message): Pair<List<OutgoingFile>, Admission.Refused?> = rebuildFiles(msg.files)

/** Same rebuild, from a bare file-ref list - shared with a scheduled send's eagerly-copied
 * bucket, which has no Message row to rebuild from until the fire itself appends one. */
// internal (not private): that scheduled send's fire path is ScheduledSendOps.fireOne.
internal fun ChatRepository.rebuildFiles(files: List<MessageFile>): Pair<List<OutgoingFile>, Admission.Refused?> {
	val admitted = mutableListOf<OutgoingFile>()
	var blocker: Admission.Refused? = null
	for (a in OutgoingFiles.admitAll(files, filesDir)) {
		when (a) {
			is Admission.Granted -> admitted += a.file
			// A missing copy has always been survivable (send the rest, say so); a size refusal
			// is not, because sending "the rest" would silently drop what the user attached.
			is Admission.Refused ->
				if (a.reason == Admission.Reason.GONE) Unit else if (blocker == null) blocker = a
		}
	}
	return admitted to blocker
}

/**
 * Take a failed send back out of the thread and hand its content to the composer, so a message
 * that cannot be sent as-is can be edited instead of only retried or abandoned. The row is
 * dropped only once its content is staged for restore, so nothing is destroyed on the way.
 *
 * Attachment copies ride along into the same picker slot a fresh pick uses; any whose bytes are
 * already gone are simply absent, exactly as a retry treats them.
 */
fun ChatRepository.cancelFailedSend(team: String, messageId: Long) {
	val msg = _state.value.threads[team]?.firstOrNull { it.id == messageId } ?: return
	if (!msg.fromMe || msg.status != "error") return
	val refs = msg.files.filter { Attachments.fileFor(filesDir, it.src) != null }
	takeBackIntoDraft(team, msg.text, refs)
	removeMessage(team, messageId)
}

private fun ChatRepository.removeMessage(team: String, id: Long) {
	val threads = _state.updateAndGet { s ->
		val thread = s.threads[team] ?: return@updateAndGet s
		s.copy(threads = s.threads + (team to thread.filterNot { it.id == id }))
	}.threads
	persistence.persistThreads(threads)
}

private fun ChatRepository.setMessageStatus(team: String, id: Long, status: String?) {
	val threads = _state.updateAndGet { s ->
		val thread = s.threads[team] ?: return@updateAndGet s
		s.copy(threads = s.threads + (team to thread.map { if (it.id == id) it.copy(status = status) else it }))
	}.threads
	persistence.persistThreads(threads)
}

/** Stage picked Uris under one cumulative admission budget. Each is streamed to disk, never
 * held whole, and the first refusal is reported rather than silently dropping the file. */
// internal (not private): BoardOps.boardSetAttachmentsNow admits a board entry's newly picked
// files through this same budget.
internal fun ChatRepository.admitPicked(uris: List<Uri>, bucket: String): Pair<List<OutgoingFile>, Admission.Refused?> {
	val staged = mutableListOf<OutgoingFile>()
	val dir = File(Attachments.root(filesDir), bucket)
	var running = 0L
	for ((i, uri) in uris.withIndex()) {
		when (val a = OutgoingFiles.admit(contentResolver, uri, File(dir, "staged-$i"))) {
			is Admission.Refused -> {
				staged.forEach { it.source.delete() }
				return emptyList<OutgoingFile>() to a
			}
			is Admission.Granted -> {
				running += a.file.size
				if (running > ChatRepository.MAX_OUTGOING_BYTES) {
					staged.forEach { it.source.delete() }
					a.file.source.delete()
					return emptyList<OutgoingFile>() to
						Admission.Refused(a.file.name, Admission.Reason.OVER_TRANSPORT, running, ChatRepository.MAX_OUTGOING_BYTES)
				}
				staged += a.file
			}
		}
	}
	return staged to null
}

/** Re-deliver echoes stranded "pending" (process death, doze-killed socket)
 * once each, using their original opId: the gateway replays the cached result
 * if the send actually landed, so this can never double-deliver. A row whose
 * send never landed re-fails to the tap-to-retry badge. */
suspend fun ChatRepository.reconcilePending() = withContext(Dispatchers.IO) {
	// Board attachment transfers are stranded the same way and recover the same way: the queued
	// action survived, but the coroutine carrying its bytes did not.
	boardOps.resumeBoardUploads()
	// Unlike forgottenUntil's time-based self-expiry, a reconciled key's liveness is tied to
	// its message's own status: once a row leaves "pending" it can never be looked at again
	// (the loop below skips non-pending rows outright), so retaining only currently-pending
	// keys is a correct, unbounded-growth-free eviction - not just an approximation.
	val stillPending = _state.value.threads.flatMapTo(mutableSetOf()) { (team, msgs) ->
		msgs.filter { it.fromMe && it.status == "pending" }.map { "$team:${it.id}" }
	}
	reconciled.retainAll(stillPending)
	for ((team, msgs) in _state.value.threads) {
		for (m in msgs) {
			if (!m.fromMe || m.status != "pending") continue
			val key = "$team:${m.id}"
			if (!reconciled.add(key)) continue
			if (m.opId == null) {
				// Legacy row with no opId: cannot re-send safely; make it retriable.
				setMessageStatus(team, m.id, "error")
				continue
			}
			val (rebuilt, refusedRow) = rebuildFiles(m)
			if (refusedRow != null) {
				setMessageStatus(team, m.id, "error")
				DebugLog.log("Reconcile", "re-send of $key refused: ${refusedRow.reason}")
				continue
			}
			try {
				deliver(team, m.id, m.text, rebuilt, m.opId, false)
			} catch (e: CancellationException) {
				// The row is still genuinely "pending", not attempted-and-failed (the app
				// backgrounded mid-upload) - undo the reconciled mark or this delivery can never
				// be reconciled again, stranding the row for the rest of the process's life.
				reconciled.remove(key)
				throw e
			} catch (e: Throwable) {
				// deliver()'s own catch(Exception) settles every Exception via fail(), so what
				// lands here is an Error. Rethrowing would escape into a Main-dispatched scope as
				// an app-killing crash, and since the row stays "pending", every foreground would
				// repeat it: a crash LOOP from one bad row. Settle it as retriable and move on.
				setMessageStatus(team, m.id, "error")
				DebugLog.log("Reconcile", "re-send of $key failed non-retriably: $e")
			}
		}
	}
}
