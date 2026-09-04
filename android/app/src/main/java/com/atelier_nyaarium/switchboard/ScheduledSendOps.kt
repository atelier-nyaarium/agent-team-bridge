package com.atelier_nyaarium.switchboard

import android.net.Uri
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
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
internal interface ScheduledSendOpsCollaborators {
	fun admitPicked(uris: List<Uri>, bucket: String): Pair<List<OutgoingFile>, Admission.Refused?>
	fun canonicalTarget(team: String): String
	fun scheduleAttachmentDelete(srcs: List<String>)
	fun takeBackIntoDraft(team: String, text: String, files: List<MessageFile>)
	fun append(team: String, message: Message): Long
	fun rebuildFiles(files: List<MessageFile>): Pair<List<OutgoingFile>, Admission.Refused?>
	suspend fun deliver(team: String, echoId: Long, text: String, files: List<OutgoingFile>, opId: String, targetDomainId: String?)
	suspend fun retrySend(team: String, messageId: Long, targetDomainId: String?)
}

internal class ScheduledSendOps(
	private val state: MutableStateFlow<ChatState>,
	private val persistence: ChatPersistence,
	private val filesDir: File,
	private val repoScope: CoroutineScope,
	private val mutationJournal: MutationJournal,
	private val identity: IdentityPort,
	private val pushback: IdlePushbackManager,
	private val isVisible: () -> Boolean,
	private val collaborators: ScheduledSendOpsCollaborators,
) {
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
				state.update { it.copy(error = "That time has already passed - try scheduling again.") }
				return@withContext false
			}
			if (fireAtMillis - now > ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS) {
				state.update { it.copy(error = "Can't schedule more than 30 days out.") }
				return@withContext false
			}
			val (picked, refused) = collaborators.admitPicked(uris, "pick-${java.util.UUID.randomUUID()}")
			if (refused != null) {
				state.update { it.copy(error = refused.message()) }
				return@withContext false
			}
			val opId = java.util.UUID.randomUUID().toString()
			val fileRefs = Attachments.storeOutgoing(filesDir, "sched-$opId", picked)
			val adminDomain = identity.readyOrNull()?.domainId
			val canonical = collaborators.canonicalTarget(team)
			val targetDomainId = state.value.teams
				.firstOrNull { it.name == canonical }
				?.domainId
				?.takeIf { it.isNotEmpty() && adminDomain != null && it != adminDomain }
			val rec = ScheduledSend(text, fileRefs, fireAtMillis, opId, targetDomainId, System.currentTimeMillis())
			val prior = state.value.scheduledSends[team]
			val next = state.updateAndGet { s -> s.copy(scheduledSends = s.scheduledSends + (team to rec)) }
				.scheduledSends
			persistence.persistScheduledSends(next)
			rearmScheduledSendAlarm(next)
			// Delete replaced attachments asynchronously.
			prior?.let { collaborators.scheduleAttachmentDelete(it.fileRefs.mapNotNull { f -> f.src }) }
			true
		}

	/** Cancels the team's scheduled send and removes unclaimed attachments. */
	fun cancelScheduledSend(team: String) {
		val prior = clearScheduledSendRecord(team) ?: return
		val claimedByLiveRow = state.value.threads[team]?.any { it.opId == prior.opId } == true
		if (!claimedByLiveRow) collaborators.scheduleAttachmentDelete(prior.fileRefs.mapNotNull { it.src })
	}

	/** Cancels and restores the team's scheduled send. */
	fun cancelScheduledSendForEdit(team: String) {
		val prior = clearScheduledSendRecord(team) ?: return
		val claimedByLiveRow = state.value.threads[team]?.any { it.opId == prior.opId } == true
		if (!claimedByLiveRow) collaborators.takeBackIntoDraft(team, prior.text, prior.fileRefs)
	}

	/** Changes only the team's scheduled fire time. */
	fun rescheduleSend(team: String, fireAtMillis: Long): Boolean {
		val now = System.currentTimeMillis()
		if (fireAtMillis <= now) {
			state.update { it.copy(error = "That time has already passed - try scheduling again.") }
			return false
		}
		if (fireAtMillis - now > ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS) {
			state.update { it.copy(error = "Can't schedule more than 30 days out.") }
			return false
		}
		val prior = state.value.scheduledSends[team] ?: return false
		val next = state.updateAndGet { s ->
			s.copy(scheduledSends = s.scheduledSends + (team to prior.copy(fireAtMillis = fireAtMillis)))
		}.scheduledSends
		persistence.persistScheduledSends(next)
		rearmScheduledSendAlarm(next)
		return true
	}

	/** Removes the record without deleting its attachments. */
	private fun clearScheduledSendRecord(team: String): ScheduledSend? {
		val prior = state.value.scheduledSends[team] ?: return null
		val next = state.updateAndGet { s -> s.copy(scheduledSends = s.scheduledSends - team) }.scheduledSends
		persistence.persistScheduledSends(next)
		mutationJournal.remove(prior.opId)
		rearmScheduledSendAlarm(next)
		return prior
	}

	/** Arms the next due send. */
	private fun rearmScheduledSendAlarm(current: Map<String, ScheduledSend> = state.value.scheduledSends) {
		val next = current.values.minOfOrNull { it.fireAtMillis }
		if (next != null) scheduledSendScheduler?.scheduleNext(next) else scheduledSendScheduler?.cancelNext()
	}

	internal fun rearmAfterMigration() = rearmScheduledSendAlarm()

	internal suspend fun releaseMigrated(team: String, opId: String, cancelAlarm: (String) -> Unit, tombstone: (String) -> Unit): Boolean =
		scheduledSendFireMutex.withLock {
			if (state.value.scheduledSends[team]?.opId != opId) return@withLock false
			cancelAlarm(team)
			tombstone(team)
			mutationJournal.remove(opId)
			true
		}

	/** Waits briefly for service wiring. */
	private suspend fun awaitSchedulerWired() {
		val deadline = System.currentTimeMillis() + ChatRepository.SCHEDULER_WIRE_WAIT_MS
		while (scheduledSendScheduler == null && System.currentTimeMillis() < deadline) delay(50)
	}

	/** Starts firing from an alarm callback. */
	fun kickScheduledSendFire() {
		repoScope.launch {
			awaitSchedulerWired()
			fireDueScheduledSends()
		}
	}

	/** Fires all due scheduled sends. */
	suspend fun fireDueScheduledSends(): List<ScheduledSendFireFailure> = scheduledSendFireMutex.withLock {
		val failures = mutableListOf<ScheduledSendFireFailure>()
		while (true) {
			val now = System.currentTimeMillis()
			val due = state.value.scheduledSends.entries.firstOrNull { it.value.fireAtMillis <= now } ?: break
			fireOne(due.key, due.value)?.let { failures += it }
		}
		rearmScheduledSendAlarm()
		failures
	}

	/** Fires one record idempotently by opId. */
	private suspend fun fireOne(team: String, rec: ScheduledSend): ScheduledSendFireFailure? {
		if (state.value.scheduledSends[team]?.opId != rec.opId) return null
		val alreadyFired = state.value.threads[team]?.any { it.opId == rec.opId } == true
		if (!alreadyFired) {
			val plan = composeScheduledSend(rec, System.currentTimeMillis())
			val echoId = collaborators.append(team, plan.echo)
				// The live row now owns these attachments.
				clearScheduledSendRecord(team)
			val (picked, _) = collaborators.rebuildFiles(plan.fileRefs)
			collaborators.deliver(team, echoId, plan.text, picked, plan.opId, plan.targetDomainId)
			if (state.value.threads[team]?.firstOrNull { it.opId == rec.opId }?.status == "error") {
						// Journal failures beyond the alarm retry.
						val journaled = journalPendingSend(team, rec)
					val at = System.currentTimeMillis() + ChatRepository.SCHEDULED_SEND_RETRY_DELAY_MS
					scheduledSendScheduler?.scheduleRetry(at, team, rec.opId, rec.targetDomainId)
					if (!scheduledSendJournalDecision(journaled)) return ScheduledSendFireFailure(rec.opId)
			}
		} else {
			clearScheduledSendRecord(team)
		}
		pushback.onCommsActivity(System.currentTimeMillis(), isVisible())
		return null
	}

	/** Retries a failed send by opId. */
	fun kickScheduledSendRetry(team: String, opId: String, targetDomainId: String?) {
		repoScope.launch {
			awaitSchedulerWired()
			val id = state.value.threads[team]?.firstOrNull { it.opId == opId && it.status == "error" }?.id
				?: return@launch
			collaborators.retrySend(team, id, targetDomainId)
			if (state.value.threads[team]?.firstOrNull { it.opId == opId }?.status == "error") {
				onScheduledSendFailed?.invoke(team, opId)
			} else {
				retireJournaledSend(opId)
			}
		}
	}

	/** Journals failed sends by opId. */
	private fun journalPendingSend(team: String, rec: ScheduledSend): Boolean {
		return runCatching {
			mutationJournal.append(
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
		runCatching { mutationJournal.transition(opId, MutationState.ACKED) }
	}

	/** Replays journaled failed sends. */
	suspend fun replayJournaledSends() {
		for (entry in runCatching { mutationJournal.claimForReplay() }.getOrDefault(emptyList())) {
			if (entry.kind != "scheduled_send") continue
			val team = entry.payload.optString("team").takeIf { it.isNotEmpty() } ?: continue
			val opId = entry.payload.optString("opId").takeIf { it.isNotEmpty() } ?: continue
			val row = state.value.threads[team]?.firstOrNull { it.opId == opId }
			if (row == null || row.status != "error") {
				retireJournaledSend(opId)
				continue
			}
			collaborators.retrySend(team, row.id, entry.payload.optString("domainId").takeIf { it.isNotEmpty() })
			if (state.value.threads[team]?.firstOrNull { it.opId == opId }?.status != "error") {
				retireJournaledSend(opId)
			}
		}
	}
}
