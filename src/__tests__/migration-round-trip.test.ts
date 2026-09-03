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
import { generateIdentity } from "../shared/crypto.js";
import { InboxRowSchema, verifyRowEnvelope } from "../shared/schemasInbox.js";

const router = generateIdentity();
const ownerSignPub = Buffer.alloc(32, 1).toString("base64");

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
		{
			conversationId: `owner:alpha/${ownerSignPub}`,
			epoch: 4,
			rows: [row(1, "k1"), row(2, "k2")],
			consumerCursors: [["dev", 1]],
		},
	],
	pending: () => [{ deliveryId: "d1" }],
	readAnchors: () => ({ team: { epoch: 4, seq: 2, at: 10 } }),
	shares: () => [],
	now: () => 1000,
	...over,
});

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

		const { addresses } = applyImport(store, snapshot, ownerSignPub, dedupeRows, router.sign.priv, router.sign.pub);

		expect(
			verifyCounts(
				declaredCounts(snapshot),
				writtenCounts(
					{
						list: (kind) =>
							[
								...(
									store.records as Map<string, { value: { clear?: Record<string, unknown> } }>
								).entries(),
							]
								.filter(([key]) => key.startsWith(`${kind}/`))
								.map(([key, record]) => ({ id: key.slice(kind.length + 1), ...record.value })),
						rows: () => store.appended,
					},
					addresses,
				),
			),
		).toEqual([]);
	});

	it("importing twice leaves the same state as importing once", () => {
		const snapshot = buildExport(sources(), 7);
		const store = fakeStore();

		applyImport(store, snapshot, ownerSignPub, dedupeRows, router.sign.priv, router.sign.pub);
		const afterOne = store.appended.length;
		applyImport(store, snapshot, ownerSignPub, dedupeRows, router.sign.priv, router.sign.pub);

		expect(store.appended.length).toBe(afterOne);
	});

	it("does not double a row that carries no dedupe key", () => {
		const keyless = { seq: 1, at: 0, kind: "message", session_id: "conv.a.b.c.d", body: "hi" } as MailboxEntry;
		const snapshot = buildExport(
			sources({
				mailboxes: () => [
					{ conversationId: `owner:alpha/${ownerSignPub}`, epoch: 4, rows: [keyless], consumerCursors: [] },
				],
			}),
			7,
		);
		const store = fakeStore();

		applyImport(store, snapshot, ownerSignPub, dedupeRows, router.sign.priv, router.sign.pub);
		applyImport(store, snapshot, ownerSignPub, dedupeRows, router.sign.priv, router.sign.pub);

		expect(store.appended).toHaveLength(1);
	});

	it("carries the board, the anchors, the pending delivery and the cursor map", () => {
		const snapshot = buildExport(sources(), 7);
		const store = fakeStore();

		applyImport(store, snapshot, ownerSignPub, dedupeRows, router.sign.priv, router.sign.pub);

		const keys = [...(store.records as Map<string, unknown>).keys()];
		expect(keys).toContain("board.entry/a");
		expect(keys).toContain("readAnchor/readAnchor:team");
		expect(
			store.appended.some((row) => (row.envelope as { origin?: { kind?: string } }).origin?.kind === "router"),
		).toBe(true);
		expect(keys.some((key) => key.startsWith("inbox.address/"))).toBe(true);
	});

	it("never lands readable text", () => {
		const snapshot = buildExport(sources(), 7);
		const store = fakeStore();

		applyImport(store, snapshot, ownerSignPub, dedupeRows, router.sign.priv, router.sign.pub);

		const wire = JSON.stringify([...(store.records as Map<string, unknown>).entries(), store.appended]);
		expect(wire).not.toContain("title-a");
		expect(wire).not.toContain("body-1");
	});

	it("writes signed Router rows in the mailbox address", () => {
		const snapshot = buildExport(
			sources({
				mailboxes: () => [
					{
						conversationId: `owner:alpha/${ownerSignPub}`,
						epoch: 4,
						rows: [row(1, "owner")],
						consumerCursors: [],
					},
					{
						conversationId: "session:alpha/hosta/session-1",
						epoch: 4,
						rows: [row(1, "session")],
						consumerCursors: [],
					},
				],
			}),
			7,
		);
		const store = fakeStore();
		const { addresses } = applyImport(store, snapshot, ownerSignPub, dedupeRows, router.sign.priv, router.sign.pub);

		expect(addresses).toEqual([`owner:alpha/${ownerSignPub}`, "session:alpha/hosta/session-1"]);
		for (const appended of store.appended) {
			const parsed = InboxRowSchema.parse(appended);
			expect(verifyRowEnvelope(parsed.envelope, parsed.producerSig, router.sign.pub)).toBe(true);
		}
	});

	it("rejects missing and incorrect cursor targets before appending", () => {
		for (const change of [
			(snapshot: ReturnType<typeof buildExport>) => snapshot.owners[0]!.mailboxes[0]!.cursorMap.pop(),
			(snapshot: ReturnType<typeof buildExport>) => {
				snapshot.owners[0]!.mailboxes[0]!.cursorMap[0]!.seq = 9;
			},
		]) {
			const snapshot = buildExport(sources(), 7);
			change(snapshot);
			const store = fakeStore();
			expect(() =>
				applyImport(store, snapshot, ownerSignPub, dedupeRows, router.sign.priv, router.sign.pub),
			).toThrow();
			expect(store.appended).toHaveLength(0);
		}
	});
});
