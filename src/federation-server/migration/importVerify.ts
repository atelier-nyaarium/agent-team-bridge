// Verify before serving.

import { isValidRank } from "../../shared/board-rank.js";
import type { MigrationExport } from "../../shared/schemasMigration.js";

export interface VerifyFailure {
	section: string;
	expected: number;
	found: number;
}

export function declaredCounts(snapshot: MigrationExport): Record<string, number> {
	let board = 0;
	let refusals = 0;
	let rows = 0;
	let cursorMap = 0;
	for (const owner of snapshot.owners) {
		board += owner.board.length;
		refusals += owner.refusals.length;
		for (const box of owner.mailboxes) {
			rows += box.rows.length;
			cursorMap += box.cursorMap.length;
		}
	}
	return { owners: snapshot.owners.length, board, refusals, rows, cursorMap, shares: snapshot.shares.length };
}

/** Counts stored data, not writes. */
export function writtenCounts(
	store: {
		list(kind: "board.entry" | "share"): unknown[];
		rows(address: string, from: number, to: number): unknown[];
	},
	addresses: readonly string[],
): Record<string, number> {
	return {
		board: store.list("board.entry").length,
		shares: store.list("share").length,
		rows: addresses.reduce((total, address) => total + store.rows(address, 1, Number.MAX_SAFE_INTEGER).length, 0),
	};
}

/** Empty means serving allowed. */
export function verifyCounts(declared: Record<string, number>, written: Record<string, number>): VerifyFailure[] {
	const failures: VerifyFailure[] = [];
	// Compare only observed sections.
	for (const [section, found] of Object.entries(written)) {
		const expected = declared[section] ?? 0;
		if (found !== expected) failures.push({ section, expected, found });
	}
	return failures;
}

/** Every old row needs mapping. */
export function unmappedRows(snapshot: MigrationExport): Array<{ conversationId: string; oldSeq: number }> {
	const missing: Array<{ conversationId: string; oldSeq: number }> = [];
	for (const owner of snapshot.owners) {
		for (const box of owner.mailboxes) {
			const mapped = new Set(box.cursorMap.map((c) => c.oldSeq));
			for (const { row } of box.rows) {
				if (!mapped.has(row.seq)) missing.push({ conversationId: box.conversationId, oldSeq: row.seq });
			}
		}
	}
	return missing;
}

/** Report faults only. */
export function structureFaults(snapshot: MigrationExport): Array<{ entryId: string; fault: string }> {
	const faults: Array<{ entryId: string; fault: string }> = [];
	for (const owner of snapshot.owners) {
		const byId = new Map(owner.board.map((item) => [item.entry.id, item.entry]));
		for (const { entry } of owner.board) {
			if (!isValidRank(entry.rank)) faults.push({ entryId: entry.id, fault: "bad_rank" });
			if (entry.parent === undefined) continue;
			if (!byId.has(entry.parent)) {
				faults.push({ entryId: entry.id, fault: "parent_missing" });
				continue;
			}
			const seen = new Set<string>([entry.id]);
			let cursor = byId.get(entry.parent);
			while (cursor) {
				if (seen.has(cursor.id)) {
					faults.push({ entryId: entry.id, fault: "cycle" });
					break;
				}
				seen.add(cursor.id);
				cursor = cursor.parent === undefined ? undefined : byId.get(cursor.parent);
			}
		}
	}
	return faults;
}

export function dedupeRows<T extends { dedupeKey?: string; seq?: number }>(
	existing: readonly { dedupeKey?: string; seq?: number }[],
	incoming: readonly T[],
): T[] {
	// Keyless rows use source sequence.
	const identity = (row: { dedupeKey?: string; seq?: number }) =>
		row.dedupeKey ?? (row.seq === undefined ? null : `seq:${row.seq}`);
	const held = new Set(existing.flatMap((row) => (identity(row) === null ? [] : [identity(row) as string])));
	return incoming.filter((row) => {
		const key = identity(row);
		return key === null || !held.has(key);
	});
}
