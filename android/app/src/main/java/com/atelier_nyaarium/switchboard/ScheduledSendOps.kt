package com.atelier_nyaarium.switchboard

import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Sends banked to fire later: the record mutations, the single shared next-due alarm, and the fire
 * path that converts a due record into a live row. Owns the fire mutex and the two fields the
 * service wires in, which is why it is a held delegate rather than extensions the way the voice
 * settings and the drafts are. */
internal class ScheduledSendOps(private val repo: ChatRepository) {
	// Wired by the service, mirroring pushback's own scheduler seam.
	@Volatile var scheduledSendScheduler: ScheduledSendAlarmScheduler? = null

	// Serializes fireDueScheduledSends() so the cold-boot chain's own unconditional call and a
	// warm alarm-kick's call can never both convert the same due record into two duplicate rows -
	// the same double-fire shape DurableOpStore exists to close for send/respond, applied here at
	// the client layer instead. Ordinary schedule/cancel/edit mutations do NOT take this
	// lock (they are plain, fast, _state.update-only ops); only the fire path's check-then-convert
	// sequence needs the exclusion.
	private val scheduledSendFireMutex = Mutex()

	/** Set by the service: called when a scheduled send's bounded one-shot retry also fails, so the
	 * service (which owns NotificationManager) can post the failure notice. Mirrors
	 * [ChatRepository.onInbound]. */
	var onScheduledSendFailed: ((team: String, opId: String) -> Unit)? = null

	/** Bank `text`/`uris` as a scheduled send for `team`, firing at `fireAtMillis` on its own even if
	 * the app is backgrounded or killed in the meantime. Replaces any
	 * existing scheduled send for this team - the dock is the sole edit/reschedule surface, so a
	 * second `Schedule Send` on an already-scheduled team is a deliberate replace, not a queue. Any
	 * `content://` uri is eagerly copied into its own bucket now (a transient grant may not outlive
	 * the wait); `targetDomainId` is resolved now too, from the same live `teams` entry the composer
	 * has on screen - `deliver()`'s own internal resolution reads `state.teams`, empty on a cold fire
	 * until `connect()` completes, so re-deriving it at fire time would silently drop a cross-Domain
	 * target. Returns false (nothing banked) for a non-future time or oversized attachments.  */
	suspend fun scheduleSend(team: String, text: String, uris: List<Uri>, fireAtMillis: Long): Boolean =
		withContext(Dispatchers.IO) {
			val now = System.currentTimeMillis()
			if (fireAtMillis <= now) {
				// Reachable in practice, not just in theory: the dialog's own gate is evaluated once per
				// recomposition and never re-checked against a live clock while the user idles on the
				// picker - an error here (matching the oversized-attachment branch below) is the caller's
				// only signal that nothing was banked, since silently returning false with no error would
				// leave the user believing a send went out that never did.
				repo._state.update { it.copy(error = "That time has already passed - try scheduling again.") }
				return@withContext false
			}
			if (fireAtMillis - now > ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS) {
				repo._state.update { it.copy(error = "Can't schedule more than 30 days out.") }
				return@withContext false
			}
			val (picked, refused) = repo.admitPicked(uris, "pick-${java.util.UUID.randomUUID()}")
			if (refused != null) {
				repo._state.update { it.copy(error = refused.message()) }
				return@withContext false
			}
			val opId = java.util.UUID.randomUUID().toString()
			val fileRefs = Attachments.storeOutgoing(repo.filesDir, "sched-$opId", picked)
			val adminDomain = repo.confirmedDomainId()
			val canonical = repo.canonicalTarget(team)
			val targetDomainId = repo._state.value.teams
				.firstOrNull { it.name == canonical }
				?.domainId
				?.takeIf { it.isNotEmpty() && adminDomain != null && it != adminDomain }
			val rec = ScheduledSend(text, fileRefs, fireAtMillis, opId, targetDomainId, System.currentTimeMillis())
			val prior = repo._state.value.scheduledSends[team]
			val next = repo._state.updateAndGet { s -> s.copy(scheduledSends = s.scheduledSends + (team to rec)) }
				.scheduledSends
			repo.persistence.persistScheduledSends(next)
			rearmScheduledSendAlarm(next)
			// A replace's old bucket is now unreferenced - clean it up the same way forget() does,
			// never inline (best-effort, off the drain's scope, healed by the next sweepOrphanAttachments
			// if this misses its narrow scope-null window).
			prior?.let { repo.attachments.scheduleAttachmentDelete(it.fileRefs.mapNotNull { f -> f.src }) }
			true
		}

