package com.atelier_nyaarium.switchboard.proto

/**
 * The phone's mailbox CONSUMPTION cursor: the epoch, the acked sequence, and the
 * dropped-gap baseline, plus the transition rules (epoch flip, dedupe, gap delta,
 * fresh-set). The cursor is phone-OWNED and persisted (see MailboxSync); the arbiter
 * never dictates it.
 *
 * Hand-authored twin of src/shared/sync-cursor.ts, kept equivalent by the shared vectors
 * in tests/fixtures/sync-cursor/vectors.json (read by both runtimes). advance() is PURE:
 * the caller renders + persists threads first, then commits the cursor last, so a crash
 * between the two re-delivers (dedupe absorbs) rather than skips. See the TS file and
 * plans/mailbox-sync-contract.md for the design rationale.
 */

/** A drained mailbox entry, reduced to the only field the cursor rules need. */
interface SyncEntry {
	val seq: Long
}

/** A poll result as the cursor rules see it. */
data class SyncPollResult<E : SyncEntry>(
	val entries: List<E>,
	val cursor: Long,
	val epoch: Long,
	val dropped: Long,
)

/** The poll-op params the cursor produces; the ONLY producer. */
data class PollParams(val cursor: Long, val epoch: Long)

/** The outcome of folding a poll result into the cursor. */
data class SyncAdvance<E : SyncEntry>(
	val next: SyncCursor,
	val fresh: List<E>,
	val gap: Boolean,
)

class SyncCursor private constructor(
	val epoch: Long,
	val ackedSeq: Long,
	val droppedBaseline: Long,
) {
	companion object {
		/** The initial cursor for a never-synced device. Epoch 0 is a reserved sentinel
		 * the arbiter never mints, so the first poll against any real box always flips. */
		fun initial() = SyncCursor(0, 0, 0)

		fun of(epoch: Long, ackedSeq: Long, droppedBaseline: Long) = SyncCursor(epoch, ackedSeq, droppedBaseline)
	}

	val pollParams: PollParams get() = PollParams(ackedSeq, epoch)

	/** Fold a poll result into the next cursor. Epoch flip = a new box instance: reset
	 * ack to the result's high-water, all entries fresh, gap false. Same epoch: fresh =
	 * entries with seq > ackedSeq (dedupe), advance ack, gap iff dropped grew past the
	 * baseline (delta, not level). PURE - no persistence. */
	fun <E : SyncEntry> advance(result: SyncPollResult<E>): SyncAdvance<E> {
		if (result.epoch != epoch) {
			return SyncAdvance(SyncCursor(result.epoch, result.cursor, result.dropped), result.entries.toList(), false)
		}
		val fresh = result.entries.filter { it.seq > ackedSeq }
		val gap = result.dropped > droppedBaseline
		return SyncAdvance(SyncCursor(epoch, result.cursor, result.dropped), fresh, gap)
	}

	override fun equals(other: Any?): Boolean =
		other is SyncCursor &&
			epoch == other.epoch &&
			ackedSeq == other.ackedSeq &&
			droppedBaseline == other.droppedBaseline

	override fun hashCode(): Int = (31L * (31L * epoch + ackedSeq) + droppedBaseline).toInt()
}
