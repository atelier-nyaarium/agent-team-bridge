import { z } from "zod";
import { BoardAttachmentSchema, BoardEntrySchema, ContentEnvelopeSchema, MailboxEntrySchema } from "./schemas.js";

////////////////////////////////
//  Migration export

export const MigratedBoardEntrySchema = z
	.object({
		/** Clear entry strips text fields. */
		// Attachment filenames sealed. Other facts clear.
		entry: BoardEntrySchema.omit({ title: true, body: true, attachments: true }).extend({
			attachments: z.array(BoardAttachmentSchema.omit({ filename: true })).optional(),
		}),
		sealed: z.object({
			title: ContentEnvelopeSchema,
			body: ContentEnvelopeSchema.optional(),
			names: z.record(z.string(), ContentEnvelopeSchema).optional(),
		}),
		session: z.object({ domainId: z.string(), gatewayId: z.string(), sessionId: z.string() }).optional(),
	})
	.meta({ id: "MigratedBoardEntry" });

export const MigrationRefusalSchema = z
	.object({
		entryId: z.string(),
		sessionId: z.string(),
		reason: z.enum(["session_unknown", "unsealable", "unparseable_pending"]),
	})
	.meta({ id: "MigrationRefusal" });

export const CursorMapEntrySchema = z
	.object({
		oldEpoch: z.number().int(),
		oldSeq: z.number().int(),
		epoch: z.number().int(),
		seq: z.number().int(),
	})
	.meta({ id: "CursorMapEntry" });

export const MigratedRowSchema = z
	.object({
		row: MailboxEntrySchema.omit({
			title: true,
			summary: true,
			body: true,
			fullSpoken: true,
			files: true,
			payload: true,
		}),
		/** Text and filenames sealed. */
		text: ContentEnvelopeSchema.optional(),
	})
	.meta({ id: "MigratedRow" });

export const MigratedMailboxSchema = z
	.object({
		conversationId: z.string(),
		epoch: z.number().int(),
		rows: z.array(MigratedRowSchema),
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
