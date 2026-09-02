// The gate between "written" and "served". An import that cannot prove what it wrote must not
// start answering for it.

import { isValidRank } from "../../shared/board-rank.js";
import type { MigrationExport } from "../../shared/schemasMigration.js";

export interface VerifyFailure {
	section: string;
	expected: number;
	found: number;
}

/** What the export claims it carries, counted from the export itself. */
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

/**
 * What the store actually holds, read back rather than counted as it was written.
 *
 * A counter incremented alongside each write only proves the loop ran the expected number of times.
 * Reading the tree back is what catches a write the store refused, deduped, or overwrote.
 */
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

/** Every section the import wrote, against what the export declared. Empty means it may serve. */
export function verifyCounts(declared: Record<string, number>, written: Record<string, number>): VerifyFailure[] {
	const failures: VerifyFailure[] = [];
	// Only sections the reader actually counted. One it cannot see is not evidence of agreement, so
	// it is left to its own check rather than silently comparing against zero.
	for (const [section, found] of Object.entries(written)) {
		const expected = declared[section] ?? 0;
		if (found !== expected) failures.push({ section, expected, found });
	}
	return failures;
}

/**
 * Every old coordinate must have somewhere to land, or a phone holding it is stranded: it asks what
 * its cursor became and the Router has no answer, so it can neither read on nor start over safely.
 */
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

/**
 * Structure the board's own rules assume and the import would otherwise carry broken: a parent that
 * is not in the snapshot, a cycle, or a rank the ordering cannot read. Named rather than repaired,
 * since guessing a rank or reparenting an entry moves somebody's work without being asked.
 */
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

/**
 * A late export from a gateway that was offline during the cut carries rows the Router may already
 * hold. Deduped by `dedupeKey`, the id whichever gateway first composed the entry set and every
 * relay carried verbatim, so the same logical message is one row however many paths it took.
 */
export function dedupeRows<T extends { dedupeKey?: string }>(
	existing: readonly { dedupeKey?: string }[],
	incoming: readonly T[],
): T[] {
	const held = new Set(existing.flatMap((row) => (row.dedupeKey ? [row.dedupeKey] : [])));
	return incoming.filter((row) => !row.dedupeKey || !held.has(row.dedupeKey));
}
