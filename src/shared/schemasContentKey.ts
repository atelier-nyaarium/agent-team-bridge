import { z } from "zod";
import { b64Field, SealedEnvelopeSchema, slugField } from "./crypto.js";

export const ContentKindSchema = z.enum([
	"board.title",
	"board.body",
	"board.name",
	"inbox.body",
	"op.payload",
	"op.result",
]);

export const ContentEnvelopeSchema = z
	.object({
		v: z.literal(1),
		epoch: z.number().int().min(1).max(2147483647),
		nonce: b64Field().refine(
			(value) => Buffer.from(value, "base64").length === 12,
			"nonce must decode to exactly 12 bytes",
		),
		ciphertext: b64Field().refine(
			(value) => Buffer.from(value, "base64").length >= 16,
			"ciphertext must decode to at least 16 bytes",
		),
	})
	.meta({ id: "ContentEnvelope" });

export const KeyEnvelopeSchema = z
	.object({
		epoch: z.number().int().min(1).max(2147483647),
		signerSignPub: b64Field(),
		sealed: SealedEnvelopeSchema,
	})
	.meta({ id: "KeyEnvelope" });

export const KeyRequestSchema = z
	.object({
		v: z.literal(1),
		domainId: slugField(),
		requesterSignPub: b64Field(),
		epochs: z.array(z.number().int().min(1).max(2147483647)).max(64),
		at: z.number().int().nonnegative(),
		nonce: b64Field(),
		signature: b64Field(),
	})
	.meta({ id: "KeyRequest" });

export const KeyGrantSchema = z
	.object({
		v: z.literal(1),
		recipientSignPub: b64Field(),
		envelope: KeyEnvelopeSchema,
		at: z.number().int().nonnegative(),
	})
	.meta({ id: "KeyGrant" });

export const KeyReceiptSchema = z
	.object({
		v: z.literal(1),
		domainId: slugField(),
		recipientSignPub: b64Field(),
		epoch: z.number().int().min(1).max(2147483647),
		at: z.number().int().nonnegative(),
		nonce: b64Field(),
		signature: b64Field(),
	})
	.meta({ id: "KeyReceipt" });

export const KeyRequestOpSchema = z
	.object({ kind: z.literal("key_request"), request: KeyRequestSchema })
	.meta({ id: "KeyRequestOp" });

export const KeyGrantOpSchema = z
	.object({ kind: z.literal("key_grant"), grant: KeyGrantSchema })
	.meta({ id: "KeyGrantOp" });

export const KeyReceiptOpSchema = z
	.object({ kind: z.literal("key_receipt"), receipt: KeyReceiptSchema })
	.meta({ id: "KeyReceiptOp" });

export const KeyReceiptsReadOpSchema = z
	.object({ kind: z.literal("key_receipts_read") })
	.meta({ id: "KeyReceiptsReadOp" });

export const KeyReceiptEntrySchema = z
	.object({
		recipientSignPub: b64Field(),
		epoch: z.number().int().min(1).max(2147483647),
		at: z.number().int().nonnegative(),
	})
	.meta({ id: "KeyReceiptEntry" });

export const KeyReceiptsReadResultSchema = z
	.object({ receipts: z.array(KeyReceiptEntrySchema) })
	.meta({ id: "KeyReceiptsReadResult" });

export const KeyRequestFrameSchema = z.object({ request: KeyRequestSchema }).meta({ id: "KeyRequestFrame" });
export const KeyReceiptFrameSchema = z.object({ receipt: KeyReceiptSchema }).meta({ id: "KeyReceiptFrame" });

export type ContentKind = z.infer<typeof ContentKindSchema>;
export type ContentEnvelope = z.infer<typeof ContentEnvelopeSchema>;
export type KeyEnvelope = z.infer<typeof KeyEnvelopeSchema>;
export type KeyRequest = z.infer<typeof KeyRequestSchema>;
export type KeyGrant = z.infer<typeof KeyGrantSchema>;
export type KeyReceipt = z.infer<typeof KeyReceiptSchema>;
export type KeyRequestOp = z.infer<typeof KeyRequestOpSchema>;
export type KeyGrantOp = z.infer<typeof KeyGrantOpSchema>;
export type KeyReceiptOp = z.infer<typeof KeyReceiptOpSchema>;
export type KeyReceiptsReadOp = z.infer<typeof KeyReceiptsReadOpSchema>;
export type KeyReceiptsReadResult = z.infer<typeof KeyReceiptsReadResultSchema>;
