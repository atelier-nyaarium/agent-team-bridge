// Verify before serving.

import { isValidRank } from "../../shared/board-rank.js";
import { canonicalJson } from "../../shared/canonical-json.js";
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
	let pending = 0;
	let readAnchors = 0;
	let consumerCursors = 0;
	for (const owner of snapshot.owners) {
		board += owner.board.length;
		refusals += owner.refusals.length;
		readAnchors += Object.keys(owner.readAnchors).length;
		for (const box of owner.mailboxes) {
			rows += box.rows.length;
			if (box.conversationId.startsWith("session:")) pending += box.rows.length;
			cursorMap += box.cursorMap.length;
			consumerCursors += box.consumerCursors.length;
		}
	}
	return {
		owners: snapshot.owners.length,
		board,
		refusals,
		rows,
		cursorMap,
		shares: snapshot.shares.length,
		pending,
		readAnchors,
		consumerCursors,
	};
}

/** Counts stored data, not writes. */
export function writtenCounts(
	store: {
		list(kind: string): unknown[];
		rows(address: string, from: number, to: number): unknown[];
	},
	addresses: readonly string[],
): Record<string, number> {
	return {
		owners: addresses.length ? 1 : 0,
		board: store.list("board.entry").length,
		shares: store.list("share").length,
		rows: addresses.reduce((total, address) => total + store.rows(address, 1, Number.MAX_SAFE_INTEGER).length, 0),
		refusals: store.list("migration").filter((record) => (record as { id?: string }).id?.startsWith("refusal:"))
			.length,
		pending: addresses.reduce(
			(total, address) =>
				total + (address.startsWith("session:") ? store.rows(address, 1, Number.MAX_SAFE_INTEGER).length : 0),
			0,
		),
		readAnchors: store.list("readAnchor").length,
		consumerCursors: store.list("consumer").length,
		cursorMap: addresses.reduce((total, address) => {
			const record = store.list("inbox.address").find((item) => (item as { id?: string }).id === address) as
				| { clear?: Record<string, unknown> }
				| undefined;
			const map = record?.clear?.cursorMap;
			return total + (Array.isArray(map) ? map.length : 0);
		}, 0),
	};
}

/** Empty means serving allowed. */
export function verifyCounts(declared: Record<string, number>, written: Record<string, number>): VerifyFailure[] {
	const failures: VerifyFailure[] = [];
	for (const section of new Set([...Object.keys(declared), ...Object.keys(written)])) {
		const expected = declared[section] ?? 0;
		const found = written[section] ?? 0;
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

export function dedupeRows<
	T extends { dedupeKey?: string; seq?: number; envelope?: { opKey?: { conversationId: string; opId: string } } },
>(
	existing: readonly {
		dedupeKey?: string;
		seq?: number;
		envelope?: { opKey?: { conversationId: string; opId: string } };
	}[],
	incoming: readonly T[],
): T[] {
	const identities = (row: {
		dedupeKey?: string;
		seq?: number;
		envelope?: { opKey?: { conversationId: string; opId: string } };
	}) => [
		...(row.dedupeKey ? [`key:${row.dedupeKey}`] : []),
		...(row.envelope?.opKey ? [`op:${canonicalJson(row.envelope.opKey)}`] : []),
		...(row.seq === undefined ? [] : [`seq:${row.seq}`]),
	];
	const held = new Set(existing.flatMap(identities));
	return incoming.filter((row) => {
		const keys = identities(row);
		return keys.length === 0 || !keys.some((key) => held.has(key));
	});
}