	/** Cancel team's scheduled send (if any): clears the record, re-arms the alarm to whatever is now
	 * earliest (or cancels it if nothing remains), and deletes the now-orphaned attachment bucket -
	 * UNLESS a fire already raced ahead of this cancel and claimed the same opId into a live thread
	 * row first (fireOne appends that row, deliberately, BEFORE it clears the record - see fireOne's
	 * own doc - so there is a real window where both the record and the row briefly coexist). This
	 * function is not mutex-guarded against fireOne (making it suspend to share scheduledSendFireMutex
	 * would ripple into every UI call site), so the two can genuinely interleave; the check below is
	 * what keeps that interleaving safe rather than deleting files a live row now depends on. */
	fun cancelScheduledSend(team: String) {
		val prior = clearScheduledSendRecord(team) ?: return
		val claimedByLiveRow = repo._state.value.threads[team]?.any { it.opId == prior.opId } == true
		if (!claimedByLiveRow) repo.attachments.scheduleAttachmentDelete(prior.fileRefs.mapNotNull { it.src })
	}

	/** Cancel team's scheduled send and hand its content back into the composer instead of deleting
	 * its attachment bucket - the dock's cancel-to-restore action, where the draft becomes the
	 * bucket's new owner (the same ownership-transfer shape as fireOne's own clearScheduledSendRecord
	 * call). A restored-then-abandoned bucket still self-heals: dropping the record from
	 * scheduledSends removes it from sweepOrphanAttachments' referenced set (the draft's own files
	 * join that set instead - see sweepOrphanAttachments), so the next cold-start sweep reclaims it
	 * exactly like any other orphaned bucket. A no-op if nothing was scheduled, or if a fire already
	 * raced ahead and claimed the same opId into a live row first (see cancelScheduledSend's own doc
	 * on that race) - there is nothing left to restore once the message has genuinely gone out. */
	fun cancelScheduledSendForEdit(team: String) {
		val prior = clearScheduledSendRecord(team) ?: return
		val claimedByLiveRow = repo._state.value.threads[team]?.any { it.opId == prior.opId } == true
		if (!claimedByLiveRow) repo.takeBackIntoDraft(team, prior.text, prior.fileRefs)
	}

	/** Change ONLY the fire time of team's existing scheduled send - the dock's tap-to-edit action.
	 * Deliberately narrower than a full text/attachment re-edit: the banked fileRefs are already-
	 * copied MessageFile refs, not the live content:// uris scheduleSend takes, so folding a fuller
	 * edit through that same call without a dedicated seam would risk silently dropping them. A
	 * plain time change has no such mismatch - text/fileRefs/opId/targetDomainId all carry over via
	 * copy(). Returns false (no-op) for a non-future time or if nothing is currently scheduled. */
	fun rescheduleSend(team: String, fireAtMillis: Long): Boolean {
		val now = System.currentTimeMillis()
		if (fireAtMillis <= now) {
			// Same reachable-in-practice race as scheduleSend's own past-time branch (the dialog's own
			// gate can go stale while the user idles on the picker) - the existing record is left with
			// its old time rather than destroyed, but the user still needs to know the pick did not
			// take effect.
			repo._state.update { it.copy(error = "That time has already passed - try scheduling again.") }
			return false
		}
		if (fireAtMillis - now > ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS) {
			repo._state.update { it.copy(error = "Can't schedule more than 30 days out.") }
			return false
		}
		val prior = repo._state.value.scheduledSends[team] ?: return false
		val next = repo._state.updateAndGet { s ->
			s.copy(scheduledSends = s.scheduledSends + (team to prior.copy(fireAtMillis = fireAtMillis)))
		}.scheduledSends
		repo.persistence.persistScheduledSends(next)
		rearmScheduledSendAlarm(next)
		return true
	}

