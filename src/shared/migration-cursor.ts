// Translate old mailbox coordinates.

import type { CursorMapEntry } from "./schemasMigration.js";

export interface SyncCursor {
	epoch: number;
	seq: number;
}

export type Translation =
	| { kind: "current" }
	| { kind: "translated"; cursor: SyncCursor }
	/** Missing mappings refuse translation. */
	| { kind: "unmapped" };

export function translateCursor(
	cursor: SyncCursor,
	migrationEpoch: number,
	map: readonly CursorMapEntry[],
): Translation {
	// Cursor mappings remain repeatable during migration.
	if (cursor.epoch === migrationEpoch) return { kind: "current" };
	const hit = map.find((row) => row.oldEpoch === cursor.epoch && row.oldSeq === cursor.seq);
	if (!hit) return { kind: "unmapped" };
	return { kind: "translated", cursor: { epoch: hit.epoch, seq: hit.seq } };
}

/** Commit translation before consuming. */
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
