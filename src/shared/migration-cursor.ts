// Translating a phone's old mailbox coordinate into the one the Router now holds.
//
// A REPEATABLE handshake, not a one-shot. The Router keeps the map for the whole migration window
// and answers the same old cursor with the same new one however many times it is asked, because a
// phone that dies between hearing the answer and committing it must be able to ask again.

import type { CursorMapEntry } from "./schemasMigration.js";

export interface SyncCursor {
	epoch: number;
	seq: number;
}

export type Translation =
	/** Already on the current epoch. Nothing to do. */
	| { kind: "current" }
	| { kind: "translated"; cursor: SyncCursor }
	/** The map has no row for this coordinate. Refused rather than guessed: reading on would skip
	 * whatever sat between, and starting over would re-deliver everything already read. */
	| { kind: "unmapped" };

export function translateCursor(
	cursor: SyncCursor,
	migrationEpoch: number,
	map: readonly CursorMapEntry[],
): Translation {
	if (cursor.epoch === migrationEpoch) return { kind: "current" };
	const hit = map.find((row) => row.oldEpoch === cursor.epoch && row.oldSeq === cursor.seq);
	if (!hit) return { kind: "unmapped" };
	return { kind: "translated", cursor: { epoch: hit.epoch, seq: hit.seq } };
}

/**
 * Whether the phone may take rows yet. It accepts no `inbox_rows` and sends no `ack` until the
 * translated cursor is committed through the journal, so a process killed between the welcome and
 * that commit replays to the same cursor rather than acking rows it never handed to anyone.
 */
export function mayConsume(state: {
	welcomed: boolean;
	cursorEpoch: number;
	migrationEpoch: number;
	committed: boolean;
}): boolean {
	if (!state.welcomed) return false;
	if (state.cursorEpoch === state.migrationEpoch) return true;
	return state.committed;
}
