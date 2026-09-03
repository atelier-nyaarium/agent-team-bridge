package com.atelier_nyaarium.switchboard

/** How the Router answered an uploaded local record. */
enum class UploadOutcome {
	/** Router owns the record. */
	ACCEPTED,

	/** Router ownership is unknown. */
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
