import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decideImport, type ImportMarker, markerKey } from "../federation-server/migration/importDecision.js";
import { IMPORTED, isPreserved, PRESERVED, violations } from "../federation-server/migration/importLayout.js";
import {
	declaredCounts,
	dedupeRows,
	structureFaults,
	unmappedRows,
	verifyCounts,
	writtenCounts,
} from "../federation-server/migration/importVerify.js";
import {
	beginImport,
	decideServe,
	declaredDigest,
	finishImport,
	parseSums,
} from "../federation-server/migration/serveGate.js";
import type { MailboxEntry } from "../shared/console-protocol.js";
import type { MigrationExport } from "../shared/schemasMigration.js";

const marker = (over: Partial<ImportMarker> = {}): ImportMarker => ({
	digest: "d1",
	epoch: 7,
	gatewayId: "hosta",
	counts: { owners: 1 },
	...over,
});

const row = (seq: number, dedupeKey?: string): MailboxEntry =>
	({ seq, at: 0, kind: "message", session_id: "conv.a.b.c.d", ...(dedupeKey ? { dedupeKey } : {}) }) as MailboxEntry;

const snapshot = (over: Partial<MigrationExport> = {}): MigrationExport =>
	({
		v: 1,
		epoch: 7,
		domainId: "alpha",
		gatewayId: "hosta",
		takenAt: 0,
		owners: [],
		shares: [],
		...over,
	}) as MigrationExport;

