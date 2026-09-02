// The gate between "written" and "served". An import that cannot prove what it wrote must not
// start answering for it.

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

/** Every section the import wrote, against what the export declared. Empty means it may serve. */
export function verifyCounts(declared: Record<string, number>, written: Record<string, number>): VerifyFailure[] {
	const failures: VerifyFailure[] = [];
	for (const [section, expected] of Object.entries(declared)) {
		const found = written[section] ?? 0;
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
