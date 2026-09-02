// Built at the gateway, because that is where the content key lives. The Router receives board text
// and message bodies already sealed, and carries them without reading them.

import type { BoardEntry, MailboxEntry } from "../../shared/console-protocol.js";
import type { BoardTextKind } from "../../shared/content-envelope.js";
import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import type {
	CursorMapEntry,
	MigratedBoardEntry,
	MigrationExport,
	MigrationRefusal,
} from "../../shared/schemasMigration.js";

export interface ExportSources {
	domainId: string;
	gatewayId: string;
	/** Seals one field. Null when this gateway holds no key, which makes the export refuse rather
	 * than hand the Router readable text. */
	seal(plaintext: string, kind: BoardTextKind | "inbox.body", entryId: string): ContentEnvelope | null;
	/** Owners holding a board, a mailbox, or a read anchor. Their union, so none is missed. */
	ownerIds(): string[];
	boardEntries(ownerId: string): BoardEntry[];
	/** True when this gateway holds the session, which is what makes stamping it honest. */
	holdsSession(sessionId: string): boolean;
	mailboxes(ownerId: string): Array<{
		conversationId: string;
		epoch: number;
		rows: MailboxEntry[];
		consumerCursors: Array<[string, number]>;
	}>;
	pending(ownerId: string): unknown[];
	readAnchors(ownerId: string): Record<string, unknown>;
	shares(): unknown[];
	now(): number;
}

/** Where each old coordinate lands. Seq is renumbered from 1 so the Router's own numbering starts
 * clean, and the phone holds the old pair, so every row it might still name needs a row here. */
export function cursorMapFor(epoch: number, rows: readonly MailboxEntry[], newEpoch: number): CursorMapEntry[] {
	return rows.map((row, index) => ({ oldEpoch: epoch, oldSeq: row.seq, epoch: newEpoch, seq: index + 1 }));
}

/** Null when any field cannot be sealed, so a half-sealed entry never ships. */
function sealEntry(sources: ExportSources, entry: BoardEntry): MigratedBoardEntry["sealed"] | null {
	const title = sources.seal(entry.title, "board.title", entry.id);
	if (!title) return null;
	let body: ContentEnvelope | undefined;
	if (entry.body !== undefined) {
		const sealedBody = sources.seal(entry.body, "board.body", entry.id);
		if (!sealedBody) return null;
		body = sealedBody;
	}
	const names: Record<string, ContentEnvelope> = {};
	for (const attachment of entry.attachments ?? []) {
		const name = sources.seal(attachment.filename, "board.name", `${entry.id}\n${attachment.blobId}`);
		if (!name) return null;
		names[attachment.blobId] = name;
	}
	return { title, ...(body ? { body } : {}), ...(Object.keys(names).length > 0 ? { names } : {}) };
}

/** The four readable row fields, sealed together so they cannot be separated in transit. */
function sealRow(sources: ExportSources, row: MailboxEntry, conversationId: string) {
	const { title, summary, body, fullSpoken, ...clear } = row;
	if (title === undefined && summary === undefined && body === undefined && fullSpoken === undefined) {
		return { row: clear };
	}
	const text = sources.seal(
		JSON.stringify({ title, summary, body, fullSpoken }),
		"inbox.body",
		`${conversationId}\n${row.seq}`,
	);
	return text ? { row: clear, text } : null;
}

export function buildExport(sources: ExportSources, epoch: number): MigrationExport {
	const owners = sources.ownerIds().map((ownerId) => {
		const board: MigratedBoardEntry[] = [];
		const refusals: MigrationRefusal[] = [];
		for (const entry of sources.boardEntries(ownerId)) {
			// A bare sessionId means nothing at the Router, which serves every gateway, so it is
			// resolved here or the entry is named. Guessing would move somebody else's work here.
			if (entry.sessionId && !sources.holdsSession(entry.sessionId)) {
				refusals.push({ entryId: entry.id, sessionId: entry.sessionId, reason: "session_unknown" });
				continue;
			}
			const sealed = sealEntry(sources, entry);
			// No key means no export. Handing the Router readable text would cost the property the
			// whole design rests on, so the entry is named instead.
			if (!sealed) {
				refusals.push({ entryId: entry.id, sessionId: entry.sessionId ?? "", reason: "unsealable" });
				continue;
			}
			const { title: _title, body: _body, ...clear } = entry;
			board.push({
				entry: clear,
				sealed,
				...(entry.sessionId
					? {
							session: {
								domainId: sources.domainId,
								gatewayId: sources.gatewayId,
								sessionId: entry.sessionId,
							},
						}
					: {}),
			});
		}
		return {
			ownerId,
			board,
			refusals,
			mailboxes: sources.mailboxes(ownerId).map((box) => {
				const sealed = box.rows.map((row) => sealRow(sources, row, box.conversationId));
				// One unsealable row fails the mailbox rather than shipping the rest in the clear.
				if (sealed.some((entry) => entry === null)) throw new Error(`cannot seal ${box.conversationId}`);
				return {
					conversationId: box.conversationId,
					epoch: box.epoch,
					rows: sealed as NonNullable<(typeof sealed)[number]>[],
					cursorMap: cursorMapFor(box.epoch, box.rows, epoch),
					consumerCursors: box.consumerCursors,
				};
			}),
			pending: sources.pending(ownerId),
			readAnchors: sources.readAnchors(ownerId),
		};
	});

	return {
		v: 1,
		epoch,
		domainId: sources.domainId,
		gatewayId: sources.gatewayId,
		takenAt: sources.now(),
		owners,
		shares: sources.shares(),
	};
}
