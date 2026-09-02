// Built at the gateway, because that is where the content key lives. The Router receives board text
// and message bodies already sealed, and carries them without reading them.

import type { BoardEntry, MailboxEntry } from "../../shared/console-protocol.js";
import type {
	CursorMapEntry,
	MigratedBoardEntry,
	MigrationExport,
	MigrationRefusal,
} from "../../shared/schemasMigration.js";

export interface ExportSources {
	domainId: string;
	gatewayId: string;
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

export function buildExport(sources: ExportSources, epoch: number): MigrationExport {
	const owners = sources.ownerIds().map((ownerId) => {
		const board: MigratedBoardEntry[] = [];
		const refusals: MigrationRefusal[] = [];
		for (const entry of sources.boardEntries(ownerId)) {
			// A bare sessionId means nothing at the Router, which serves every gateway, so it is
			// resolved here or the entry is named. Guessing would move somebody else's work here.
			if (!entry.sessionId) {
				board.push({ entry });
				continue;
			}
			if (!sources.holdsSession(entry.sessionId)) {
				refusals.push({ entryId: entry.id, sessionId: entry.sessionId, reason: "session_unknown" });
				continue;
			}
			board.push({
				entry,
				session: { domainId: sources.domainId, gatewayId: sources.gatewayId, sessionId: entry.sessionId },
			});
		}
		return {
			ownerId,
			board,
			refusals,
			mailboxes: sources.mailboxes(ownerId).map((box) => ({
				conversationId: box.conversationId,
				epoch: box.epoch,
				rows: box.rows,
				cursorMap: cursorMapFor(box.epoch, box.rows, epoch),
				consumerCursors: box.consumerCursors,
			})),
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