const owner = (rows: MailboxEntry[], cursorMap: Array<{ oldSeq: number }>) => ({
	ownerId: "owner-1",
	board: [],
	refusals: [],
	mailboxes: [
		{
			conversationId: "conv",
			epoch: 4,
			rows: rows.map((row) => ({ row })),
			cursorMap: cursorMap.map((c) => ({ oldEpoch: 4, oldSeq: c.oldSeq, epoch: 7, seq: 1 })),
			consumerCursors: [],
		},
	],
	pending: [],
	readAnchors: {},
});

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migration import", () => {
	it("applies an epoch nothing has recorded", () => {
		expect(decideImport({ digest: "d1", epoch: 7, gatewayId: "hosta" }, undefined)).toEqual({ kind: "apply" });
	});

	// A re-run must not import twice, and must answer the seqs the first run assigned.
	it("re-running the same export is a no-op answering the recorded counts", () => {
		const recorded = marker();

		expect(decideImport({ digest: "d1", epoch: 7, gatewayId: "hosta" }, recorded)).toEqual({
			kind: "noop",
			marker: recorded,
		});
	});

	// Silently overwriting would leave the Router holding a snapshot nobody could name.
	it("refuses a different export under a recorded epoch and names the one it holds", () => {
		const recorded = marker();

		expect(decideImport({ digest: "d2", epoch: 7, gatewayId: "hosta" }, recorded)).toEqual({
			kind: "refused",
			reason: "epoch_conflict",
			recorded,
		});
	});

	// A gateway offline during the cut imports later, under its own key, without colliding.
	it("keys a marker by gateway and epoch together", () => {
		expect(markerKey("hosta", 7)).not.toBe(markerKey("hostb", 7));
	});

	it("reports every section whose written count misses what the export declared", () => {
		const declared = { owners: 1, board: 3, rows: 2 };

		expect(verifyCounts(declared, { owners: 1, board: 2, rows: 2 })).toEqual([
			{ section: "board", expected: 3, found: 2 },
		]);
		expect(verifyCounts(declared, declared)).toEqual([]);
	});

	it("counts what the export itself carries", () => {
		const counts = declaredCounts(snapshot({ owners: [owner([row(1), row(2)], [{ oldSeq: 1 }, { oldSeq: 2 }])] }));

		expect(counts).toMatchObject({ owners: 1, rows: 2, cursorMap: 2 });
	});

	// A phone holding an unmapped coordinate can neither read on nor safely start over.
	it("names a row no cursor map entry covers", () => {
		const missing = unmappedRows(snapshot({ owners: [owner([row(1), row(9)], [{ oldSeq: 1 }])] }));

		expect(missing).toEqual([{ conversationId: "conv", oldSeq: 9 }]);
	});

	// The whole reason offline import exists: a Router started without its identity mints a fresh
	// one, and the fleet has pinned the old one.
	it("names a preserved file an import changed", () => {
		const before = { "federation.json": "a", "router-cert.pem": "b", "router-key.pem": "c" };

		expect(violations(before, { ...before })).toEqual([]);
		expect(violations(before, { ...before, "router-key.pem": "rotated" })).toEqual(["router-key.pem"]);
	});

	it("holds the identity and enrollment files apart from the owner state it replaces", () => {
		for (const name of PRESERVED) expect(isPreserved(name)).toBe(true);

		expect(IMPORTED.some((name) => isPreserved(name))).toBe(false);
	});

	// A new file under the Router's data directory has to be a deliberate choice: preserved with the
	// identity, or replaced with the owner state. Landing in neither is how an import quietly drops
	// something or quietly overwrites a pin.
	it("every Router data-dir child is either preserved or imported", () => {
		const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "federation-server");
		const sources = fs
			.readdirSync(root, { recursive: true, encoding: "utf8" })
			.filter((name) => name.endsWith(".ts"))
			.map((name) => fs.readFileSync(path.join(root, name), "utf8"))
			.join("\n");
		const children = new Set(
			[...sources.matchAll(/path\.join\(\s*(?:this\.opts\.|opts\.)?dataDir\s*,\s*"([^"]+)"/g)].map((m) => m[1]!),
		);

		const unclassified = [...children].filter(
			(name) => !isPreserved(name) && !(IMPORTED as readonly string[]).includes(name),
		);

		expect(unclassified).toEqual([]);
	});

	// Named rather than repaired: guessing a rank or reparenting an entry moves work nobody asked to
	// move.
	it("names a board structure the import would otherwise carry broken", () => {
		const board = (entries: Array<{ id: string; rank?: string; parent?: string }>) =>
			({
				...snapshot(),
				owners: [
					{
						ownerId: "owner-1",
						board: entries.map((e) => ({
							entry: { id: e.id, state: "open", rank: e.rank ?? "m", parent: e.parent },
						})),
						refusals: [],
						mailboxes: [],
						pending: [],
						readAnchors: {},
					},
				],
			}) as unknown as MigrationExport;

		expect(structureFaults(board([{ id: "a" }]))).toEqual([]);
		expect(structureFaults(board([{ id: "a", parent: "gone" }]))).toEqual([
			{ entryId: "a", fault: "parent_missing" },
		]);
		expect(structureFaults(board([{ id: "a", rank: "!!" }]))).toEqual([{ entryId: "a", fault: "bad_rank" }]);
		expect(
			structureFaults(
				board([
					{ id: "a", parent: "b" },
					{ id: "b", parent: "a" },
				]),
			).map((f) => f.fault),
		).toContain("cycle");
	});

	// A counter incremented beside each write only proves the loop ran. Reading the tree back is what
	// catches a write the store refused or deduped.
	it("counts what the store actually holds rather than what the loop attempted", () => {
		const store = {
			list: (kind: "board.entry" | "share") => (kind === "board.entry" ? [1, 2] : [1]),
			rows: () => [1, 2, 3],
		};

		expect(writtenCounts(store, ["owner:a"])).toEqual({ board: 2, shares: 1, rows: 3 });
	});

	// An import that began and never verified leaves a half-written tree. Answering from it is worse
	// than not answering.
	it("refuses to serve while an import is unverified", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-gate-"));
		roots.push(dir);

		expect(decideServe(dir)).toEqual({ kind: "serve" });

		beginImport(dir, "hosta/7");
		expect(decideServe(dir)).toEqual({ kind: "refuse", reason: "import_unverified" });

		finishImport(dir);
		expect(decideServe(dir)).toEqual({ kind: "serve" });
	});

	it("reads a declared digest and refuses a file the sums do not name", () => {
		const sums = parseSums(`${"a".repeat(64)}  export-7.json\nnot a sums line\n`);

		expect(declaredDigest(sums, "export-7.json")).toBe("a".repeat(64));
		expect(declaredDigest(sums, "export-8.json")).toBeNull();
	});

	// A late export carries rows the Router already took by another path.
	it("drops an incoming row the Router already holds under the same dedupe key", () => {
		const kept = dedupeRows([row(1, "k1")], [row(5, "k1"), row(6, "k2"), row(7)]);

		expect(kept.map((r) => r.seq)).toEqual([6, 7]);
	});
});
