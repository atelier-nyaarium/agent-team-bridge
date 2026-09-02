import { describe, expect, it } from "vitest";
import { buildExport, cursorMapFor, type ExportSources } from "../gateway/migration/exportSnapshot.js";
import type { BoardEntry, MailboxEntry } from "../shared/console-protocol.js";
import { MigrationExportSchema } from "../shared/schemasMigration.js";

const entry = (id: string, sessionId?: string): BoardEntry =>
	({ id, title: `t-${id}`, state: "open", rank: "m", ...(sessionId ? { sessionId } : {}) }) as BoardEntry;

const row = (seq: number): MailboxEntry =>
	({ seq, at: 0, kind: "message", session_id: "conv.a.b.c.d" }) as MailboxEntry;

const sources = (over: Partial<ExportSources> = {}): ExportSources => ({
	domainId: "alpha",
	gatewayId: "hosta",
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

	// Stamping a session this gateway never had would move somebody else's work here, so it is named
	// instead and the operator decides.
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

	it("carries an unassigned entry without a session", () => {
		const out = buildExport(sources({ boardEntries: () => [entry("a")] }), 7);

		expect(out.owners[0]?.board[0]?.session).toBeUndefined();
		expect(out.owners[0]?.refusals).toEqual([]);
	});

	// The phone holds an old pair and asks what it became, so every row it might still name needs a
	// row here. A gap would strand the cursor that landed on it.
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

		expect(MigrationExportSchema.safeParse(out).success).toBe(true);
	});
});
