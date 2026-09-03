import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyImport } from "../federation-server/migration/applyImport.js";
import { decideImport, type ImportMarker, markerKey } from "../federation-server/migration/importDecision.js";
import {
	IMPORTED,
	isPreserved,
	PRESERVED,
	preservedDigests,
	violations,
} from "../federation-server/migration/importLayout.js";
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
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerLock, OwnerLockHeld } from "../federation-server/owner/ownerLock.js";
import { OwnerStateStore } from "../federation-server/owner/ownerStateStore.js";
import type { MailboxEntry } from "../shared/console-protocol.js";
import { generateIdentity } from "../shared/crypto.js";
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

const envelope = (text: string) => ({
	v: 1 as const,
	epoch: 1,
	nonce: Buffer.alloc(12).toString("base64"),
	ciphertext: Buffer.from(text.padEnd(16, ".")).toString("base64"),
});

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

	it("re-running the same export is a no-op answering the recorded counts", () => {
		const recorded = marker();

		expect(decideImport({ digest: "d1", epoch: 7, gatewayId: "hosta" }, recorded)).toEqual({
			kind: "alreadyApplied",
			marker: recorded,
		});
	});

	it("refuses a different export under a recorded epoch and names the one it holds", () => {
		const recorded = marker();

		expect(decideImport({ digest: "d2", epoch: 7, gatewayId: "hosta" }, recorded)).toEqual({
			kind: "refused",
			reason: "epoch_conflict",
			recorded,
		});
	});

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

	it("names a row no cursor map entry covers", () => {
		const missing = unmappedRows(snapshot({ owners: [owner([row(1), row(9)], [{ oldSeq: 1 }])] }));

		expect(missing).toEqual([{ conversationId: "conv", oldSeq: 9 }]);
	});

	it("names a preserved file an import changed", () => {
		const before = { "federation.json": "a", "router-cert.pem": "b", "router-key.pem": "c" };

		expect(violations(before, { ...before })).toEqual([]);
		expect(violations(before, { ...before, "router-key.pem": "rotated" })).toEqual(["router-key.pem"]);
	});

	it("holds the identity and enrollment files apart from the owner state it replaces", () => {
		for (const name of PRESERVED) expect(isPreserved(name)).toBe(true);

		expect(IMPORTED.some((name) => isPreserved(name))).toBe(false);
	});

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

	it("counts what the store actually holds rather than what the loop attempted", () => {
		const store = {
			list: (kind: "board.entry" | "share") => (kind === "board.entry" ? [1, 2] : [1]),
			rows: () => [1, 2, 3],
		};

		expect(writtenCounts(store, ["owner:a"])).toMatchObject({ board: 2, shares: 1, rows: 3 });
	});

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

	it("drops an incoming row the Router already holds under the same dedupe key", () => {
		const kept = dedupeRows([row(1, "k1")], [row(5, "k1"), row(6, "k2"), row(7)]);

		expect(kept.map((r) => r.seq)).toEqual([6, 7]);
	});

	it("dedupes a migrated twin against a native Router opKey", () => {
		const opKey = { conversationId: "conv", opId: "stable" };
		const native = { envelope: { opKey } };
		const migrated = { envelope: { opKey }, dedupeKey: "legacy" };

		expect(dedupeRows([native], [migrated])).toEqual([]);
	});

	it("refuses when either preserved TLS file is absent", () => {
		for (const missing of ["router-cert.pem", "router-key.pem"]) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-import-"));
			fs.writeFileSync(path.join(dir, "federation.json"), "{}", "utf8");
			for (const name of ["router-cert.pem", "router-key.pem"])
				if (name !== missing) fs.writeFileSync(path.join(dir, name), "tls", "utf8");
			expect(() => preservedDigests(dir)).toThrow(`preserved file missing: ${missing}`);
			expect(fs.existsSync(path.join(dir, "import-in-progress"))).toBe(false);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a live owner lock and exposes its holder pid", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-lock-"));
		const lock = OwnerLock.open(dir, 60_000);
		try {
			expect(() => OwnerLock.open(dir)).toThrow(OwnerLockHeld);
			expect(`live Router owner lock held by pid ${process.pid}`).toContain(String(process.pid));
		} finally {
			lock.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("strips an attachment missing from the blob manifest and records refusal", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-dangling-"));
		const ownerIdentity = generateIdentity();
		const routerIdentity = generateIdentity();
		const entryId = "00000000000000000000000000000001";
		const store = OwnerStateStore.open({
			dataDir: dir,
			key: { domainId: "alpha", ownerSignPub: ownerIdentity.sign.pub },
			quota: new DomainQuota({ dir, limitBytes: 1_000_000, reserveBytes: 0 }),
		});
		try {
			const value = snapshot({
				owners: [
					{
						ownerId: "owner",
						domainId: "alpha",
						ownerSignPub: ownerIdentity.sign.pub,
						board: [
							{
								entry: {
									id: entryId,
									state: "open",
									rank: "m",
									attachments: [
										{ blobId: "missing", blobGateway: "gateway", size: 3, mime: "text/plain" },
									],
								},
								sealed: { title: envelope("title") },
							},
						],
						refusals: [],
						mailboxes: [],
						readAnchors: {},
					},
				],
				blobs: [],
			}) as MigrationExport;
			applyImport(
				store,
				value,
				ownerIdentity.sign.pub,
				dedupeRows,
				routerIdentity.sign.priv,
				routerIdentity.sign.pub,
			);
			expect(store.get("board.entry", entryId)?.clear?.attachments).toBeUndefined();
			expect(store.list("migration").map((record) => record.clear.reason)).toContain("blob_missing");
		} finally {
			store.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