	/** Remove team's scheduled-send record from state + persistence and re-arm the alarm, WITHOUT
	 * touching its attachment bucket - the fire path (below) transfers that bucket's ownership to a
	 * live thread row instead of orphaning it, so only the user-facing cancel/replace paths delete
	 * it. Returns the removed record (if any) so the caller decides. */
	private fun clearScheduledSendRecord(team: String): ScheduledSend? {
		val prior = repo._state.value.scheduledSends[team] ?: return null
		val next = repo._state.updateAndGet { s -> s.copy(scheduledSends = s.scheduledSends - team) }.scheduledSends
		repo.persistence.persistScheduledSends(next)
		rearmScheduledSendAlarm(next)
		return prior
	}

	/** Re-arm the single shared "next-due" alarm to the earliest fireAtMillis across every team's
	 * record, or cancel it once none remain. Called after every mutation to scheduledSends. */
	private fun rearmScheduledSendAlarm(current: Map<String, ScheduledSend> = repo._state.value.scheduledSends) {
		val next = current.values.minOfOrNull { it.fireAtMillis }
		if (next != null) scheduledSendScheduler?.scheduleNext(next) else scheduledSendScheduler?.cancelNext()
	}

	/** Bounded wait for the service to finish wiring [scheduledSendScheduler] (and
	 * [onScheduledSendFailed]) via SwitchboardService.onCreate's own synchronous
	 * `repo.scheduled.scheduledSendScheduler = this` line. Only the WARM kicks below need this: a
	 * dead-process revival's alarm receiver calls SwitchboardService.start(context) - which only
	 * REQUESTS an async service start; onCreate() itself runs later on the main thread - and then, in
	 * the same onReceive call, kicks straight into the repo scope, which has no dependency on onCreate having
	 * run at all. Without this wait, a fire that fails (or a retry that fails) in that narrow window
	 * would find scheduledSendScheduler/onScheduledSendFailed still null and silently skip arming the
	 * retry or posting the failure notification - the one thing this feature promises never to do
	 * silently. The cold-boot chain's own direct fireDueScheduledSends() call never needs this: it
	 * runs later in the SAME onCreate() that already set scheduledSendScheduler synchronously,
	 * earlier in that function. Gives up after a bounded wait rather than forever - an unprovisioned
	 * device's onCreate() calls stopSelf() immediately and never wires anything, and this must not
	 * leak a coroutine on repoScope forever in that case; proceeding anyway after the deadline just
	 * means scheduleRetry/onScheduledSendFailed stay no-ops for this one attempt, same as today. */
	private suspend fun awaitSchedulerWired() {
		val deadline = System.currentTimeMillis() + ChatRepository.SCHEDULER_WIRE_WAIT_MS
		while (scheduledSendScheduler == null && System.currentTimeMillis() < deadline) delay(50)
	}

	/** Entry point for a WARM alarm kick - a BroadcastReceiver cannot suspend, so this launches on
	 * the repo scope (always available, unlike the drain's own scope) rather than awaiting inline. The cold-boot
	 * chain instead awaits [fireDueScheduledSends] directly as its own unconditional step (see
	 * SwitchboardService.onCreate). Both funnel through the same mutex-guarded function, so a warm
	 * kick can never double-convert the same due record with a concurrent cold-chain call - but the
	 * mutex alone does NOT guarantee the warm kick waits for connect() to have run first (see
	 * awaitSchedulerWired's own doc for why). That residual ordering gap is accepted rather than
	 * more heavily engineered around. */
	fun kickScheduledSendFire() {
		repo.repoScope.launch {
			awaitSchedulerWired()
			fireDueScheduledSends()
		}
	}

