package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/** How the Router answered an uploaded local record. */
enum class UploadOutcome {
	/** Taken, or already held. Either way the Router owns it now. */
	ACCEPTED,

	/** Not answered. The Router may or may not hold it. */
	UNANSWERED,

	REFUSED,
}

////////////////////////////////
//  Functions & Helpers

/**
 * Whether the local record may be released: its alarm cancelled and the record tombstoned.
 *
 * Only on acceptance. An unanswered upload may or may not have landed, and releasing on it would
 * lose the send whenever it had not; a refusal means the Router does not hold it at all. Both keep
 * the alarm armed, so the worst case is a send that fires locally rather than one that never fires.
 */
internal fun releasesLocal(outcome: UploadOutcome): Boolean = outcome == UploadOutcome.ACCEPTED

/**
 * The id a local record uploads under, taken FROM the record rather than minted per attempt.
 *
 * A fresh id per attempt would make each retry its own operation, so a record uploaded twice would
 * land twice. The Router answers the state it already holds for one it has seen.
 */
internal fun migrationOpId(record: ScheduledSend): String = record.opId

/** Records still worth uploading: everything the Router has not already accepted. */
internal fun pendingUploads(
	records: Map<String, ScheduledSend>,
	accepted: Set<String>,
): List<Pair<String, ScheduledSend>> = records.entries
	.filter { (_, record) -> migrationOpId(record) !in accepted }
	.map { (team, record) -> team to record }
	.sortedBy { (_, record) -> record.createdAt }
