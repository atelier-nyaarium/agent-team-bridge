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
import org.json.JSONObject

internal data class ScheduledSendFireFailure(val opId: String)

internal fun scheduledSendJournalDecision(committed: Boolean): Boolean = committed

/** Scheduled-send state and firing. */
internal class ScheduledSendOps(private val repo: ChatRepository) {
	@Volatile var scheduledSendScheduler: ScheduledSendAlarmScheduler? = null

	// Guards single-fire conversion.
	private val scheduledSendFireMutex = Mutex()

	/** Called after retry failure. */
	var onScheduledSendFailed: ((team: String, opId: String) -> Unit)? = null

	/** Banks a scheduled send, replacing the team's existing record. */
	suspend fun scheduleSend(team: String, text: String, uris: List<Uri>, fireAtMillis: Long): Boolean =
		withContext(Dispatchers.IO) {
			val now = System.currentTimeMillis()
			if (fireAtMillis <= now) {
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
			// Delete replaced attachments asynchronously.
			prior?.let { repo.attachments.scheduleAttachmentDelete(it.fileRefs.mapNotNull { f -> f.src }) }
			true
		}

	/** Cancels the team's scheduled send and removes unclaimed attachments. */
	fun cancelScheduledSend(team: String) {
		val prior = clearScheduledSendRecord(team) ?: return
		val claimedByLiveRow = repo._state.value.threads[team]?.any { it.opId == prior.opId } == true
		if (!claimedByLiveRow) repo.attachments.scheduleAttachmentDelete(prior.fileRefs.mapNotNull { it.src })
	}

	/** Cancels and restores the team's scheduled send. */
	fun cancelScheduledSendForEdit(team: String) {
		val prior = clearScheduledSendRecord(team) ?: return
		val claimedByLiveRow = repo._state.value.threads[team]?.any { it.opId == prior.opId } == true
		if (!claimedByLiveRow) repo.takeBackIntoDraft(team, prior.text, prior.fileRefs)
	}

	/** Changes only the team's scheduled fire time. */
	fun rescheduleSend(team: String, fireAtMillis: Long): Boolean {
		val now = System.currentTimeMillis()
		if (fireAtMillis <= now) {
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

	/** Removes the record without deleting its attachments. */
	private fun clearScheduledSendRecord(team: String): ScheduledSend? {
		val prior = repo._state.value.scheduledSends[team] ?: return null
		val next = repo._state.updateAndGet { s -> s.copy(scheduledSends = s.scheduledSends - team) }.scheduledSends
		repo.persistence.persistScheduledSends(next)
		rearmScheduledSendAlarm(next)
		return prior
	}

	/** Arms the next due send. */
	private fun rearmScheduledSendAlarm(current: Map<String, ScheduledSend> = repo._state.value.scheduledSends) {
		val next = current.values.minOfOrNull { it.fireAtMillis }
		if (next != null) scheduledSendScheduler?.scheduleNext(next) else scheduledSendScheduler?.cancelNext()
	}

	/** Waits briefly for service wiring. */
	private suspend fun awaitSchedulerWired() {
		val deadline = System.currentTimeMillis() + ChatRepository.SCHEDULER_WIRE_WAIT_MS
		while (scheduledSendScheduler == null && System.currentTimeMillis() < deadline) delay(50)
	}

	/** Starts firing from an alarm callback. */
	fun kickScheduledSendFire() {
		repo.repoScope.launch {
			awaitSchedulerWired()
			fireDueScheduledSends()
		}
	}

	/** Fires all due scheduled sends. */
	suspend fun fireDueScheduledSends(): List<ScheduledSendFireFailure> = scheduledSendFireMutex.withLock {
		val failures = mutableListOf<ScheduledSendFireFailure>()
		while (true) {
			val now = System.currentTimeMillis()
			val due = repo._state.value.scheduledSends.entries.firstOrNull { it.value.fireAtMillis <= now } ?: break
			fireOne(due.key, due.value)?.let { failures += it }
		}
		rearmScheduledSendAlarm()
		failures
	}

	/** Fires one record idempotently by opId. */
	private suspend fun fireOne(team: String, rec: ScheduledSend): ScheduledSendFireFailure? {
		val alreadyFired = repo._state.value.threads[team]?.any { it.opId == rec.opId } == true
		if (!alreadyFired) {
			val echoId = repo.append(
				team,
				Message(true, rec.text, System.currentTimeMillis(), files = rec.fileRefs, status = "pending", opId = rec.opId),
			)
			// The live row now owns these attachments.
			clearScheduledSendRecord(team)
			val (picked, _) = repo.rebuildFiles(rec.fileRefs)
			repo.deliver(team, echoId, rec.text, picked, rec.opId, false, rec.targetDomainId)
			if (repo._state.value.threads[team]?.firstOrNull { it.opId == rec.opId }?.status == "error") {
				// Journal failures beyond the alarm retry.
					val journaled = journalPendingSend(team, rec)
					val at = System.currentTimeMillis() + ChatRepository.SCHEDULED_SEND_RETRY_DELAY_MS
					scheduledSendScheduler?.scheduleRetry(at, team, rec.opId, rec.targetDomainId)
					if (!scheduledSendJournalDecision(journaled)) return ScheduledSendFireFailure(rec.opId)
			}
		} else {
			clearScheduledSendRecord(team)
		}
		repo.pushback.onCommsActivity(System.currentTimeMillis(), repo.isVisible)
		return null
	}

	/** Retries a failed send by opId. */
	fun kickScheduledSendRetry(team: String, opId: String, targetDomainId: String?) {
		repo.repoScope.launch {
			awaitSchedulerWired()
			val id = repo._state.value.threads[team]?.firstOrNull { it.opId == opId && it.status == "error" }?.id
				?: return@launch
			repo.retrySend(team, id, targetDomainId)
			if (repo._state.value.threads[team]?.firstOrNull { it.opId == opId }?.status == "error") {
				onScheduledSendFailed?.invoke(team, opId)
			} else {
				retireJournaledSend(opId)
			}
		}
	}

	/** Journals failed sends by opId. */
	private fun journalPendingSend(team: String, rec: ScheduledSend): Boolean {
		return runCatching {
			repo.mutationJournal.append(
				rec.opId,
				"scheduled_send",
				JSONObject().put("team", team).put("opId", rec.opId).put("domainId", rec.targetDomainId),
			)
		}.onFailure {
			DebugLog.log(
				"ScheduledSend",
				"journal append failed for ${rec.opId}: ${it.javaClass.simpleName}: ${it.message}",
			)
		}.isSuccess
	}

	private fun retireJournaledSend(opId: String) {
		runCatching { repo.mutationJournal.transition(opId, MutationState.ACKED) }
	}

	/** Replays journaled failed sends. */
	suspend fun replayJournaledSends() {
		for (entry in runCatching { repo.mutationJournal.claimForReplay() }.getOrDefault(emptyList())) {
			if (entry.kind != "scheduled_send") continue
			val team = entry.payload.optString("team").takeIf { it.isNotEmpty() } ?: continue
			val opId = entry.payload.optString("opId").takeIf { it.isNotEmpty() } ?: continue
			val row = repo._state.value.threads[team]?.firstOrNull { it.opId == opId }
			if (row == null || row.status != "error") {
				retireJournaledSend(opId)
				continue
			}
			repo.retrySend(team, row.id, entry.payload.optString("domainId").takeIf { it.isNotEmpty() })
			if (repo._state.value.threads[team]?.firstOrNull { it.opId == opId }?.status != "error") {
				retireJournaledSend(opId)
			}
		}
	}
}
