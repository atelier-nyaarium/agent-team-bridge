import { z } from "zod";
import { ContentEnvelopeSchema } from "./schemasContentKey.js";

const state = z.enum(["open", "in_progress", "paused", "done", "cancelled"]);
const entryId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[^/\r\n]+$/);
const opId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[^/\r\n]+$/);
const session = z
	.object({ domainId: z.string(), gatewayId: z.string(), sessionId: z.string() })
	.meta({ id: "BoardSession" });
const attachment = z
	.object({ blobId: z.string(), size: z.number().int().nonnegative(), mime: z.string(), blobGateway: z.string() })
	.meta({ id: "BoardStateAttachment" });

export const BoardEntryClearSchema = z
	.object({
		id: entryId,
		state,
		parent: entryId.optional(),
		rank: z.string(),
		session: session.optional(),
		trashedAt: z.number().int().nonnegative().optional(),
		attachments: z.array(attachment).optional(),
		version: z.number().int().positive(),
	})
	.meta({ id: "BoardEntryClear" });
export const BoardEntrySealedSchema = z
	.object({
		title: ContentEnvelopeSchema,
		body: ContentEnvelopeSchema.optional(),
		names: z.record(z.string(), ContentEnvelopeSchema).optional(),
	})
	.meta({ id: "BoardEntrySealed" });
export const BoardStoredEntrySchema = z
	.object({ clear: BoardEntryClearSchema, sealed: BoardEntrySealedSchema })
	.meta({ id: "BoardStoredEntry" });
export const BoardActorSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("owner") }),
		z.object({ kind: z.literal("session"), session }),
	])
	.meta({ id: "BoardActor" });

const entryFields = z.object({
	id: entryId,
	state,
	parent: entryId.optional(),
	rank: z.string().optional(),
	session: session.optional(),
	trashedAt: z.number().int().nonnegative().optional(),
	attachments: z.array(attachment).optional(),
	title: ContentEnvelopeSchema.optional(),
	body: ContentEnvelopeSchema.optional(),
	names: z.record(z.string(), ContentEnvelopeSchema).optional(),
});
export const BoardOpSchema = z
	.discriminatedUnion("kind", [
		entryFields.extend({ kind: z.literal("upsert"), rank: z.string(), title: ContentEnvelopeSchema }),
		z.object({ kind: z.literal("remove"), id: entryId }),
		z.object({ kind: z.literal("set_state"), id: entryId, state }),
		z.object({ kind: z.literal("set_parent"), id: entryId, parent: entryId.optional(), rank: z.string() }),
		z.object({ kind: z.literal("set_rank"), id: entryId, rank: z.string() }),
		z.object({ kind: z.literal("set_attachments"), id: entryId, attachments: z.array(attachment) }),
		// Absent session means backlog.
		z.object({ kind: z.literal("set_session"), id: entryId, session: session.optional() }),
		z.object({ kind: z.literal("trash"), id: entryId }),
		z.object({ kind: z.literal("restore"), id: entryId }),
	])
	.meta({ id: "BoardOp" });
// The receiver identifies the writer from its channel.
export const BoardWriteSchema = z
	.object({ ops: z.array(BoardOpSchema), expectedRevision: z.number().int().nonnegative() })
	.meta({ id: "BoardWrite" });
export const BoardWriteResultSchema = z
	.object({
		outcome: z.enum(["applied", "conflict", "refused"]).meta({ id: "BoardWriteOutcome", catalog: "outcome" }),
		revision: z.number().int().nonnegative(),
		entries: z.array(BoardStoredEntrySchema),
		cascaded: z
			.array(
				z.object({ id: z.string(), from: state, to: state, reason: z.string() }).meta({ id: "BoardCascaded" }),
			)
			.default([]),
		refusal: z.string().optional(),
	})
	.meta({ id: "BoardWriteResult" });
export const BoardReadResultSchema = z
	.object({ revision: z.number().int().nonnegative(), entries: z.array(BoardStoredEntrySchema) })
	.meta({ id: "BoardReadResult" });
export const BoardObservationRowSchema = z
	.object({ identity: z.string(), pre: BoardStoredEntrySchema.nullable(), post: BoardStoredEntrySchema.nullable() })
	.meta({ id: "BoardObservationRow" });
export const BoardOpParamsSchema = z
	.object({
		incarnation: z.number().int().nonnegative(),
		sessionId: z.string(),
		opId: opId.optional(),
		write: BoardWriteSchema,
	})
	.meta({ id: "BoardOpParams" });

export type BoardEntryClear = z.infer<typeof BoardEntryClearSchema>;
export type BoardEntrySealed = z.infer<typeof BoardEntrySealedSchema>;
export type BoardStoredEntry = z.infer<typeof BoardStoredEntrySchema>;
export type BoardActorState = z.infer<typeof BoardActorSchema>;
export type BoardOp = z.infer<typeof BoardOpSchema>;
export type BoardWrite = z.infer<typeof BoardWriteSchema>;
export type BoardWriteResult = z.infer<typeof BoardWriteResultSchema>;
export type BoardReadResult = z.infer<typeof BoardReadResultSchema>;
