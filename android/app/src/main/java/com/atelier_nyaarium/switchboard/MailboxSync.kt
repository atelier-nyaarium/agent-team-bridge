package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PollParams
import com.atelier_nyaarium.switchboard.proto.SyncAdvance
import com.atelier_nyaarium.switchboard.proto.SyncCursor
import com.atelier_nyaarium.switchboard.proto.SyncEntry
import com.atelier_nyaarium.switchboard.proto.SyncPollResult

/**
 * The phone-side durable OWNER of the mailbox consumption cursor. Loads the cursor from
 * ProvisioningStore on construction, advances it through the pure SyncCursor rules, and
 * persists it as the LAST write of a poll cycle. The caller MUST render + persist threads
 * BEFORE calling commit(), so a crash between the two re-delivers (the dedupe absorbs it)
 * rather than skips. This is where the cursor becomes phone-owned and durable, closing the
 * backlog-deleted-on-reconnect bug: the phone never re-adopts a server-dictated cursor.
 */
class MailboxSync(private val store: ProvisioningStore) {
	@Volatile
	private var cursor: SyncCursor = store.loadSyncCursor() ?: SyncCursor.initial()

	/** The poll-op params (cursor + epoch) for the next poll, from the durable cursor. */
	fun pollParams(): PollParams = cursor.pollParams

	/** Pure: fold a poll result, returning the genuinely-fresh entries + whether a gap
	 * opened. Does NOT persist; commit() does, after the entries are durable. */
	fun <E : SyncEntry> advance(result: SyncPollResult<E>): SyncAdvance<E> = cursor.advance(result)

	/** Commit the advanced cursor - the FINAL write of the poll cycle, after the fresh
	 * entries have been rendered and persisted. */
	fun commit(next: SyncCursor) {
		cursor = next
		store.saveSyncCursor(next)
	}

	/** Reset to the initial sentinel in memory (clearAll calls store.clear() first, which
	 * wipes the persisted cursor; this drops the in-memory copy to match). */
	fun clearInMemory() {
		cursor = SyncCursor.initial()
	}
}
