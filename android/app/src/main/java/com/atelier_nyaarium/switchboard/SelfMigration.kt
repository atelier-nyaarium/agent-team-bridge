package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.scheduledBodyAadKind
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.ScheduleSendValue
import com.atelier_nyaarium.switchboard.proto.ScheduledTarget
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

/** How the Router answered an uploaded local record. */
enum class UploadOutcome {
	/** Router owns the record. */
	ACCEPTED,

	/** No Router answer; retry on the next welcome. */
	UNANSWERED,

	REFUSED,
}

/** Release only after acceptance. */
internal fun releasesLocal(outcome: UploadOutcome): Boolean = outcome == UploadOutcome.ACCEPTED

/** Preserve the record's operation id. */
internal fun migrationOpId(record: ScheduledSend): String = record.opId

/** Records not yet accepted. */
internal fun pendingUploads(
	records: Map<String, ScheduledSend>,
	accepted: Set<String>,
): List<Pair<String, ScheduledSend>> = records.entries
	.filter { (_, record) -> migrationOpId(record) !in accepted }
	.map { (team, record) -> team to record }
	.sortedBy { (_, record) -> record.createdAt }

internal class SelfMigration(
	private val records: () -> Map<String, ScheduledSend>,
	private val readAnchors: () -> Map<String, ReadAnchor>,
	private val journal: MutationJournal,
	private val domainId: () -> String,
	private val ownerSignPub: () -> String,
	private val conversationId: () -> String,
	private val contentKeyring: () -> ContentKeyring,
	private val target: (String, ScheduledSend) -> ScheduledTarget,
	private val uploadFile: suspend (MessageFile) -> String,
	private val sign: (JsonObject, String) -> OwnerOp?,
	private val send: suspend (OwnerOp) -> JsonElement?,
	private val acceptedUploads: () -> Set<String> = { emptySet() },
	private val reportRead: suspend (String, ReadAnchor) -> JsonElement?,
	private val releaseLocal: suspend (String, String) -> Boolean,
	private val reportError: (String) -> Unit = {},
) {
	private val runMutex = Mutex()

	suspend fun run(migrationEpoch: Long) = runMutex.withLock {
		runOnce(migrationEpoch)
	}

	private suspend fun runOnce(migrationEpoch: Long) {
		if (migrationEpoch == 0L || journal.entries("self_migration").any { it.payload.optLong("migrationEpoch", 0L) == migrationEpoch }) return
		var complete = true
		val refused = journal.entries("scheduled_send").filter { it.state == MutationState.REFUSED }.map { it.opId }.toSet()
		for ((team, record) in pendingUploads(records(), acceptedUploads() + refused)) {
			val outcome = upload(team, record)
			if (releasesLocal(outcome)) {
				releaseLocal(team, record.opId)
			} else complete = false
		}
		for ((team, anchor) in readAnchors()) {
			if (!accepted(reportRead(team, anchor))) complete = false
		}
		if (complete) journal.append(
			"self-migration-$migrationEpoch",
			"self_migration",
			JSONObject().put("migrationEpoch", migrationEpoch),
		)
	}

	private fun accepted(answer: JsonElement?): Boolean = answer?.let {
		it.jsonObject["outcome"]?.jsonPrimitive?.content == "accepted"
	} == true

	private suspend fun upload(team: String, record: ScheduledSend): UploadOutcome {
		val epoch = contentKeyring().epochs().maxOrNull() ?: return UploadOutcome.UNANSWERED
		val key = contentKeyring().keyFor(epoch) ?: return UploadOutcome.UNANSWERED
		val files = runCatching { record.fileRefs.map { uploadFile(it) } }.getOrElse {
			reportError("Scheduled send ${record.opId} files could not be uploaded")
			return UploadOutcome.UNANSWERED
		}
		val manifest = JSONArray().also { array -> record.fileRefs.forEach { array.put(fileJson(it)) } }
		val plaintext = JSONObject()
			.put("text", record.text)
			.put("files", manifest)
			.put("messageId", record.opId)
		val body: ContentEnvelope = Crypto.sealContent(
			plaintext.toString().toByteArray(Charsets.UTF_8),
			key,
			Crypto.ContentAad(domainId(), ownerSignPub(), epoch, scheduledBodyAadKind(conversationId(), record.opId)),
		)
		val value = ScheduleSendValue(
			target = target(team, record),
			fireAt = record.fireAtMillis,
			opId = migrationOpId(record),
			files = files,
			body = body,
		)
		val opId = migrationOpId(record)
		if (journal.entries("scheduled_send").none { it.opId == opId })
			journal.append(opId, "scheduled_send", JSONObject().put("team", team).put("opId", opId))
		val answer = send(sign(wireJson.encodeToJsonElement(ScheduleSendValue.serializer(), value).jsonObject, opId) ?: return UploadOutcome.UNANSWERED)
		val outcome = answer?.jsonObject?.get("outcome")?.jsonPrimitive?.content
		return when (outcome) {
			"accepted" -> {
				journal.transition(opId, MutationState.ACKED)
				UploadOutcome.ACCEPTED
			}
			Protocol.Wire.SocketFrame.REFUSED, "conflict" -> {
				journal.transition(opId, MutationState.REFUSED)
				reportError("Scheduled send $opId was refused")
				UploadOutcome.REFUSED
			}
			else -> UploadOutcome.UNANSWERED
		}
	}
}
