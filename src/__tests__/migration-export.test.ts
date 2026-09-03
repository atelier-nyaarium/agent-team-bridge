import { describe, expect, it } from "vitest";
import { buildExport, cursorMapFor, type ExportSources } from "../gateway/migration/exportSnapshot.js";
import type { BoardEntry, MailboxEntry } from "../shared/console-protocol.js";
import { MigrationExportSchema } from "../shared/schemasMigration.js";

const entry = (id: string, sessionId?: string): BoardEntry =>
	({ id, title: `t-${id}`, state: "open", rank: "m", ...(sessionId ? { sessionId } : {}) }) as BoardEntry;

const row = (seq: number): MailboxEntry =>
	({ seq, at: 0, kind: "message", session_id: "conv.a.b.c.d" }) as MailboxEntry;

const envelope = (plaintext: string) => ({
	v: 1 as const,
	epoch: 1,
	nonce: "AAAAAAAAAAAAAAAA",
	ciphertext: Buffer.from(plaintext.padEnd(16, ".")).toString("base64"),
});

const sources = (over: Partial<ExportSources> = {}): ExportSources => ({
	domainId: "alpha",
	gatewayId: "hosta",
	seal: (plaintext) => envelope(plaintext),
	ownerIds: () => ["owner-1"],
	boardEntries: () => [],
	holdsSession: () => true,
	mailboxes: () => [],
	pending: () => [],
	readAnchors: () => ({}),
	shares: () => [],
	now: () => 1000,
	...over,
});

describe("migration export", () => {
	it("stamps a held session with this gateway's own triple", () => {
		const out = buildExport(sources({ boardEntries: () => [entry("a", "spawn.session")] }), 7);

		expect(out.owners[0]?.board[0]?.session).toEqual({
			domainId: "alpha",
			gatewayId: "hosta",
			sessionId: "spawn.session",
		});
	});

	it("names an entry whose session this gateway does not hold rather than guessing", () => {
		const out = buildExport(
			sources({ boardEntries: () => [entry("a", "elsewhere.session")], holdsSession: () => false }),
			7,
		);

		expect(out.owners[0]?.board).toEqual([]);
		expect(out.owners[0]?.refusals).toEqual([
			{ entryId: "a", sessionId: "elsewhere.session", reason: "session_unknown" },
		]);
	});

	it("carries no readable board text", () => {
		const withBody = { ...entry("a"), body: "secret body" } as BoardEntry;
		const out = buildExport(sources({ boardEntries: () => [withBody] }), 7);

		const wire = JSON.stringify(out);
		expect(wire).not.toContain("secret body");
		expect(wire).not.toContain("t-a");
		expect(out.owners[0]?.board[0]?.sealed.title).toMatchObject({ v: 1 });
	});

	it("carries no readable message text", () => {
		const chatty = { ...row(1), body: "secret message", title: "secret title" } as MailboxEntry;
		const out = buildExport(
			sources({
				mailboxes: () => [{ conversationId: "conv", epoch: 4, rows: [chatty], consumerCursors: [] }],
			}),
			7,
		);

		const wire = JSON.stringify(out);
		expect(wire).not.toContain("secret message");
		expect(wire).not.toContain("secret title");
		expect(out.owners[0]?.mailboxes[0]?.rows[0]?.text).toMatchObject({ v: 1 });
	});

	it("names an entry it cannot seal rather than shipping it readable", () => {
		const out = buildExport(sources({ boardEntries: () => [entry("a")], seal: () => null }), 7);

		expect(out.owners[0]?.board).toEqual([]);
		expect(out.owners[0]?.refusals[0]).toMatchObject({ entryId: "a", reason: "unsealable" });
	});

	it("binds a sealed field to its own entry and a row to its own row", () => {
		const seen: string[] = [];
		buildExport(
			sources({
				boardEntries: () => [entry("a"), entry("b")],
				mailboxes: () => [
					{
						conversationId: "conv",
						epoch: 4,
						rows: [{ ...row(3), body: "text" } as MailboxEntry],
						consumerCursors: [],
					},
				],
				seal: (plaintext, kind) => {
					seen.push(kind);
					return envelope(plaintext);
				},
			}),
			7,
		);

		expect(seen).toEqual(["board.title\na", "board.title\nb", "inbox.body\nconv\n3"]);
	});

	it("carries an unassigned entry without a session", () => {
		const out = buildExport(sources({ boardEntries: () => [entry("a")] }), 7);

		expect(out.owners[0]?.board[0]?.session).toBeUndefined();
		expect(out.owners[0]?.refusals).toEqual([]);
	});

	it("maps every old coordinate, including a mailbox whose seqs have gaps", () => {
		const rows = [row(3), row(9), row(10)];

		expect(cursorMapFor(4, rows, 7)).toEqual([
			{ oldEpoch: 4, oldSeq: 3, epoch: 7, seq: 1 },
			{ oldEpoch: 4, oldSeq: 9, epoch: 7, seq: 2 },
			{ oldEpoch: 4, oldSeq: 10, epoch: 7, seq: 3 },
		]);
	});

	it("answers the declared wire shape", () => {
		const out = buildExport(
			sources({
				boardEntries: () => [entry("a", "spawn.session")],
				mailboxes: () => [{ conversationId: "conv", epoch: 4, rows: [row(1)], consumerCursors: [["dev", 1]] }],
			}),
			7,
		);

		const parsed = MigrationExportSchema.safeParse(out);
		expect(parsed.error?.message ?? "ok").toBe("ok");
	});
});
