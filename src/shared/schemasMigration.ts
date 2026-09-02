import { z } from "zod";
import { BoardEntrySchema, MailboxEntrySchema } from "./schemas.js";

////////////////////////////////
//  Migration export
//
//  Written by the gateway, which is where the content key lives, and read by the Router's offline
//  import. Board text and message bodies cross SEALED: the Router is a courier for them here as
//  everywhere else.

/** One board entry, with its session resolved to a full triple. */
export const MigratedBoardEntrySchema = z
	.object({
		entry: BoardEntrySchema,
		// The exporting gateway's own (domainId, gatewayId). A bare sessionId means nothing at the
		// Router, which serves every gateway.
		session: z.object({ domainId: z.string(), gatewayId: z.string(), sessionId: z.string() }).optional(),
	})
	.meta({ id: "MigratedBoardEntry" });

/** An entry whose session the exporting gateway does not hold. Named rather than guessed: stamping
 * this gateway onto a session it never had would move somebody else's work here. */
export const MigrationRefusalSchema = z
	.object({ entryId: z.string(), sessionId: z.string(), reason: z.literal("session_unknown") })
	.meta({ id: "MigrationRefusal" });

/** Where an old mailbox coordinate lands. The phone holds the old pair and needs the new one. */
export const CursorMapEntrySchema = z
	.object({
		oldEpoch: z.number().int(),
		oldSeq: z.number().int(),
		epoch: z.number().int(),
		seq: z.number().int(),
	})
	.meta({ id: "CursorMapEntry" });

export const MigratedMailboxSchema = z
	.object({
		conversationId: z.string(),
		epoch: z.number().int(),
		rows: z.array(MailboxEntrySchema),
		cursorMap: z.array(CursorMapEntrySchema),
		consumerCursors: z.array(z.tuple([z.string(), z.number().int()])),
	})
	.meta({ id: "MigratedMailbox" });

export const MigrationExportSchema = z
	.object({
		v: z.literal(1),
		epoch: z.number().int().positive(),
		domainId: z.string(),
		gatewayId: z.string(),
		takenAt: z.number().int(),
		owners: z.array(
			z.object({
				ownerId: z.string(),
				board: z.array(MigratedBoardEntrySchema),
				refusals: z.array(MigrationRefusalSchema),
				mailboxes: z.array(MigratedMailboxSchema),
				pending: z.array(z.unknown()),
				readAnchors: z.record(z.string(), z.unknown()),
			}),
		),
		shares: z.array(z.unknown()),
	})
	.meta({ id: "MigrationExport" });

export type MigrationExport = z.infer<typeof MigrationExportSchema>;
export type MigratedBoardEntry = z.infer<typeof MigratedBoardEntrySchema>;
export type MigrationRefusal = z.infer<typeof MigrationRefusalSchema>;
export type CursorMapEntry = z.infer<typeof CursorMapEntrySchema>;
