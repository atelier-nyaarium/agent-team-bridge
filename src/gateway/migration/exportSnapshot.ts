import type { BoardEntry, MailboxEntry } from "../../shared/console-protocol.js";
import { boardTextAadKind, type ContentAad, inboxBodyAadKind } from "../../shared/content-envelope.js";
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
	seal(plaintext: string, kind: ContentAad["kind"]): ContentEnvelope | null;
	ownerIds(): string[];
	boardEntries(ownerId: string): BoardEntry[];
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

/** Cursor rows renumber from one. */
export function cursorMapFor(epoch: number, rows: readonly MailboxEntry[], newEpoch: number): CursorMapEntry[] {
	return rows.map((row, index) => ({ oldEpoch: epoch, oldSeq: row.seq, epoch: newEpoch, seq: index + 1 }));
}

/** Half-sealed entries never ship. */
function sealEntry(sources: ExportSources, entry: BoardEntry): MigratedBoardEntry["sealed"] | null {
	const title = sources.seal(entry.title, boardTextAadKind("board.title", entry.id));
	if (!title) return null;
	let body: ContentEnvelope | undefined;
	if (entry.body !== undefined) {
		const sealedBody = sources.seal(entry.body, boardTextAadKind("board.body", entry.id));
		if (!sealedBody) return null;
		body = sealedBody;
	}
	const names: Record<string, ContentEnvelope> = {};
	for (const attachment of entry.attachments ?? []) {
		const name = sources.seal(
			attachment.filename,
			boardTextAadKind("board.name", `${entry.id}\n${attachment.blobId}`),
		);
		if (!name) return null;
		names[attachment.blobId] = name;
	}
	return { title, ...(body ? { body } : {}), ...(Object.keys(names).length > 0 ? { names } : {}) };
}

function sealRow(sources: ExportSources, row: MailboxEntry, conversationId: string) {
	// Clear copies strip readable fields.
	const { title, summary, body, fullSpoken, files, payload, ...clear } = row;
	const readable = { title, summary, body, fullSpoken, files, payload };
	if (Object.values(readable).every((value) => value === undefined)) return { row: clear };
	const text = sources.seal(JSON.stringify(readable), inboxBodyAadKind(conversationId, row.seq));
	return text ? { row: clear, text } : null;
}

export function buildExport(sources: ExportSources, epoch: number): MigrationExport {
	const owners = sources.ownerIds().map((ownerId) => {
		const board: MigratedBoardEntry[] = [];
		const refusals: MigrationRefusal[] = [];
		for (const entry of sources.boardEntries(ownerId)) {
			if (entry.sessionId && !sources.holdsSession(entry.sessionId)) {
				refusals.push({ entryId: entry.id, sessionId: entry.sessionId, reason: "session_unknown" });
				continue;
			}
			const sealed = sealEntry(sources, entry);
			if (!sealed) {
				refusals.push({ entryId: entry.id, sessionId: entry.sessionId ?? "", reason: "unsealable" });
				continue;
			}
			const { title: _title, body: _body, attachments, ...rest } = entry;
			const clear = {
				...rest,
				...(attachments ? { attachments: attachments.map(({ filename: _filename, ...file }) => file) } : {}),
			};
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
				// One unsealable row fails its mailbox.
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
