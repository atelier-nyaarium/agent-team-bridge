// Writing an export into an owner store. Separated from the command so a round trip can be tested
// without a Router process: the command owns the files, the digests and the marker, this owns what
// lands in the store.

import type { MigrationExport } from "../../shared/schemasMigration.js";

export interface ImportStore {
	get(kind: "board.entry" | "inbox.address" | "readAnchor" | "share", id: string): { version: number } | null;
	put(
		kind: "board.entry" | "inbox.address" | "readAnchor" | "share" | "inbox.row",
		id: string,
		expectedVersion: number | null,
		value: Record<string, unknown>,
	): { kind: string };
	append(address: string, row: Record<string, unknown>): { kind: string };
	rows(address: string, from: number, to: number): Array<{ row: { dedupeKey?: string } }>;
}

export interface ApplyResult {
	addresses: string[];
}

/** Every address the import wrote rows to, so the verifier knows where to recount. */
export function applyImport(
	store: ImportStore,
	snapshot: MigrationExport,
	ownerSignPub: string,
	dedupe: <T extends { dedupeKey?: string }>(
		existing: readonly { dedupeKey?: string }[],
		incoming: readonly T[],
	) => T[],
): ApplyResult {
	const addresses: string[] = [];
	for (const owner of snapshot.owners) {
		for (const item of owner.board) {
			const entry = item.entry;
			const clear = {
				id: entry.id,
				state: entry.state,
				rank: entry.rank,
				...(entry.parent ? { parent: entry.parent } : {}),
				...(item.session ? { session: item.session } : {}),
			};
			// Sealed at the gateway. The Router stores these without reading them.
			const result = store.put("board.entry", entry.id, null, { clear, sealed: item.sealed });
			if (result.kind !== "ok" && result.kind !== "conflict") throw new Error(`board write ${result.kind}`);
		}
		for (const box of owner.mailboxes) {
			const address = `owner:${snapshot.domainId}/${ownerSignPub}`;
			const existing = store.rows(address, 1, Number.MAX_SAFE_INTEGER).map((row) => row.row);
			const incoming = box.rows.map((entry) => ({ ...entry, dedupeKey: entry.row.dedupeKey }));
			for (const row of dedupe(existing, incoming)) {
				const result = store.append(address, row as unknown as Record<string, unknown>);
				if (result.kind !== "ok") throw new Error(`mailbox write ${result.kind}`);
			}
			// Kept for the whole window, so a phone can ask for its translation again.
			store.put("inbox.address", address, store.get("inbox.address", address)?.version ?? null, {
				clear: { epoch: box.epoch, cursorMap: box.cursorMap, consumerCursors: box.consumerCursors },
			});
			addresses.push(address);
		}
		for (const [team, anchor] of Object.entries(owner.readAnchors)) {
			const id = `readAnchor:${team}`;
			store.put("readAnchor", id, store.get("readAnchor", id)?.version ?? null, {
				clear: anchor as Record<string, unknown>,
			});
		}
		for (const delivery of owner.pending as Array<Record<string, unknown>>) {
			const id = String(delivery.deliveryId ?? "");
			if (!id) throw new Error("pending delivery without an id");
			store.put("inbox.row", `pending:${id}`, null, { clear: delivery });
		}
	}
	for (const share of snapshot.shares as Array<Record<string, unknown>>) {
		const id = `share:${String(share.sessionTarget)}|${JSON.stringify(share.target)}`;
		const result = store.put("share", id, null, { clear: share });
		if (result.kind !== "ok" && result.kind !== "conflict") throw new Error(`share write ${result.kind}`);
	}
	return { addresses: [...new Set(addresses)] };
}