	/** Convert every currently-due scheduled send into a live, delivered (or delivering) row, then
	 * re-arm the alarm to whatever is next. Safe to call with nothing due - the cold-boot chain calls
	 * this unconditionally on every start (connect() swallows its own failures internally and must
	 * not gate this, or an offline cold fire would never reach deliver()'s failure path and the
	 * bounded-retry policy below would never trigger). */
	suspend fun fireDueScheduledSends() = scheduledSendFireMutex.withLock {
		while (true) {
			val now = System.currentTimeMillis()
			val due = repo._state.value.scheduledSends.entries.firstOrNull { it.value.fireAtMillis <= now } ?: break
			fireOne(due.key, due.value)
		}
		rearmScheduledSendAlarm()
	}

	/** Convert one due record into a row and attempt delivery. Idempotent against a crash between
	 * appending the row and clearing the record: a re-arm that finds the row already present (by
	 * opId - persisted per row, so this check survives restarts) treats it as already-fired and only
	 * finishes the clear, never re-appending or re-delivering. */
	private suspend fun fireOne(team: String, rec: ScheduledSend) {
		val alreadyFired = repo._state.value.threads[team]?.any { it.opId == rec.opId } == true
		if (!alreadyFired) {
			val echoId = repo.append(
				team,
				Message(true, rec.text, System.currentTimeMillis(), files = rec.fileRefs, status = "pending", opId = rec.opId),
			)
			// clearScheduledSendRecord, not cancelScheduledSend: the bucket's ownership just
			// transferred to the row above, so deleting it here would strand that row's attachments.
			clearScheduledSendRecord(team)
			val (picked, _) = repo.rebuildFiles(rec.fileRefs)
			repo.deliver(team, echoId, rec.text, picked, rec.opId, false, rec.targetDomainId)
			if (repo._state.value.threads[team]?.firstOrNull { it.opId == rec.opId }?.status == "error") {
				val at = System.currentTimeMillis() + ChatRepository.SCHEDULED_SEND_RETRY_DELAY_MS
				scheduledSendScheduler?.scheduleRetry(at, team, rec.opId, rec.targetDomainId)
			}
		} else {
			clearScheduledSendRecord(team)
		}
		// Sending is a strong signal of imminent live interaction - the same nudge onForeground()
		// gives the idle-pushback ladder, without foreground's other side effects (this may well be
		// firing while genuinely backgrounded).
		repo.pushback.onCommsActivity(System.currentTimeMillis(), repo.isVisible)
	}

	/** The warm alarm kick for one team's bounded one-shot retry after a failed fire (see [fireOne]).
	 * Resolves the row fresh by opId, never by a banked Message.id - ids are reassigned densely on
	 * every load, so an id banked in the retry alarm's PendingIntent would go stale across a process
	 * death between arming and firing. A row not found in "error" state (already retried by hand,
	 * forgotten, or - defensively - still pending) is left alone; posts the failure notification only
	 * if THIS retry also fails, never on the happy path. */
	fun kickScheduledSendRetry(team: String, opId: String, targetDomainId: String?) {
		repo.repoScope.launch {
			awaitSchedulerWired()
			val id = repo._state.value.threads[team]?.firstOrNull { it.opId == opId && it.status == "error" }?.id
				?: return@launch
			repo.retrySend(team, id, targetDomainId)
			if (repo._state.value.threads[team]?.firstOrNull { it.opId == opId }?.status == "error") {
				onScheduledSendFailed?.invoke(team, opId)
			}
		}
	}
}
