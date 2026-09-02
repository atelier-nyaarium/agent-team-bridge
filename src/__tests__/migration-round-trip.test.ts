// The whole point of the phase, end to end: what the gateway exports is what the Router holds, and
// running the import twice leaves the same state as running it once.

import { describe, expect, it } from "vitest";
import { applyImport, type ImportStore } from "../federation-server/migration/applyImport.js";
import {
	declaredCounts,
	dedupeRows,
	verifyCounts,
	writtenCounts,
} from "../federation-server/migration/importVerify.js";
import { buildExport, type ExportSources } from "../gateway/migration/exportSnapshot.js";
import type { BoardEntry, MailboxEntry } from "../shared/console-protocol.js";

const envelope = (plaintext: string) => ({
	v: 1 as const,
	epoch: 1,
	nonce: "AAAAAAAAAAAAAAAA",
	ciphertext: Buffer.from(plaintext.padEnd(16, ".")).toString("base64"),
});

const entry = (id: string, over: Partial<BoardEntry> = {}): BoardEntry =>
	({ id, title: `title-${id}`, state: "open", rank: "m", ...over }) as BoardEntry;

const row = (seq: number, dedupeKey: string): MailboxEntry =>
	({ seq, at: 0, kind: "message", session_id: "conv.a.b.c.d", body: `body-${seq}`, dedupeKey }) as MailboxEntry;

const sources = (over: Partial<ExportSources> = {}): ExportSources => ({
	domainId: "alpha",
	gatewayId: "hosta",
	seal: (plaintext) => envelope(plaintext),
	ownerIds: () => ["owner-1"],
	boardEntries: () => [entry("a"), entry("b", { parent: "a" })],
	holdsSession: () => true,
	mailboxes: () => [
		{ conversationId: "owner-1", epoch: 4, rows: [row(1, "k1"), row(2, "k2")], consumerCursors: [["dev", 1]] },
	],
	pending: () => [{ deliveryId: "d1" }],
	readAnchors: () => ({ team: { epoch: 4, seq: 2, at: 10 } }),
	shares: () => [],
	now: () => 1000,
	...over,
});

/** Enough of an owner store to observe what an import lands, with the store's own CAS behaviour. */
function fakeStore(): ImportStore & { records: Map<string, unknown>; appended: Record<string, unknown>[] } {
	const records = new Map<string, { version: number; value: unknown }>();
	const appended: Record<string, unknown>[] = [];
	return {
		records: records as unknown as Map<string, unknown>,
		appended,
		get: (kind, id) => records.get(`${kind}/${id}`) ?? null,
		put: (kind, id, expectedVersion, value) => {
			const key = `${kind}/${id}`;
			const current = records.get(key);
			// The real store refuses a stale expectation rather than overwriting.
			if (current && expectedVersion !== null && current.version !== expectedVersion) return { kind: "conflict" };
			records.set(key, { version: (current?.version ?? 0) + 1, value });
			return { kind: current && expectedVersion === null ? "conflict" : "ok" };
		},
		append: (_address, row) => {
			appended.push(row);
			return { kind: "ok" };
		},
		rows: () => appended.map((row) => ({ row: row as { dedupeKey?: string } })),
	};
}

describe("migration round trip", () => {
	it("lands every section the export declared", () => {
		const snapshot = buildExport(sources(), 7);
		const store = fakeStore();

		const { addresses } = applyImport(store, snapshot, "ownerkey", dedupeRows);

		expect(
			verifyCounts(
				declaredCounts(snapshot),
				writtenCounts(
					{
						list: (kind) =>
							[...(store.records as Map<string, unknown>).keys()].filter((key) =>
								key.startsWith(`${kind}/`),
							),
						rows: () => store.appended,
					},
					addresses,
				),
			),
		).toEqual([]);
	});

	// S10 names this one: a second run must not double anything.
	it("importing twice leaves the same state as importing once", () => {
		const snapshot = buildExport(sources(), 7);
		const store = fakeStore();

		applyImport(store, snapshot, "ownerkey", dedupeRows);
		const afterOne = store.appended.length;
		applyImport(store, snapshot, "ownerkey", dedupeRows);

		expect(store.appended.length).toBe(afterOne);
	});

	it("carries the board, the anchors, the pending delivery and the cursor map", () => {
		const snapshot = buildExport(sources(), 7);
		const store = fakeStore();

		applyImport(store, snapshot, "ownerkey", dedupeRows);

		const keys = [...(store.records as Map<string, unknown>).keys()];
		expect(keys).toContain("board.entry/a");
		expect(keys).toContain("readAnchor/readAnchor:team");
		expect(keys).toContain("inbox.row/pending:d1");
		expect(keys.some((key) => key.startsWith("inbox.address/"))).toBe(true);
	});

	// The Router holds what it cannot read, from the gateway all the way into the store.
	it("never lands readable text", () => {
		const snapshot = buildExport(sources(), 7);
		const store = fakeStore();

		applyImport(store, snapshot, "ownerkey", dedupeRows);

		const wire = JSON.stringify([...(store.records as Map<string, unknown>).entries(), store.appended]);
		expect(wire).not.toContain("title-a");
		expect(wire).not.toContain("body-1");
	});
});
