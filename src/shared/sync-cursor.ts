////////////////////////////////
//  Mailbox sync cursor value object
//
//  The single owner of the console's mailbox CONSUMPTION state: the epoch, the acked
//  sequence, and the dropped-gap baseline. It owns the TRANSITION RULES (how a poll
//  result advances the cursor, how an epoch flip resets it, which entries are genuinely
//  fresh, whether a gap opened) so the two runtimes (this gateway-side TS and the console's
//  Kotlin twin) cannot disagree about consumption the way they disagreed about the
//  address before SessionId.
//
//  Invariant: the cursor is CONSOLE-OWNED and DURABLE. The gateway never dictates it; the
//  gateway's register returns the epoch + an informational high-water only, and the console
//  keeps its own cursor across restarts (MailboxSync, console side). advance() is PURE - the
//  console renders and persists threads FIRST, then commits the cursor LAST, so a crash
//  between the two re-delivers (dedupe absorbs) rather than skips (red-team F1).
//
//  The Kotlin twin lives at android/.../proto/SyncCursor.kt; the two are held equivalent
//  by the shared vectors in tests/fixtures/sync-cursor/vectors.json, read by both runtimes.

////////////////////////////////
//  Interfaces & Types

/** A drained mailbox entry, reduced to the only field the cursor rules need. */
export interface SyncEntry {
	seq: number;
}

/** A poll result as the cursor rules see it: the entries returned, the box's current
 *  high-water (the new ack target), the box's epoch, and its cumulative dropped count. */
export interface SyncPollResult<E extends SyncEntry = SyncEntry> {
	entries: E[];
	cursor: number;
	epoch: number;
	dropped: number;
}

/** The outcome of folding a poll result into the cursor. */
export interface SyncAdvance<E extends SyncEntry = SyncEntry> {
	next: SyncCursor;
	fresh: E[];
	gap: boolean;
}

/** The poll-op params the cursor produces; the ONLY producer, so the console cannot
 *  hand-build a {cursor, epoch} pair. */
export interface PollParams {
	cursor: number;
	epoch: number;
}

////////////////////////////////
//  Class

export class SyncCursor {
	private constructor(
		readonly epoch: number,
		readonly ackedSeq: number,
		readonly droppedBaseline: number,
	) {}

	/** The initial cursor for a never-synced device. Epoch 0 is a reserved sentinel the
	 *  gateway never mints (mintEpoch's range is [1, 2^31-1]), so the first poll against
	 *  any real box always flips, resetting cleanly. */
	static initial(): SyncCursor {
		return new SyncCursor(0, 0, 0);
	}

	static of(epoch: number, ackedSeq: number, droppedBaseline: number): SyncCursor {
		return new SyncCursor(epoch, ackedSeq, droppedBaseline);
	}

	/** The ONLY producer of poll-op params. */
	get pollParams(): PollParams {
		return { cursor: this.ackedSeq, epoch: this.epoch };
	}

	/**
	 * Fold a poll result into the next cursor, returning the genuinely-fresh entries and
	 * whether a real gap opened. PURE: no persistence (the caller commits next AFTER the
	 * entries are durable).
	 *
	 * Epoch flip (result.epoch != epoch): the box is a NEW instance - gateway eviction
	 * destroyed the old entries before minting the new epoch, so every entry is genuinely
	 * new content. Reset ackedSeq to the result's high-water, baseline to the result's
	 * dropped, and treat all entries as fresh; a fresh instance has no prior baseline so
	 * gap is false (red-team F2).
	 *
	 * Same epoch: fresh = entries with seq > ackedSeq (dedupes an at-least-once re-drain
	 * of entries already rendered). Advance ackedSeq to the result's high-water. A gap
	 * opened iff dropped grew past the persisted baseline (the producer's documented
	 * delta protocol; the consumer must not flag on the cumulative level - red-team /
	 * H4). Carry the new dropped as the next baseline.
	 */
	advance<E extends SyncEntry>(result: SyncPollResult<E>): SyncAdvance<E> {
		if (result.epoch !== this.epoch) {
			return {
				next: new SyncCursor(result.epoch, result.cursor, result.dropped),
				fresh: [...result.entries],
				gap: false,
			};
		}
		const fresh = result.entries.filter((e) => e.seq > this.ackedSeq);
		const gap = result.dropped > this.droppedBaseline;
		return {
			next: new SyncCursor(this.epoch, result.cursor, result.dropped),
			fresh,
			gap,
		};
	}

	equals(other: SyncCursor): boolean {
		return (
			this.epoch === other.epoch &&
			this.ackedSeq === other.ackedSeq &&
			this.droppedBaseline === other.droppedBaseline
		);
	}
}
